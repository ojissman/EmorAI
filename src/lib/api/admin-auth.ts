// ─── Administrator authentication & authorization (Phase 10, Priority 0) ──────
// Server-side session auth for every administrative surface of EmorAI.
//
// Design:
//   • Single administrator identity (AdminCredential, username "admin").
//     The password hash is bootstrapped from EMORAI_ADMIN_PASSWORD on first
//     login; afterwards the credential row is the source of truth.
//   • Sessions: random 256-bit tokens, stored SHA-256-hashed in AdminSession
//     (plaintext token exists ONLY in the HttpOnly cookie). Expiry 24h,
//     revocation on logout, server-side lastSeen tracking.
//   • Cookies: emor_admin_session (HttpOnly, SameSite=Strict) +
//     emor_admin_csrf (readable, for double-submit CSRF echo).
//   • CSRF: every mutating request must echo X-CSRF-Token == the session's
//     csrf token AND carry the matching csrf cookie.
//   • Customer emr_ API keys are NEVER administrator credentials — a request
//     presenting Authorization/x-api-key to an admin endpoint is rejected with
//     403 before session validation even runs.
//   • Handler-level enforcement via requireAdmin() — navigation-level gating
//     is a convenience, never the control.
//
// All admin API routes call requireAdmin(req) and return its error response.

import { randomBytes, createHash, scrypt as nodeScrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { db } from '@/lib/db';
import { rateLimit } from '@/lib/rate-limit';
import { fail } from '@/lib/api/response';

const scrypt = promisify(nodeScrypt) as (pw: string, salt: Buffer, len: number, opts: { N: number; r: number; p: number }) => Promise<Buffer>;

export const SESSION_COOKIE = 'emor_admin_session';
export const CSRF_COOKIE = 'emor_admin_csrf';
export const CSRF_HEADER = 'x-csrf-token';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const SCRYPT_N = 16384, SCRYPT_r = 8, SCRYPT_p = 1, SCRYPT_LEN = 64;

// ─── Password hashing (scrypt, constant-time verify) ─────────────────────────

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, SCRYPT_LEN, { N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p });
  return `scrypt:${SCRYPT_N}:${SCRYPT_r}:${SCRYPT_p}:${salt.toString('base64')}:${derived.toString('base64')}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const parts = stored.split(':');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const derived = await scrypt(password, salt, expected.length, { N: parseInt(nStr, 10), r: parseInt(rStr, 10), p: parseInt(pStr, 10) });
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/** Bootstraps the admin credential from EMORAI_ADMIN_PASSWORD on first use. */
async function ensureAdminCredential(): Promise<boolean> {
  const existing = await db.adminCredential.findFirst();
  if (existing) return true;
  const envPassword = process.env.EMORAI_ADMIN_PASSWORD;
  if (!envPassword || envPassword.length < 8) return false;
  await db.adminCredential.create({ data: { username: 'admin', passwordHash: await hashPassword(envPassword) } });
  return true;
}

// ─── Session management ───────────────────────────────────────────────────────

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export type AdminSessionInfo = {
  sessionId: string;
  csrfToken: string;
  expiresAt: Date;
};

/** Creates a session row + the token pair to install as cookies. */
async function createSession(ip: string | null, userAgent: string | null): Promise<{ token: string; csrfToken: string; session: AdminSessionInfo }> {
  // opportunistic cleanup of long-expired sessions
  void db.adminSession.deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - 7 * 24 * 3600 * 1000) } } }).catch(() => undefined);
  const token = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const row = await db.adminSession.create({
    data: { tokenHash: sha256(token), csrfToken, expiresAt, ip, userAgent },
  });
  return { token, csrfToken, session: { sessionId: row.id, csrfToken, expiresAt } };
}

function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.get('cookie') ?? '';
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    try {
      out[name] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      out[name] = part.slice(eq + 1).trim();
    }
  }
  return out;
}

/** Validates the session cookie against the DB (not revoked, not expired). */
export async function validateAdminSession(req: Request): Promise<AdminSessionInfo | null> {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const row = await db.adminSession.findUnique({ where: { tokenHash: sha256(token) } });
  if (!row) return null;
  if (row.revokedAt) return null;
  if (row.expiresAt.getTime() <= Date.now()) return null;
  // throttled lastSeen touch (≤1 write/minute per session)
  if (Date.now() - row.lastSeenAt.getTime() > 60_000) {
    void db.adminSession.update({ where: { id: row.id }, data: { lastSeenAt: new Date() } }).catch(() => undefined);
  }
  return { sessionId: row.id, csrfToken: row.csrfToken, expiresAt: row.expiresAt };
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * THE guard for administrative API handlers. Returns null when authorized;
 * otherwise returns the exact NextResponse the handler must return.
 *
 *  401 — no/invalid/expired/revoked session
 *  403 — customer API-key credential presented to an admin endpoint
 *  403 — missing/mismatched CSRF token on a mutating request
 */
export async function requireAdmin(req: Request): Promise<NextResponse | null> {
  // A customer API key must never authenticate administration, even by accident.
  const authz = req.headers.get('authorization');
  const xApiKey = req.headers.get('x-api-key');
  if ((authz && authz.toLowerCase().startsWith('bearer emr_')) || (xApiKey && xApiKey.trim().startsWith('emr_'))) {
    return fail(403, 'api_key_not_admin_credential', 'EmorAI API keys are customer credentials. They cannot administer the platform. Administrator access requires a dashboard session.');
  }

  const session = await validateAdminSession(req);
  if (!session) {
    return fail(401, 'admin_auth_required', 'Administrator session required. Log in through the dashboard.');
  }

  if (MUTATING.has(req.method)) {
    const headerToken = req.headers.get(CSRF_HEADER) ?? '';
    const cookieToken = parseCookies(req)[CSRF_COOKIE] ?? '';
    if (!headerToken || headerToken !== session.csrfToken || cookieToken !== session.csrfToken) {
      return fail(403, 'csrf_token_invalid', 'Missing or mismatched CSRF token. Echo the session CSRF token via the X-CSRF-Token header.');
    }
  }
  return null;
}

// ─── Login (rate-limited + lockout) ─────────────────────────────────────────

const LOGIN_RATE_LIMIT = 20;     // attempts per minute per IP (brute-force
                                 // defense is primarily the failure lockout
                                 // below; the rate limit just slows spray)
const LOCKOUT_THRESHOLD = 10;    // failures within window → lockout
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
const failureBuckets = new Map<string, number[]>(); // in-memory, per process

function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return 'local';
}

export type LoginResult =
  | { ok: true; token: string; csrfToken: string; expiresAt: Date }
  | { ok: false; status: number; code: string; message: string; retryAfterSec?: number };

export async function adminLogin(req: Request, password: string): Promise<LoginResult> {
  const ip = clientIp(req);

  // brute-force lockout (sustained failures)
  const now = Date.now();
  const failures = (failureBuckets.get(ip) ?? []).filter((t) => now - t < LOCKOUT_WINDOW_MS);
  if (failures.length >= LOCKOUT_THRESHOLD) {
    const retryAfterSec = Math.ceil((LOCKOUT_WINDOW_MS - (now - failures[0])) / 1000);
    return { ok: false, status: 429, code: 'login_locked_out', message: `Too many failed administrator logins from this address. Locked for ${retryAfterSec}s.`, retryAfterSec };
  }

  const rl = rateLimit(`admin-login:${ip}`, LOGIN_RATE_LIMIT, 60_000);
  if (!rl.ok) {
    return { ok: false, status: 429, code: 'login_rate_limited', message: 'Too many login attempts. Slow down.', retryAfterSec: rl.retryAfterSec };
  }

  if (typeof password !== 'string' || password.length === 0) {
    return { ok: false, status: 400, code: 'invalid_request', message: 'Password is required.' };
  }

  const provisioned = await ensureAdminCredential();
  if (!provisioned) {
    return { ok: false, status: 503, code: 'admin_not_provisioned', message: 'No administrator credential exists. Set EMORAI_ADMIN_PASSWORD in the environment and log in once to provision it.' };
  }

  const cred = await db.adminCredential.findFirst({ where: { username: 'admin' } });
  if (!cred) {
    return { ok: false, status: 503, code: 'admin_not_provisioned', message: 'No administrator credential exists. Set EMORAI_ADMIN_PASSWORD and log in once.' };
  }

  const valid = await verifyPassword(password, cred.passwordHash);
  if (!valid) {
    failures.push(now);
    failureBuckets.set(ip, failures);
    return { ok: false, status: 401, code: 'invalid_admin_password', message: 'Incorrect administrator password.' };
  }

  failureBuckets.delete(ip);
  const { token, csrfToken, session } = await createSession(ip, req.headers.get('user-agent'));
  return { ok: true, token, csrfToken, expiresAt: session.expiresAt };
}

export async function adminLogout(req: Request): Promise<void> {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token) {
    await db.adminSession.updateMany({ where: { tokenHash: sha256(token), revokedAt: null }, data: { revokedAt: new Date() } }).catch(() => undefined);
  }
}

/** Authenticated password change (requires the current password). */
export async function changeAdminPassword(currentPassword: string, newPassword: string): Promise<{ ok: boolean; status: number; code: string; message: string }> {
  const cred = await db.adminCredential.findFirst({ where: { username: 'admin' } });
  if (!cred) return { ok: false, status: 503, code: 'admin_not_provisioned', message: 'No administrator credential provisioned.' };
  if (typeof currentPassword !== 'string' || !(await verifyPassword(currentPassword, cred.passwordHash))) {
    return { ok: false, status: 401, code: 'invalid_admin_password', message: 'Current password is incorrect.' };
  }
  if (typeof newPassword !== 'string' || newPassword.length < 10) {
    return { ok: false, status: 400, code: 'weak_password', message: 'New password must be at least 10 characters.' };
  }
  await db.adminCredential.update({ where: { id: cred.id }, data: { passwordHash: await hashPassword(newPassword) } });
  // force re-login everywhere: revoke all sessions
  await db.adminSession.updateMany({ where: { revokedAt: null }, data: { revokedAt: new Date() } });
  return { ok: true, status: 200, code: 'password_changed', message: 'Administrator password changed. All sessions revoked — log in again.' };
}

// ─── Cookie installation helpers ────────────────────────────────────────────

function isSecureRequest(req: Request): boolean {
  const proto = req.headers.get('x-forwarded-proto');
  if (proto) return proto.split(',')[0].trim() === 'https';
  try {
    return new URL(req.url).protocol === 'https:';
  } catch {
    return false;
  }
}

import type { NextResponse } from 'next/server';

/** Builds the Set-Cookie pair for a fresh login response. */
export function sessionCookies(req: Request, token: string, csrfToken: string, expiresAt: Date): string[] {
  const secure = isSecureRequest(req);
  const sessionCookie = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Expires=${expiresAt.toUTCString()}`,
    'Max-Age=' + Math.floor(SESSION_TTL_MS / 1000),
    secure ? 'Secure' : '',
  ].filter(Boolean).join('; ');
  const csrfCookie = [
    `${CSRF_COOKIE}=${csrfToken}`,
    'Path=/',
    'SameSite=Strict',
    `Expires=${expiresAt.toUTCString()}`,
    'Max-Age=' + Math.floor(SESSION_TTL_MS / 1000),
    secure ? 'Secure' : '',
  ].filter(Boolean).join('; ');
  return [sessionCookie, csrfCookie];
}

/** Expired Set-Cookie pair for logout. */
export function clearedCookies(req: Request): string[] {
  const secure = isSecureRequest(req);
  return [SESSION_COOKIE, CSRF_COOKIE].map(
    (name) =>
      [
        `${name}=`,
        'Path=/',
        'HttpOnly',
        'SameSite=Strict',
        'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
        'Max-Age=0',
        secure ? 'Secure' : '',
      ]
        .filter(Boolean)
        .join('; ')
  );
}

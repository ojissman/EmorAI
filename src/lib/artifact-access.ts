// ─── Short-lived signed URLs for browser-native artifact GETs ────────────────
//
// Problem: <img src>, <video src>, <audio src>, <iframe src> and download
// links cannot attach the X-Admin-Session header (or cookies — the
// space-z.ai preview panel is a cross-site embed, so SameSite=Strict cookies
// are dropped). Yet artifacts must render in that context.
//
// Solution: an administrator-authenticated call to
// GET /api/artifacts/[id]/access issues a signed URL:
//
//     /api/artifacts/{id}/file?ast=<exp>.<sig>
//
//   ast token = base64url(expSeconds) + "." + base64url(HMAC-SHA256(secret,
//   "{artifactId}.{expSeconds}")), TTL 5 minutes, scoped to ONE artifact id.
// The artifact file/preview/zip GET routes accept the token as an
// alternative to an admin session.
//
// Security posture: these routes are read-only artifact bytes; the token is
// only obtainable through an authenticated admin request; it expires in
// minutes; it is bound to a single artifact id (constant-time verified).
// The signing secret is derived from EMORAI_MASTER_KEY so tokens survive
// server restarts.

import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { requireAdmin } from '@/lib/api/admin-auth';
import { fail } from '@/lib/api/response';

export const ARTIFACT_TOKEN_QUERY = 'ast';
const ARTIFACT_TOKEN_TTL_SEC = 5 * 60;

function signingSecret(): Buffer {
  // Derive a purpose-bound key from the master secret. Missing master key
  // (should not happen in this install) falls back to a process-bound key:
  // tokens then simply die on restart — availability, not security, degrades.
  const master = process.env.EMORAI_MASTER_KEY;
  if (master && master.length > 0) {
    return createHash('sha256').update('emorai-artifact-url-v1:').update(master).digest();
  }
  return createHash('sha256').update(`fallback-${process.pid}`).digest();
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sign(artifactId: string, expSec: number): string {
  const sig = createHmac('sha256', signingSecret()).update(`${artifactId}.${expSec}`).digest();
  return `${b64url(Buffer.from(String(expSec)))}.${b64url(sig)}`;
}

/** Issues a signed access token for one artifact id (5-minute TTL). */
export function issueArtifactToken(artifactId: string): { token: string; expiresAt: Date } {
  const expSec = Math.floor(Date.now() / 1000) + ARTIFACT_TOKEN_TTL_SEC;
  return { token: sign(artifactId, expSec), expiresAt: new Date(expSec * 1000) };
}

/** Constant-time validation of a signed artifact access token. */
export function verifyArtifactToken(artifactId: string, token: string): boolean {
  if (!token || token.length > 256) return false;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return false;
  const expPart = token.slice(0, dot);
  const sigPart = token.slice(dot + 1);

  let expSec: number;
  try {
    expSec = parseInt(Buffer.from(expPart.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'), 10);
    if (!Number.isFinite(expSec)) return false;
  } catch {
    return false;
  }
  if (expSec < Math.floor(Date.now() / 1000)) return false; // expired
  if (expSec > Math.floor(Date.now() / 1000) + ARTIFACT_TOKEN_TTL_SEC + 60) return false; // absurd future

  const expected = Buffer.from(sign(artifactId, expSec));
  const given = Buffer.from(sigPart.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Guard for artifact GET routes: admin session OR valid signed URL token. */
export async function requireArtifactAccess(req: Request, artifactId: string): Promise<Response | null> {
  const denied = await requireAdmin(req);
  if (!denied) return null;

  // Customer keys stay categorically rejected even on signed-URL routes.
  const authz = req.headers.get('authorization')?.toLowerCase() ?? '';
  const xApiKey = req.headers.get('x-api-key')?.trim() ?? '';
  if (authz.startsWith('bearer emr_') || xApiKey.startsWith('emr_')) return denied;

  const ast = new URL(req.url).searchParams.get(ARTIFACT_TOKEN_QUERY);
  if (ast && verifyArtifactToken(artifactId, ast)) return null;

  return fail(401, 'artifact_access_required', 'Administrator session or a signed artifact URL is required. Request a fresh URL via GET /api/artifacts/{id}/access.');
}

// Typed fetch helpers for the EmorAI dashboard API.

// ─── Admin session wiring (Phase 10) ───────────────────────────────────────────
/** Fired on window whenever any API call receives 401 admin_auth_required. */
export const ADMIN_SESSION_EXPIRED_EVENT = 'emor:admin-session-expired';
/** Readable CSRF cookie set by POST /api/admin/auth/login (double-submit echo). */
const CSRF_COOKIE = 'emor_admin_csrf';
/** Session-token header — the cookie-free channel for embedded previews. */
export const ADMIN_SESSION_HEADER = 'X-Admin-Session';
/** sessionStorage keys persisting the admin tokens across iframe reloads. */
const SESSION_TOKEN_STORE = 'emor_admin_session_token';
const CSRF_TOKEN_STORE = 'emor_admin_csrf_token';
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Module-level mirror of the admin session token (instant access). Login
// writes it; 401/logout clears it. sessionStorage persists across reloads.
let adminSessionToken: string | null = null;
let adminCsrfToken: string | null = null;

function readStoredToken(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null; // storage blocked — header channel simply inactive
  }
}

function writeStoredToken(key: string, value: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (value === null) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

function currentSessionToken(): string | null {
  return adminSessionToken ?? readStoredToken(SESSION_TOKEN_STORE);
}

/** Persists the login-issued session + CSRF tokens (memory + sessionStorage). */
export function saveAdminTokens(sessionToken: string, csrfToken?: string): void {
  adminSessionToken = sessionToken;
  adminCsrfToken = csrfToken ?? null;
  writeStoredToken(SESSION_TOKEN_STORE, sessionToken);
  if (csrfToken) writeStoredToken(CSRF_TOKEN_STORE, csrfToken);
}

/** Drops all stored admin tokens (logout / 401 expiry / password change). */
export function clearAdminTokens(): void {
  adminSessionToken = null;
  adminCsrfToken = null;
  writeStoredToken(SESSION_TOKEN_STORE, null);
  writeStoredToken(CSRF_TOKEN_STORE, null);
}

/** Reads the CSRF token: cookie first (canonical), stored fallback (iframes).
 *  Null when absent — the cookie path's 403 then surfaces as designed. */
function csrfTokenFromCookie(): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${CSRF_COOKIE}=`));
  if (match) {
    const raw = match.slice(CSRF_COOKIE.length + 1);
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return adminCsrfToken ?? readStoredToken(CSRF_TOKEN_STORE);
}

/**
 * Auth headers for ANY dashboard API call — including raw fetch() sites
 * (chat streaming, agent runs, voice mode). The X-Admin-Session token keeps
 * working where cross-site embeds block cookies; the CSRF echo covers the
 * ambient-cookie path for mutating requests.
 */
export function adminAuthHeaders(method: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  const sessionToken = currentSessionToken();
  if (sessionToken) headers[ADMIN_SESSION_HEADER] = sessionToken;
  if (method && MUTATING_METHODS.has(method.toUpperCase())) {
    const token = csrfTokenFromCookie();
    if (token) headers['X-CSRF-Token'] = token;
  }
  return headers;
}

/** X-CSRF-Token header for mutating requests when a CSRF cookie exists (absent → omitted). */
function csrfHeaders(method: string | undefined): Record<string, string> {
  return adminAuthHeaders(method);
}

/** Lets the admin gate react to session expiry discovered by ANY dashboard call. */
function notifyAdminSessionExpired(status: number, code: string): void {
  if (status !== 401 || code !== 'admin_auth_required') return;
  if (typeof window === 'undefined') return;
  clearAdminTokens();
  window.dispatchEvent(new CustomEvent(ADMIN_SESSION_EXPIRED_EVENT));
}

export class ApiError extends Error {
  status: number;
  code: string;
  /** Machine-readable extras from the server error body (e.g. retryAfterSec on login lockout). */
  details?: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function parseError(res: Response): Promise<ApiError> {
  let message = `Request failed with status ${res.status}`;
  let code = 'http_error';
  let details: Record<string, unknown> | undefined;
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } & Record<string, unknown> };
    if (body?.error?.message) message = body.error.message;
    if (body?.error?.code) code = body.error.code;
    // carry any non-code/message extras (e.g. retryAfterSec) onto the error
    const extras = { ...(body?.error as Record<string, unknown> | undefined) };
    delete extras.code;
    delete extras.message;
    if (Object.keys(extras).length > 0) details = extras;
  } catch {
    // non-JSON error
  }
  notifyAdminSessionExpired(res.status, code);
  return new ApiError(res.status, code, message, details);
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...csrfHeaders(init?.method),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as T;
}

export const api = {
  get: <T>(url: string) => request<T>(url),
  post: <T>(url: string, body?: unknown) =>
    request<T>(url, { method: 'POST', body: body === undefined ? '{}' : JSON.stringify(body) }),
  put: <T>(url: string, body?: unknown) => request<T>(url, { method: 'PUT', body: JSON.stringify(body) }),
  patch: <T>(url: string, body?: unknown) => request<T>(url, { method: 'PATCH', body: JSON.stringify(body) }),
  del: <T>(url: string) => request<T>(url, { method: 'DELETE' }),
  upload: async <T>(url: string, formData: FormData): Promise<T> => {
    const res = await fetch(url, { method: 'POST', body: formData, headers: csrfHeaders('POST') });
    if (!res.ok) throw await parseError(res);
    return (await res.json()) as T;
  },
};

// ─── Artifacts & Studio ──────────────────────────────────────────────────────

export const artifactUrls = {
  file: (id: string) => `/api/artifacts/${id}/file`,
  preview: (id: string, subpath?: string) =>
    subpath ? `/api/artifacts/${id}/preview/${subpath}` : `/api/artifacts/${id}/preview`,
  zip: (id: string) => `/api/artifacts/${id}/zip`,
};

export type ArtifactListResponse = { artifacts: SerializedArtifactSummary[] };

export type SerializedArtifactSummary = {
  id: string;
  kind: string;
  title: string;
  status: string;
  mime: string | null;
  size: number | null;
  createdAt: string;
};

// ─── Voice ───────────────────────────────────────────────────────────────────

export async function transcribeAudioClient(base64: string): Promise<string> {
  const res = await fetch('/api/voice/transcribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...csrfHeaders('POST') },
    body: JSON.stringify({ audio: base64 }),
  });
  if (!res.ok) throw await parseError(res);
  const data = (await res.json()) as { text: string };
  return data.text;
}

export async function fetchSpeech(text: string, voice?: string, speed?: number): Promise<Blob> {
  const res = await fetch('/api/voice/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...csrfHeaders('POST') },
    body: JSON.stringify({ text, voice, speed }),
  });
  if (!res.ok) throw await parseError(res);
  return await res.blob();
}

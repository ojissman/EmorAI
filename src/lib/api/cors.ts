// CORS helpers for the EmorAI gateway (/api/v1/* and /v1/*).
//
// External coding agents (ZCode, Claude Code, OpenClaw…) are server- or
// desktop-based, but browser-based tools also talk to OpenAI/Anthropic-style
// APIs directly with an explicit API key. Since gateway auth is a Bearer /
// x-api-key token (not ambient cookie credentials), CSRF does not apply and
// permissive CORS is safe — exactly how OpenAI and Anthropic themselves serve.

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, x-api-key, anthropic-version, anthropic-beta, x-request-id, OpenAI-Beta, OpenAI-Organization',
  'Access-Control-Expose-Headers': 'request-id, retry-after, x-emorai-served-model',
  'Access-Control-Max-Age': '86400',
} as const;

/** Standard JSON response with CORS headers applied. */
export function corsJson(data: unknown, init?: ResponseInit & { headers?: Record<string, string> }): Response {
  const headers = new Headers(init?.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(JSON.stringify(data), { ...init, headers });
}

/** Preflight handler shared by every gateway route. */
export function corsPreflight(): Response {
  return new Response(null, { status: 204, headers: { ...CORS_HEADERS } });
}

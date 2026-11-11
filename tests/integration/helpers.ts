// Integration test helpers — EmorAI Phase 10 acceptance suite.
// Runs against the LIVE dev server on :3000 with real admin sessions and
// local mock upstream providers (allowlisted loopback endpoints).

import { PrismaClient } from '@prisma/client';

export const BASE = process.env.EMORAI_TEST_BASE ?? 'http://localhost:3000';
export const ADMIN_PASSWORD = process.env.EMORAI_ADMIN_PASSWORD ?? '';
export const db = new PrismaClient();

export type AdminSession = { cookie: string; csrfToken: string };

let cachedSession: AdminSession | null = null;

/** Logs in the administrator (cached per process; re-login on 429 backoff). */
export async function adminLogin(): Promise<AdminSession> {
  if (cachedSession) return cachedSession;
  // login is rate-limited per IP — back off politely on 429
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${BASE}/api/admin/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: ADMIN_PASSWORD }),
    });
    if (res.status === 429 && attempt < 5) {
      await new Promise((r) => setTimeout(r, 15_000));
      continue;
    }
    if (res.status !== 200) throw new Error(`admin login failed: ${res.status}`);
    const setCookies = res.headers.getSetCookie?.() ?? [];
    const sessionCookie = setCookies.find((c) => c.startsWith('emor_admin_session=')) ?? '';
    const csrfCookie = setCookies.find((c) => c.startsWith('emor_admin_csrf=')) ?? '';
    const body = (await res.json()) as { csrfToken: string };
    const pair = (c: string) => c.split(';')[0];
    cachedSession = {
      cookie: `${pair(sessionCookie)}; ${pair(csrfCookie)}`,
      csrfToken: body.csrfToken,
    };
    return cachedSession;
  }
}

/** Forces a fresh session (login-state tests). */
export async function freshAdminLogin(): Promise<AdminSession> {
  cachedSession = null;
  return adminLogin();
}

/** Authenticated admin GET. */
export async function adminGet(s: AdminSession, path: string): Promise<Response> {
  return fetch(`${BASE}${path}`, { headers: { cookie: s.cookie } });
}

/** Authenticated admin mutation (CSRF header attached). */
export async function adminMutate(
  s: AdminSession,
  path: string,
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  body?: unknown
): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      cookie: s.cookie,
      'X-CSRF-Token': s.csrfToken,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** Customer gateway call with an EmorAI key (Bearer or x-api-key). */
export async function gatewayCall(
  path: string,
  key: string,
  body: unknown,
  header: 'bearer' | 'x-api-key' = 'bearer'
): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(header === 'bearer' ? { Authorization: `Bearer ${key}` } : { 'x-api-key': key }),
    },
    body: JSON.stringify(body),
  });
}

// ─── Mock upstream: OpenAI-compatible (port 3999) ────────────────────────────

export const VALID_OPENAI_KEY = 'sk-valid-mock-test-key-123456';
export const BAD_OPENAI_KEY = 'sk-invalid-mock-key-000000000';

/** Starts the OpenAI-compatible mock upstream on 127.0.0.1:3999. */
export function startOpenAIMock(): { stop: () => void } {
  const server = Bun.serve({
    port: 3999,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      // redirect attack: /evil/models → 302 to the cloud metadata endpoint
      if (url.pathname === '/evil/models') {
        return new Response(null, {
          status: 302,
          headers: { Location: 'http://169.254.169.254/latest/meta-data/' },
        });
      }
      if (url.pathname === '/v1/models' || url.pathname === '/fail/models') {
        if (req.headers.get('authorization') !== `Bearer ${VALID_OPENAI_KEY}`) {
          return Response.json({ error: { message: 'Incorrect API key provided' } }, { status: 401 });
        }
        return Response.json({
          object: 'list',
          data: [
            { id: 'mock-model-a', object: 'model', owned_by: 'mock', context_length: 8192 },
            { id: 'mock-model-b', object: 'model', owned_by: 'mock', context_length: 4096 },
          ],
        });
      }
      if (url.pathname === '/v1/chat/completions') {
        if (req.headers.get('authorization') !== `Bearer ${VALID_OPENAI_KEY}`) {
          return Response.json({ error: { message: 'Incorrect API key provided', type: 'invalid_request_error' } }, { status: 401 });
        }
        const body = (await req.json().catch(() => ({}))) as { stream?: boolean; model?: string };
        const model = body.model ?? 'unknown';
        if (body.stream) {
          const chunks = [
            `data: ${JSON.stringify({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`,
            `data: ${JSON.stringify({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { content: 'MOCK-PROVIDER-REPLY' }, finish_reason: null }] })}\n\n`,
            `data: ${JSON.stringify({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
            `data: ${JSON.stringify({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: null }], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } })}\n\n`,
            'data: [DONE]\n\n',
          ].join('');
          return new Response(chunks, { headers: { 'Content-Type': 'text/event-stream' } });
        }
        return Response.json({
          id: 'chatcmpl-mock',
          object: 'chat.completion',
          model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'MOCK-PROVIDER-REPLY' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
        });
      }
      if (url.pathname === '/fail/chat/completions') {
        if (req.headers.get('authorization') !== `Bearer ${VALID_OPENAI_KEY}`) {
          return Response.json({ error: { message: 'Incorrect API key provided' } }, { status: 401 });
        }
        return Response.json({ error: { message: 'mock upstream failure' } }, { status: 500 });
      }
      return new Response('not found', { status: 404 });
    },
  });
  return { stop: () => server.stop(true) };
}

// ─── Mock upstream: Anthropic-compatible (port 3998) ─────────────────────────

/** Starts the Anthropic-compatible mock upstream on 127.0.0.1:3998. */
export function startAnthropicMock(): { stop: () => void } {
  const server = Bun.serve({
    port: 3998,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/v1/models') {
        if (req.headers.get('x-api-key') !== VALID_OPENAI_KEY) {
          return Response.json({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, { status: 401 });
        }
        return Response.json({
          data: [{ id: 'mock-anth-model-a', type: 'model', display_name: 'Mock Anthropic A' }],
          has_more: false,
        });
      }
      if (url.pathname === '/v1/messages') {
        if (req.headers.get('x-api-key') !== VALID_OPENAI_KEY) {
          return Response.json({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, { status: 401 });
        }
        const body = (await req.json().catch(() => ({}))) as { stream?: boolean; model?: string };
        const model = body.model ?? 'unknown';
        if (body.stream) {
          const events = [
            `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_mock', model, role: 'assistant', usage: { input_tokens: 10, output_tokens: 1 } } })}\n\n`,
            `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'MOCK-ANTHROPIC-REPLY' } })}\n\n`,
            `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 6 } })}\n\n`,
            `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
          ].join('');
          return new Response(events, { headers: { 'Content-Type': 'text/event-stream' } });
        }
        return Response.json({
          id: 'msg_mock',
          type: 'message',
          role: 'assistant',
          model,
          content: [{ type: 'text', text: 'MOCK-ANTHROPIC-REPLY' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 6 },
        });
      }
      return new Response('not found', { status: 404 });
    },
  });
  return { stop: () => server.stop(true) };
}

// ─── Cleanup of test artifacts (never touches user data) ─────────────────────

const TEST_MODEL_PREFIX = 'mock-';

export async function cleanupTestArtifacts(): Promise<void> {
  const models = await db.modelConfig.findMany({ where: { modelId: { startsWith: TEST_MODEL_PREFIX } } });
  for (const m of models) {
    await db.modelRoute.deleteMany({ where: { publicModelId: m.modelId } });
    await db.costRate.deleteMany({ where: { modelId: m.modelId } });
    await db.costLedger.deleteMany({ where: { modelId: m.modelId } });
    await db.usageRecord.deleteMany({ where: { modelId: m.modelId } });
    await db.modelConfig.delete({ where: { id: m.id } });
  }
  const accounts = await db.providerAccount.findMany({ where: { name: { startsWith: 'Mock-Test ' } } });
  for (const a of accounts) {
    await db.modelRoute.deleteMany({ where: { providerAccountId: a.id } });
    await db.costLedger.deleteMany({ where: { providerAccountId: a.id } });
    await db.providerAccount.delete({ where: { id: a.id } });
  }
  const keys = await db.apiKey.findMany({ where: { name: { startsWith: 'Mock-Test ' } } });
  for (const k of keys) {
    await db.usageRecord.deleteMany({ where: { apiKeyId: k.id } });
    await db.costLedger.deleteMany({ where: { apiKeyId: k.id } });
    await db.apiKey.delete({ where: { id: k.id } });
  }
}

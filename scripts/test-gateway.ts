/**
 * EmorAI Universal API Gateway — end-to-end integration test.
 *
 * Verifies with REAL provider connections:
 *   1.  key auth (valid / invalid / revoked)
 *   2.  GET /v1/models (canonical + root mounts)
 *   3.  POST /v1/chat/completions (non-streaming)
 *   4.  POST /v1/chat/completions (SSE streaming)
 *   5.  POST /v1/chat/completions with tools (function calling round-trip)
 *   6.  POST /v1/messages (Anthropic, non-streaming)
 *   7.  POST /v1/messages (Anthropic, streaming SSE events)
 *   8.  POST /v1/messages with tools (tool_use blocks)
 *   9.  Anthropic system + multi-turn + tool_result round-trip
 *   10. Coding-agent liberal payloads: leaked roles (system/tool/function),
 *       OpenAI-style tool_calls in Anthropic format, mid-conversation system
 *       (regression: ZCode sent role "system" at messages[1] and was rejected)
 *   11. POST /v1/messages/count_tokens
 *   12. unknown model → 404 with model list
 *   13. scope enforcement (key without "tools")
 *   14. model allowlist enforcement
 *
 * Run: bun run scripts/test-gateway.ts
 * (Spaced to respect upstream rate limits — takes a few minutes.)
 */
import { createHash, randomBytes } from 'crypto';

const BASE = process.env.GATEWAY_BASE ?? 'http://localhost:3000';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;

function ok(name: string, detail?: string) {
  passed++;
  console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`);
}
function bad(name: string, detail: string) {
  failed++;
  console.log(`  ❌ ${name} — ${detail}`);
}
function section(name: string) {
  console.log(`\n━━ ${name} ━━`);
}

function hashKey(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

// direct DB access for setup/teardown
import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();

type KeyBundle = { id: string; plaintext: string; name: string };

async function createKey(name: string, data: Record<string, unknown> = {}): Promise<KeyBundle> {
  const body = randomBytes(24).toString('hex');
  const plaintext = `emr_${body}`;
  const row = await db.apiKey.create({
    data: {
      name,
      keyHash: hashKey(plaintext),
      prefix: `emr_${body.slice(0, 6)}…`,
      ...data,
    },
  });
  return { id: row.id, plaintext, name };
}

async function json(
  method: string,
  path: string,
  key: string | null,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed, headers: res.headers };
}

async function sse(
  path: string,
  key: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; events: string[]; raw: string }> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  const events: string[] = [];
  for (const block of raw.split('\n\n')) {
    const evLine = block.split('\n').find((l) => l.startsWith('event: '));
    const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
    if (evLine || dataLine) {
      events.push(`${evLine?.slice(7) ?? ''}|${dataLine?.slice(6) ?? ''}`);
    }
  }
  return { status: res.status, events, raw };
}

async function main() {
  console.log(`EmorAI gateway E2E test against ${BASE}`);
  const full: KeyBundle = await createKey('e2e-full');
  const noTools: KeyBundle = await createKey('e2e-no-tools', {
    scopes: ['chat', 'models', 'usage'],
  });
  const restricted: KeyBundle = await createKey('e2e-restricted', {
    allowedModels: ['glm-4.5-flash'],
  });
  const revoked: KeyBundle = await createKey('e2e-revoked', { revokedAt: new Date() });

  try {
    // ─── 1. Authentication ────────────────────────────────────────────────
    section('Authentication');
    {
      const r = await json('GET', '/api/v1/models', null);
      r.status === 401 && r.body?.error?.code === 'missing_api_key'
        ? ok('missing key → 401 missing_api_key')
        : bad('missing key', JSON.stringify(r.body).slice(0, 120));

      const r2 = await json('GET', '/api/v1/models', 'emr_deadbeef');
      r2.status === 401 && r2.body?.error?.code === 'invalid_api_key'
        ? ok('malformed key → 401 invalid_api_key')
        : bad('malformed key', JSON.stringify(r2.body).slice(0, 120));

      const r3 = await json('GET', '/api/v1/models', revoked.plaintext);
      r3.status === 401 && r3.body?.error?.code === 'key_revoked'
        ? ok('revoked key → 401 key_revoked')
        : bad('revoked key', JSON.stringify(r3.body).slice(0, 120));

      const r4 = await json('GET', '/api/v1/models', full.plaintext);
      r4.status === 200 && Array.isArray(r4.body?.data) && r4.body.data.length >= 5
        ? ok('valid key lists models', `${r4.body.data.length} models`)
        : bad('valid key', JSON.stringify(r4.body).slice(0, 120));
    }

    // ─── 2. Model listing (both mounts) ───────────────────────────────────
    section('Model registry: GET /v1/models');
    {
      const canonical = await json('GET', '/api/v1/models', full.plaintext);
      const root = await json('GET', '/v1/models', full.plaintext);
      const openaiShape =
        canonical.body?.object === 'list' &&
        canonical.body?.data?.[0]?.id &&
        canonical.body?.data?.[0]?.object === 'model' &&
        canonical.body?.data?.[0]?.owned_by;
      openaiShape
        ? ok('OpenAI list format with metadata', `first: ${canonical.body.data[0].id}`)
        : bad('openai shape', JSON.stringify(canonical.body).slice(0, 200));
      root.status === 200 && root.body?.object === 'list'
        ? ok('root mount /v1/models works')
        : bad('root mount', `status ${root.status}`);

      const xapikey = await fetch(`${BASE}/api/v1/models`, { headers: { 'x-api-key': full.plaintext } });
      xapikey.status === 200
        ? ok('x-api-key auth (Anthropic style) accepted')
        : bad('x-api-key', `status ${xapikey.status}`);

      const one = await json('GET', '/api/v1/models/glm-5.3-flash', full.plaintext);
      one.status === 200 && one.body?.id === 'glm-5.3-flash'
        ? ok('model retrieve endpoint', `ctx=${one.body?.context_window}`)
        : bad('model retrieve', JSON.stringify(one.body).slice(0, 120));
    }

    // ─── 3. OpenAI non-streaming ──────────────────────────────────────────
    section('OpenAI: POST /api/v1/chat/completions (non-streaming)');
    {
      await sleep(9000);
      const r = await json('POST', '/api/v1/chat/completions', full.plaintext, {
        model: 'glm-5.3-flash',
        messages: [
          { role: 'system', content: 'Reply with exactly the requested text and nothing else.' },
          { role: 'user', content: 'Reply with exactly: OPENAI NS OK' },
        ],
        max_tokens: 60,
        temperature: 0,
      });
      const content = r.body?.choices?.[0]?.message?.content ?? '';
      r.status === 200 &&
      r.body?.object === 'chat.completion' &&
      r.body?.usage?.total_tokens > 0 &&
      content.includes('OPENAI NS OK')
        ? ok('completion + usage + model echo', `served=${r.body?.model}, tokens=${r.body?.usage?.total_tokens}`)
        : bad('non-streaming', `status ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    }

    // ─── 4. OpenAI streaming ──────────────────────────────────────────────
    section('OpenAI: POST /api/v1/chat/completions (streaming)');
    {
      await sleep(9000);
      const r = await sse('/api/v1/chat/completions', full.plaintext, {
        model: 'glm-5.3-flash',
        messages: [{ role: 'user', content: 'Reply with exactly: OPENAI STREAM OK' }],
        stream: true,
        max_tokens: 60,
        temperature: 0,
      });
      const chunks = r.events.filter((e) => e.startsWith('|')).map((e) => {
        try { return JSON.parse(e.slice(1)); } catch { return null; }
      });
      const first = chunks.find(Boolean);
      const text = chunks.map((c) => c?.choices?.[0]?.delta?.content ?? '').join('');
      const hasRole = first?.choices?.[0]?.delta?.role === 'assistant';
      const sawDone = r.raw.includes('[DONE]');
      r.status === 200 && hasRole && sawDone && text.includes('OPENAI STREAM OK')
        ? ok('SSE chunks + role delta + [DONE]', `text="${text.slice(0, 40)}"`)
        : bad('streaming', `status ${r.status} role=${hasRole} done=${sawDone} text="${text.slice(0, 60)}"`);
    }

    // ─── 5. OpenAI tools ──────────────────────────────────────────────────
    section('OpenAI: tool calling');
    {
      await sleep(9000);
      const r = await json('POST', '/api/v1/chat/completions', full.plaintext, {
        model: 'glm-5.3-flash',
        messages: [{ role: 'user', content: 'What is the weather in Paris? You MUST call get_weather.' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_weather',
              description: 'Get weather for a city',
              parameters: {
                type: 'object',
                properties: { city: { type: 'string' } },
                required: ['city'],
              },
            },
          },
        ],
        tool_choice: 'auto',
        max_tokens: 200,
      });
      const toolCalls = r.body?.choices?.[0]?.message?.tool_calls;
      r.status === 200 &&
      toolCalls?.length > 0 &&
      toolCalls[0].function?.name === 'get_weather' &&
      JSON.parse(toolCalls[0].function.arguments).city.toLowerCase().includes('paris') &&
      r.body?.choices?.[0]?.finish_reason === 'tool_calls'
        ? ok('tool_calls + finish_reason', `args=${toolCalls[0].function.arguments}`)
        : bad('tools', JSON.stringify(r.body).slice(0, 250));

      // round-trip with tool response
      await sleep(9000);
      const r2 = await json('POST', '/api/v1/chat/completions', full.plaintext, {
        model: 'glm-5.3-flash',
        messages: [
          { role: 'user', content: 'What is the weather in Paris?' },
          {
            role: 'assistant',
            content: null,
            tool_calls: toolCalls,
          },
          { role: 'tool', tool_call_id: toolCalls[0].id, content: '{"temperature": 18, "condition": "cloudy"}' },
        ],
        max_tokens: 200,
      });
      const answer = r2.body?.choices?.[0]?.message?.content ?? '';
      r2.status === 200 && /18|cloud/i.test(answer)
        ? ok('tool round-trip (role:tool consumed)', answer.slice(0, 60))
        : bad('tool round-trip', `status ${r2.status} ${JSON.stringify(r2.body).slice(0, 200)}`);
    }

    // ─── 5b. Coding-agent compatibility: oversized tool descriptions ─────
    // ZCode/Claude Code ship tool descriptions far beyond the provider's
    // 2048-char limit (regression: gateway used to reject these itself).
    section('Coding-agent compatibility: oversized tool descriptions');
    {
      const longDesc = `This is a very detailed tool description that a coding agent would ship. It documents file-editing behavior, safety constraints, argument semantics and extensive examples far beyond what any per-field limit should reject. `.repeat(24); // > 8000 chars
      await sleep(9000);
      const r = await json('POST', '/api/v1/chat/completions', full.plaintext, {
        model: 'glm-5.3-flash',
        messages: [{ role: 'user', content: 'Read the file /tmp/app.ts. You MUST call read_file.' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'read_file',
              description: longDesc,
              parameters: {
                type: 'object',
                properties: {
                  path: { type: 'string', description: 'Absolute or workspace-relative path of the file to read. '.repeat(60) },
                },
                required: ['path'],
              },
            },
          },
        ],
        max_tokens: 200,
      });
      const toolCalls = r.body?.choices?.[0]?.message?.tool_calls;
      r.status === 200 &&
      toolCalls?.length > 0 &&
      toolCalls[0].function?.name === 'read_file' &&
      String(toolCalls[0].function.arguments).includes('/tmp/app.ts')
        ? ok('OpenAI: >2048-char tool description accepted + tool call works', `descLen=${longDesc.length}`)
        : bad('oversized tool description (OpenAI)', `status ${r.status} ${JSON.stringify(r.body).slice(0, 220)}`);

      // Anthropic format: oversized description AND an exotic tool name
      // (dots are not in the provider name pattern) — the tool_use response
      // must report the caller's ORIGINAL name, not the sanitized one.
      await sleep(9000);
      const r2 = await json('POST', '/api/v1/messages', full.plaintext, {
        model: 'glm-5.3-flash',
        max_tokens: 300,
        system: 'Always use tools when asked to read files.',
        messages: [{ role: 'user', content: 'Read the file /tmp/app.ts using your tool.' }],
        tools: [
          {
            name: 'read.file.v2',
            description: longDesc,
            input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
          },
        ],
      }, { 'x-api-key': full.plaintext });
      const toolUse = r2.body?.content?.find((b: any) => b.type === 'tool_use');
      r2.status === 200 &&
      toolUse &&
      toolUse.name === 'read.file.v2' &&
      String(toolUse.input?.path ?? '').includes('/tmp/app.ts') &&
      r2.body?.stop_reason === 'tool_use'
        ? ok('Anthropic: oversized description + exotic name round-trips to original name', `name=${toolUse.name}`)
        : bad('oversized tool description (Anthropic)', `status ${r2.status} ${JSON.stringify(r2.body).slice(0, 220)}`);
    }

    // ─── 6. Anthropic non-streaming ───────────────────────────────────────
    section('Anthropic: POST /api/v1/messages (non-streaming)');
    {
      await sleep(9000);
      const r = await json('POST', '/api/v1/messages', full.plaintext, {
        model: 'glm-5.3-flash',
        max_tokens: 60,
        system: 'Reply with exactly the requested text and nothing else.',
        messages: [{ role: 'user', content: 'Reply with exactly: ANTHROPIC NS OK' }],
      }, { 'x-api-key': full.plaintext, 'anthropic-version': '2023-06-01' });
      const text = r.body?.content?.find((b: any) => b.type === 'text')?.text ?? '';
      r.status === 200 &&
      r.body?.type === 'message' &&
      r.body?.role === 'assistant' &&
      r.body?.stop_reason === 'end_turn' &&
      r.body?.usage?.input_tokens > 0 &&
      text.includes('ANTHROPIC NS OK')
        ? ok('message shape + usage + stop_reason', `in=${r.body.usage.input_tokens} out=${r.body.usage.output_tokens}`)
        : bad('anthropic ns', `status ${r.status} ${JSON.stringify(r.body).slice(0, 250)}`);
    }

    // ─── 7. Anthropic streaming ───────────────────────────────────────────
    section('Anthropic: POST /api/v1/messages (streaming)');
    {
      await sleep(9000);
      const r = await sse('/api/v1/messages', full.plaintext, {
        model: 'glm-5.3-flash',
        max_tokens: 60,
        messages: [{ role: 'user', content: 'Reply with exactly: ANTHROPIC STREAM OK' }],
        stream: true,
      }, { 'x-api-key': full.plaintext });
      const names = r.events.map((e) => e.split('|')[0]).filter(Boolean);
      const has = (n: string) => names.includes(n);
      const textDeltas = r.events
        .filter((e) => e.startsWith('content_block_delta|'))
        .map((e) => {
          try { return JSON.parse(e.split('|')[1]).delta?.text ?? ''; } catch { return ''; }
        })
        .join('');
      const required = ['message_start', 'ping', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop'];
      const allEvents = required.every((n) => has(n));
      r.status === 200 && allEvents && textDeltas.includes('ANTHROPIC STREAM OK')
        ? ok('full Anthropic SSE event sequence', `events=[${names.join(',')}] text="${textDeltas.slice(0, 40)}"`)
        : bad('anthropic stream', `status ${r.status} events=[${names.join(',')}] text="${textDeltas.slice(0, 60)}"`);
    }

    // ─── 8. Anthropic tools ───────────────────────────────────────────────
    section('Anthropic: tool_use blocks');
    {
      await sleep(9000);
      const r = await json('POST', '/api/v1/messages', full.plaintext, {
        model: 'glm-5.3-flash',
        max_tokens: 300,
        system: 'Always use tools when asked about weather.',
        messages: [{ role: 'user', content: 'What is the weather in Paris? Use your weather tool.' }],
        tools: [
          {
            name: 'get_weather',
            description: 'Get weather for a city',
            input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
          },
        ],
      }, { 'x-api-key': full.plaintext });
      const toolUse = r.body?.content?.find((b: any) => b.type === 'tool_use');
      r.status === 200 &&
      toolUse &&
      toolUse.name === 'get_weather' &&
      String(toolUse.input?.city ?? '').toLowerCase().includes('paris') &&
      r.body?.stop_reason === 'tool_use'
        ? ok('tool_use block + stop_reason=tool_use', `input=${JSON.stringify(toolUse.input)}`)
        : bad('anthropic tools', JSON.stringify(r.body).slice(0, 300));

      // tool streaming: input_json_delta
      await sleep(9000);
      const r2 = await sse('/api/v1/messages', full.plaintext, {
        model: 'glm-5.3-flash',
        max_tokens: 300,
        messages: [{ role: 'user', content: 'Check weather in Tokyo with your tool.' }],
        tools: [
          {
            name: 'get_weather',
            description: 'Get weather for a city',
            input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
          },
        ],
        stream: true,
      }, { 'x-api-key': full.plaintext });
      const toolStart = r2.raw.includes('"type":"tool_use"');
      const jsonDelta = r2.raw.includes('"input_json_delta"');
      toolStart && jsonDelta
        ? ok('streaming tool_use: content_block_start(tool_use) + input_json_delta')
        : bad('streaming tools', `toolStart=${toolStart} jsonDelta=${jsonDelta}`);
    }

    // ─── 9. Anthropic multi-turn + tool_result round-trip ─────────────────
    section('Anthropic: system + multi-turn + tool_result round-trip');
    {
      await sleep(9000);
      const r = await json('POST', '/api/v1/messages', full.plaintext, {
        model: 'glm-5.3-flash',
        max_tokens: 300,
        system: 'You answer concisely using tool results.',
        messages: [
          { role: 'user', content: 'What is the weather in Paris?' },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Let me check.' },
              { type: 'tool_use', id: 'toolu_e2e_1', name: 'get_weather', input: { city: 'Paris' } },
            ],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'toolu_e2e_1', content: '18°C and cloudy' },
              { type: 'text', text: 'Please summarise.' },
            ],
          },
        ],
        tools: [
          {
            name: 'get_weather',
            description: 'Get weather for a city',
            input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
          },
        ],
      }, { 'x-api-key': full.plaintext });
      const text = (r.body?.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join(' ');
      r.status === 200 && /18|cloud/i.test(text)
        ? ok('tool_result consumed, assistant answered from tool output', text.slice(0, 70))
        : bad('tool_result round-trip', `status ${r.status} ${JSON.stringify(r.body).slice(0, 250)}`);
    }

    // ─── 9b. Coding-agent liberal payloads (ZCode regression) ───────────
    section('Coding-agent compatibility: liberal roles & leaked shapes');
    {
      // Regression: ZCode sent a system-role message inside the Anthropic
      // messages array (messages[1].role = "system") and the gateway rejected
      // it with `Invalid option: expected one of "user"|"assistant"`.
      // Now: accepted, hoisted into the system prompt, request succeeds.
      await sleep(9000);
      const r = await json('POST', '/api/v1/messages', full.plaintext, {
        model: 'glm-5.3-flash',
        max_tokens: 60,
        system: 'Reply with exactly the requested text and nothing else.',
        messages: [
          { role: 'user', content: 'Reply with exactly: ZCODE ROLE OK' },
          { role: 'system', content: 'Environment: linux, cwd: /tmp, shell: bash' },
        ],
      }, { 'x-api-key': full.plaintext });
      const text = r.body?.content?.find((b: any) => b.type === 'text')?.text ?? '';
      r.status === 200 && text.includes('ZCODE ROLE OK')
        ? ok('Anthropic: system-role message inside messages[] accepted (hoisted to system prompt)')
        : bad('leaked system role (anthropic)', `status ${r.status} ${JSON.stringify(r.body).slice(0, 220)}`);

      // Full ZCode-shaped streaming request: big top-level system + leaked
      // system-role message + tools with an oversized description.
      const longDesc = 'Reads a file from the filesystem with detailed behavior notes, edge cases and safety constraints for coding agents. '.repeat(40); // > 6000 chars
      await sleep(9000);
      const r2 = await sse('/api/v1/messages', full.plaintext, {
        model: 'glm-5.3-flash',
        max_tokens: 300,
        stream: true,
        system: 'You are a coding agent. Always use tools when asked to read files.',
        messages: [
          { role: 'user', content: 'Read the file /tmp/app.ts.' },
          { role: 'system', content: '<environment>cwd: /tmp, platform: linux</environment>' },
        ],
        tools: [
          {
            name: 'read_file',
            description: longDesc,
            input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
          },
        ],
      }, { 'x-api-key': full.plaintext });
      const toolUseStreamed = r2.raw.includes('"type":"tool_use"') && r2.raw.includes('"input_json_delta"');
      r2.status === 200 && toolUseStreamed
        ? ok('Anthropic: full ZCode shape (system leak + oversized tool) streams tool_use')
        : bad('zcode-shaped stream', `status ${r2.status} toolUse=${toolUseStreamed} raw=${r2.raw.slice(0, 160)}`);

      // OpenAI-style leak INSIDE Anthropic format: assistant message with
      // tool_calls + tool-role message with tool_call_id (mixed SDKs do this).
      await sleep(9000);
      const r3 = await json('POST', '/api/v1/messages', full.plaintext, {
        model: 'glm-5.3-flash',
        max_tokens: 300,
        messages: [
          { role: 'user', content: 'What is the weather in Paris?' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'call_leak_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } },
            ],
          },
          { role: 'tool', tool_call_id: 'call_leak_1', content: '18°C and cloudy' },
        ],
        tools: [
          {
            name: 'get_weather',
            description: 'Get weather for a city',
            input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
          },
        ],
      }, { 'x-api-key': full.plaintext });
      const text3 = (r3.body?.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join(' ');
      r3.status === 200 && /18|cloud/i.test(text3)
        ? ok('Anthropic: OpenAI-style tool_calls/tool-role leak round-trips')
        : bad('openai-shape leak (anthropic)', `status ${r3.status} ${JSON.stringify(r3.body).slice(0, 220)}`);

      // OpenAI path: mid-conversation system role must be hoisted, not rejected.
      await sleep(9000);
      const r4 = await json('POST', '/api/v1/chat/completions', full.plaintext, {
        model: 'glm-5.3-flash',
        max_tokens: 60,
        messages: [
          { role: 'user', content: 'Reply with exactly: OPENAI SYS HOIST OK' },
          { role: 'system', content: 'Reply with exactly what the user asked for.' },
        ],
      });
      const text4 = r4.body?.choices?.[0]?.message?.content ?? '';
      r4.status === 200 && text4.includes('OPENAI SYS HOIST OK')
        ? ok('OpenAI: mid-conversation system role hoisted to leading system message')
        : bad('system hoist (openai)', `status ${r4.status} ${JSON.stringify(r4.body).slice(0, 220)}`);

      // count_tokens accepts liberal roles too (no upstream call → no sleep).
      const rc = await json('POST', '/api/v1/messages/count_tokens', full.plaintext, {
        model: 'glm-5.3-flash',
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'system', content: 'env context' },
        ],
      }, { 'x-api-key': full.plaintext });
      rc.status === 200 && typeof rc.body?.input_tokens === 'number' && rc.body.input_tokens > 3
        ? ok('count_tokens accepts liberal roles', `input_tokens=${rc.body.input_tokens}`)
        : bad('count_tokens liberal roles', `status ${rc.status} ${JSON.stringify(rc.body).slice(0, 160)}`);
    }

    // ─── 10. count_tokens ─────────────────────────────────────────────────
    section('Anthropic: POST /api/v1/messages/count_tokens');
    {
      const r = await json('POST', '/api/v1/messages/count_tokens', full.plaintext, {
        model: 'glm-5.3-flash',
        messages: [{ role: 'user', content: 'Hello Claude Code, this is a token counting test.' }],
      }, { 'x-api-key': full.plaintext });
      r.status === 200 && typeof r.body?.input_tokens === 'number' && r.body.input_tokens > 3
        ? ok('count_tokens estimate', `input_tokens=${r.body.input_tokens}`)
        : bad('count_tokens', `status ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);

      const r2 = await json('POST', '/v1/messages/count_tokens', full.plaintext, {
        model: 'glm-5.3-flash',
        messages: [{ role: 'user', content: 'hi' }],
      }, { 'x-api-key': full.plaintext });
      r2.status === 200 ? ok('root mount count_tokens') : bad('root count_tokens', `status ${r2.status}`);
    }

    // ─── 11. Unknown model ────────────────────────────────────────────────
    section('Unknown model handling');
    {
      const r = await json('POST', '/api/v1/chat/completions', full.plaintext, {
        model: 'gpt-99-turbo-nonexistent',
        messages: [{ role: 'user', content: 'hi' }],
      });
      r.status === 404 && r.body?.error?.code === 'model_not_found' && String(r.body?.error?.message).includes('glm-')
        ? ok('unknown model → 404 with available list')
        : bad('unknown model (openai)', `status ${r.status} ${JSON.stringify(r.body).slice(0, 150)}`);

      const r2 = await json('POST', '/api/v1/messages', full.plaintext, {
        model: 'claude-99-nonexistent',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'hi' }],
      }, { 'x-api-key': full.plaintext });
      r2.status === 404 && r2.body?.type === 'error' && r2.body?.error?.type === 'not_found_error'
        ? ok('unknown model → Anthropic not_found_error envelope')
        : bad('unknown model (anthropic)', `status ${r2.status} ${JSON.stringify(r2.body).slice(0, 150)}`);
    }

    // ─── 12. Scope enforcement ─────────────────────────────────────────────
    section('Scope enforcement');
    {
      const r = await json('POST', '/api/v1/chat/completions', noTools.plaintext, {
        model: 'glm-5.3-flash',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [
          {
            type: 'function',
            function: { name: 'x', description: 'x', parameters: { type: 'object', properties: {} } },
          },
        ],
      });
      r.status === 403 && r.body?.error?.code === 'insufficient_scope'
        ? ok('key without tools scope → 403 insufficient_scope')
        : bad('scope enforcement', `status ${r.status} ${JSON.stringify(r.body).slice(0, 150)}`);
    }

    // ─── 13. Model allowlist ──────────────────────────────────────────────
    section('Model allowlist');
    {
      const r = await json('POST', '/api/v1/chat/completions', restricted.plaintext, {
        model: 'glm-5.3-flash',
        messages: [{ role: 'user', content: 'hi' }],
      });
      r.status === 403 && r.body?.error?.code === 'model_not_allowed'
        ? ok('model outside allowlist → 403 model_not_allowed')
        : bad('allowlist', `status ${r.status} ${JSON.stringify(r.body).slice(0, 150)}`);

      const r2 = await json('POST', '/api/v1/messages', restricted.plaintext, {
        model: 'glm-4.5-flash',
        max_tokens: 20,
        messages: [{ role: 'user', content: 'Reply OK' }],
      }, { 'x-api-key': restricted.plaintext });
      r2.status === 200 ? ok('allowlisted model works') : bad('allowlisted model', `status ${r2.status}`);
    }

    // ─── 14. Usage recording ──────────────────────────────────────────────
    section('Usage telemetry & request logs');
    {
      const r = await json('GET', '/api/v1/usage?days=1', full.plaintext);
      r.status === 200 && r.body?.totals?.requests > 0
        ? ok('usage report records gateway traffic', `${r.body.totals.requests} requests today`)
        : bad('usage report', `status ${r.status} ${JSON.stringify(r.body).slice(0, 150)}`);

      const records = await db.usageRecord.findMany({
        where: { apiKeyId: full.id, source: 'api' },
        orderBy: { createdAt: 'desc' },
        take: 40,
      });
      const protocols = new Set(records.map((rec) => rec.protocol));
      protocols.has('openai') && protocols.has('anthropic')
        ? ok('request logs distinguish protocols', [...protocols].join(' + '))
        : bad('protocol logging', [...protocols].join(',') || 'none');
    }
  } finally {
    // cleanup test keys
    for (const k of [full, noTools, restricted, revoked]) {
      await db.apiKey.delete({ where: { id: k.id } }).catch(() => undefined);
    }
    await db.$disconnect().catch(() => undefined);
  }

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main();

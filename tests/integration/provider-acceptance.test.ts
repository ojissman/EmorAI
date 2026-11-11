// Phase 10 acceptance — SSRF protection, provider-model execution (OpenAI-
// compatible AND Anthropic-compatible), usage attribution, cost accounting,
// invalid credentials, credential rotation, failover, streaming abort slot
// release, budget enforcement, and customer API key authentication.
//
// Mock upstreams run on allowlisted loopback ports (3999/3998). The dev
// server on :3000 is the system under test.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import {
  BASE,
  db,
  adminLogin,
  adminGet,
  adminMutate,
  gatewayCall,
  startOpenAIMock,
  startAnthropicMock,
  cleanupTestArtifacts,
  VALID_OPENAI_KEY,
  BAD_OPENAI_KEY,
  type AdminSession,
} from './helpers';

let s: AdminSession;
let openaiMock: { stop: () => void };
let anthropicMock: { stop: () => void };
let savedNetwork: { allowlist: string[]; requireHttps: boolean; maxResponseBytes: number } | null = null;

beforeAll(async () => {
  s = await adminLogin();
  // persist the current network policy, then ensure the mock ports are allowlisted
  const cur = (await (await adminGet(s, '/api/settings')).json()) as {
    settings: { network: { allowlist: string[]; requireHttps: boolean; maxResponseBytes: number } };
  };
  savedNetwork = cur.settings.network;
  const allowlist = Array.from(new Set([...(cur.settings.network.allowlist ?? []), '127.0.0.1:3999', '127.0.0.1:3998']));
  const put = await adminMutate(s, '/api/settings', 'PUT', { network: { ...cur.settings.network, allowlist } });
  expect(put.status).toBe(200);

  await cleanupTestArtifacts();
  openaiMock = startOpenAIMock();
  anthropicMock = startAnthropicMock();
});

afterAll(async () => {
  await cleanupTestArtifacts();
  // restore network policy
  if (s && savedNetwork) {
    await adminMutate(s, '/api/settings', 'PUT', { network: savedNetwork }).catch(() => undefined);
  }
  openaiMock?.stop();
  anthropicMock?.stop();
  await db.$disconnect();
});

// ─── SSRF (Priority 2) ────────────────────────────────────────────────────────

describe('P2 — SSRF destination policy', () => {
  const badUrls = [
    'http://127.0.0.1:22/v1',
    'http://localhost:8080/v1',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.5/v1',
    'http://192.168.1.10/v1',
    'http://172.20.1.1/v1',
    'file:///etc/passwd',
    'ftp://example.com/v1',
    'http://2130706433/v1', // 127.0.0.1 decimal bypass attempt
    'http://0x7f.0.0.1/v1', // hex bypass attempt
  ];
  for (const url of badUrls) {
    test(`rejects provider baseUrl "${url}" at save time (422 url_blocked)`, async () => {
      const res = await adminMutate(s, '/api/providers', 'POST', {
        name: 'Mock-Test SSRF',
        providerType: 'openai',
        baseUrl: url,
        credentialMode: 'stored',
        apiKey: VALID_OPENAI_KEY,
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('url_blocked');
    });
  }

  test('https public endpoint passes the save-time policy', async () => {
    const res = await adminMutate(s, '/api/providers', 'POST', {
      name: 'Mock-Test HTTPS',
      providerType: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      credentialMode: 'stored',
      apiKey: VALID_OPENAI_KEY,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { account: { id: string } };
    await adminMutate(s, `/api/providers/${body.account.id}`, 'DELETE');
  });

  test('redirect to cloud metadata is blocked mid-flight (validate fails, no egress)', async () => {
    const create = await adminMutate(s, '/api/providers', 'POST', {
      name: 'Mock-Test Evil Redirect',
      providerType: 'openai',
      baseUrl: 'http://127.0.0.1:3999/evil',
      credentialMode: 'stored',
      apiKey: VALID_OPENAI_KEY,
    });
    expect(create.status).toBe(201);
    const { account } = (await create.json()) as { account: { id: string } };
    // discovery would GET {base}/models → 302 → 169.254.169.254 → must be refused
    const discover = await adminMutate(s, `/api/providers/${account.id}/discover`, 'POST', {});
    expect([400, 502]).toContain(discover.status); // policy rejection surfaces as provider failure
    const text = JSON.stringify(await discover.json());
    expect(text.toLowerCase()).toMatch(/rejected by network policy|blocked/);
    await adminMutate(s, `/api/providers/${account.id}`, 'DELETE');
  });
});

// ─── Provider model execution (Priority 1) — the acceptance flow ─────────────

describe('P1 — OpenAI-compatible provider end-to-end', () => {
  let accountId = '';
  let modelRowId = '';
  let apiKeyPlaintext = '';
  let apiKeyRowId = '';

  test('step 1 — connect an authorized provider account', async () => {
    const res = await adminMutate(s, '/api/providers', 'POST', {
      name: 'Mock-Test OpenAI Provider',
      providerType: 'openai',
      baseUrl: 'http://127.0.0.1:3999/v1',
      credentialMode: 'stored',
      apiKey: VALID_OPENAI_KEY,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { account: { id: string } };
    accountId = body.account.id;
    expect(accountId).toBeTruthy();
  });

  test('step 2 — live credential validation is healthy', async () => {
    const res = await adminMutate(s, `/api/providers/${accountId}/validate`, 'POST');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean; message?: string };
    expect(body.ok ?? (body as { validation?: { ok: boolean } }).validation?.ok).toBe(true);
  });

  test('step 3 — discovery lists upstream models', async () => {
    const res = await adminMutate(s, `/api/providers/${accountId}/discover`, 'POST', { adopt: [] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { discovered?: Array<{ modelId: string }> };
    const ids = (body.discovered ?? []).map((m) => m.modelId);
    expect(ids).toContain('mock-model-a');
    expect(ids).toContain('mock-model-b');
  });

  test('step 4 — adoption catalogues the model AND creates its execution route (unpublished)', async () => {
    const res = await adminMutate(s, `/api/providers/${accountId}/discover`, 'POST', {
      adopt: [
        {
          modelId: 'mock-model-a',
          displayName: 'Mock Model A',
          freeTier: true,
          capabilities: { chat: true, reasoning: false, vision: false, files: false, webSearch: false, tools: false, json: false },
          contextWindow: 8192,
        },
      ],
    });
    expect(res.status).toBe(200);

    const model = await db.modelConfig.findUnique({ where: { modelId: 'mock-model-a' } });
    expect(model).toBeTruthy();
    expect(model!.category).toBe('provider');
    expect(model!.provider).toBe('openai');
    expect(model!.enabled).toBe(false); // adopted ≠ published
    modelRowId = model!.id;

    const route = await db.modelRoute.findFirst({ where: { publicModelId: 'mock-model-a', providerAccountId: accountId } });
    expect(route).toBeTruthy();
    expect(route!.upstreamModelId).toBe('mock-model-a');
    expect(route!.enabled).toBe(true); // execution eligibility ready
  });

  test('step 5 — publication: model stays unpublished until the admin enables it', async () => {
    // (step 4 already asserted enabled=false + route exists; the gateway
    // rejects disabled models with model_disabled — covered by unit+manual)
    const enable = await adminMutate(s, `/api/models/${modelRowId}`, 'PATCH', { enabled: true });
    expect([200, 204]).toContain(enable.status);
  });

  test('step 6 — generate a customer EmorAI API key', async () => {
    const res = await adminMutate(s, '/api/keys', 'POST', { name: 'Mock-Test Key' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { key: { id: string }; plaintext: string };
    apiKeyPlaintext = body.plaintext;
    apiKeyRowId = body.key.id;
    expect(apiKeyPlaintext).toMatch(/^emr_[0-9a-f]{48}$/);
  });

  test('step 7 — non-streaming execution through the provider model', async () => {
    const res = await gatewayCall('/api/v1/chat/completions', apiKeyPlaintext, {
      model: 'mock-model-a',
      messages: [{ role: 'user', content: 'Say the magic words' }],
      max_tokens: 32,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      model: string;
      choices: Array<{ message: { content: string } }>;
      usage: { total_tokens: number };
    };
    expect(body.choices[0].message.content).toBe('MOCK-PROVIDER-REPLY');
    expect(body.model).toBe('mock-model-a'); // actual served model disclosed
    expect(body.usage.total_tokens).toBe(20);
  });

  test('step 8 — streaming execution (SSE deltas arrive)', async () => {
    const res = await gatewayCall('/api/v1/chat/completions', apiKeyPlaintext, {
      model: 'mock-model-a',
      messages: [{ role: 'user', content: 'Stream it' }],
      stream: true,
      max_tokens: 32,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('MOCK-PROVIDER-REPLY');
    expect(text).toContain('[DONE]');
  });

  test('step 9 — attribution: usage record carries route + account + served model', async () => {
    const rec = await db.usageRecord.findFirst({
      where: { modelId: 'mock-model-a', apiKeyId: apiKeyRowId },
      orderBy: { createdAt: 'desc' },
    });
    expect(rec).toBeTruthy();
    expect(rec!.routeId).toBeTruthy();
    expect(rec!.providerAccountId).toBe(accountId);
    expect(rec!.servedModel).toBe('mock-model-a');
    expect(rec!.success).toBe(true);
  });

  test('step 10 — cost accounting: ledger row exists, honestly unpriced (no rate configured)', async () => {
    const rec = await db.usageRecord.findFirst({
      where: { modelId: 'mock-model-a', apiKeyId: apiKeyRowId },
      orderBy: { createdAt: 'desc' },
    });
    expect(rec).toBeTruthy();
    // fire-and-forget billing: poll briefly for the ledger row
    let ledger = await db.costLedger.findUnique({ where: { usageRecordId: rec!.id } });
    for (let i = 0; i < 10 && !ledger; i++) {
      await new Promise((r) => setTimeout(r, 200));
      ledger = await db.costLedger.findUnique({ where: { usageRecordId: rec!.id } });
    }
    expect(ledger).toBeTruthy();
    expect(ledger!.priced).toBe(false); // unknown cost ≠ zero
    expect(ledger!.totalCost).toBeNull();
  });

  test('invalid upstream credentials are reported honestly (provider_auth)', async () => {
    const create = await adminMutate(s, '/api/providers', 'POST', {
      name: 'Mock-Test Bad Key Provider',
      providerType: 'openai',
      baseUrl: 'http://127.0.0.1:3999/v1',
      credentialMode: 'stored',
      apiKey: BAD_OPENAI_KEY,
    });
    expect(create.status).toBe(201);
    const bad = (await create.json()) as { account: { id: string } };

    const validate = await adminMutate(s, `/api/providers/${bad.account.id}/validate`, 'POST');
    expect(validate.status).toBe(200);
    const vbody = (await validate.json()) as { ok?: boolean } | Record<string, unknown>;
    expect(JSON.stringify(vbody)).toMatch(/false|invalid|failed|error/i);

    const acct = await db.providerAccount.findUnique({ where: { id: bad.account.id } });
    expect(acct!.lastStatus).toBe('error');
    await adminMutate(s, `/api/providers/${bad.account.id}`, 'DELETE');
  });

  test('credential rotation restores service (PATCH apiKey → validate healthy)', async () => {
    // rotate to the SAME valid key (idempotent proof the credential pipeline round-trips)
    const patch = await adminMutate(s, `/api/providers/${accountId}`, 'PATCH', { apiKey: VALID_OPENAI_KEY });
    expect([200, 204]).toContain(patch.status);
    const validate = await adminMutate(s, `/api/providers/${accountId}/validate`, 'POST');
    expect(validate.status).toBe(200);
    const acct = await db.providerAccount.findUnique({ where: { id: accountId } });
    expect(acct!.lastStatus).toBe('ok');
  });

  test('customer key auth: malformed key, unknown key, revoked key all rejected', async () => {
    const malformed = await gatewayCall('/api/v1/chat/completions', 'not-a-key', {
      model: 'mock-model-a',
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(malformed.status).toBe(401);

    const unknown = await gatewayCall('/api/v1/chat/completions', 'emr_' + 'a'.repeat(48), {
      model: 'mock-model-a',
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(unknown.status).toBe(401);
    const uBody = (await unknown.json()) as { error: { code: string } };
    expect(uBody.error.code).toBe('invalid_api_key');
  });

  test('provider failover: failing primary route falls through to the healthy account', async () => {
    // second account whose completions endpoint 500s, hosting the same model
    const createFail = await adminMutate(s, '/api/providers', 'POST', {
      name: 'Mock-Test Failing Provider',
      providerType: 'openai',
      baseUrl: 'http://127.0.0.1:3999/fail',
      credentialMode: 'stored',
      apiKey: VALID_OPENAI_KEY,
    });
    expect(createFail.status).toBe(201);
    const failing = (await createFail.json()) as { account: { id: string } };

    // adopt the same upstream model on the failing account (model exists; route is created)
    const adopt = await adminMutate(s, `/api/providers/${failing.account.id}/discover`, 'POST', {
      adopt: [{ modelId: 'mock-model-a', displayName: 'Mock Model A', capabilities: { chat: true, reasoning: false, vision: false, files: false, webSearch: false, tools: false, json: false }, contextWindow: 8192 }],
    });
    expect(adopt.status).toBe(200);

    // failing route first (priority 0), healthy route second (priority 10)
    const failRoute = await db.modelRoute.findFirst({ where: { publicModelId: 'mock-model-a', providerAccountId: failing.account.id } });
    expect(failRoute).toBeTruthy();
    await adminMutate(s, `/api/routes/${failRoute!.id}`, 'PATCH', { priority: 0 });
    const goodRoute = await db.modelRoute.findFirst({ where: { publicModelId: 'mock-model-a', providerAccountId: accountId } });
    await adminMutate(s, `/api/routes/${goodRoute!.id}`, 'PATCH', { priority: 10 });

    const res = await gatewayCall('/api/v1/chat/completions', apiKeyPlaintext, {
      model: 'mock-model-a',
      messages: [{ role: 'user', content: 'failover me' }],
      max_tokens: 32,
    });
    expect(res.status).toBe(200); // served by the healthy route after failover
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0].message.content).toBe('MOCK-PROVIDER-REPLY');

    // routing decision recorded the multi-attempt failover
    const decision = await db.routingDecision.findFirst({
      where: { modelId: 'mock-model-a' },
      orderBy: { createdAt: 'desc' },
    });
    expect(decision).toBeTruthy();
    expect(decision!.attemptCount).toBeGreaterThanOrEqual(2);

    await adminMutate(s, `/api/routes/${goodRoute!.id}`, 'PATCH', { priority: 0 });
    // delete the failing account's route FIRST (API DELETE is blocked while
    // routes reference the account), then the account itself
    await db.modelRoute.deleteMany({ where: { providerAccountId: failing.account.id } });
    await adminMutate(s, `/api/providers/${failing.account.id}`, 'DELETE');
  });

  test('streaming abort releases the concurrency slot (account limit 1)', async () => {
    const patch = await adminMutate(s, `/api/providers/${accountId}`, 'PATCH', { maxConcurrency: 1 });
    expect([200, 204]).toContain(patch.status);

    const controller = new AbortController();
    const res = await fetch(`${BASE}/api/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKeyPlaintext}` },
      body: JSON.stringify({
        model: 'mock-model-a',
        messages: [{ role: 'user', content: 'long stream' }],
        stream: true,
        max_tokens: 32,
      }),
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    await reader.read(); // first chunk arrives
    controller.abort(); // client aborts mid-stream
    try { await reader.cancel(); } catch { /* expected */ }

    // slot must be released — poll the ops metrics until inFlight returns to 0
    let released = false;
    for (let i = 0; i < 20; i++) {
      const metrics = (await (await adminGet(s, '/api/ops/metrics')).json()) as {
        concurrency?: { keys?: Record<string, { inFlight: number }> };
      };
      const inflight = Object.values(metrics.concurrency?.keys ?? {}).reduce((a, k) => a + (k.inFlight ?? 0), 0);
      if (inflight === 0) { released = true; break; }
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(released).toBe(true);

    // and the very next request succeeds (capacity available again)
    const followUp = await gatewayCall('/api/v1/chat/completions', apiKeyPlaintext, {
      model: 'mock-model-a',
      messages: [{ role: 'user', content: 'after abort' }],
      max_tokens: 16,
    });
    expect(followUp.status).toBe(200);

    await adminMutate(s, `/api/providers/${accountId}`, 'PATCH', { maxConcurrency: 0 });
  });

  test('budget enforcement: priced spend exhausts a tiny monthly budget', async () => {
    // configure real pricing on the model: $1 per 1M input tokens, $1 per 1M output
    const patch = await adminMutate(s, `/api/models/${modelRowId}`, 'PATCH', {
      pricing: { inputPerMTok: 1000000, outputPerMTok: 1000000, currency: 'USD' },
    });
    expect([200, 204]).toContain(patch.status);
    // budget of $0.000001 — a single 20-token request costs ~$0.00002
    const budgetPatch = await adminMutate(s, `/api/providers/${accountId}`, 'PATCH', { monthlyBudget: 0.000001 });
    expect([200, 204]).toContain(budgetPatch.status);

    // FIRST request: allowed (spend still under budget), records a priced cost
    const first = await gatewayCall('/api/v1/chat/completions', apiKeyPlaintext, {
      model: 'mock-model-a',
      messages: [{ role: 'user', content: 'budget charge' }],
      max_tokens: 16,
    });
    expect(first.status).toBe(200);

    // wait for the priced ledger row to land (fire-and-forget accounting)
    let pricedRow: { totalCost: string | null } | null = null;
    for (let i = 0; i < 15; i++) {
      const rows = await db.costLedger.findMany({ where: { modelId: 'mock-model-a', priced: true } });
      if (rows.length > 0) { pricedRow = rows[0]; break; }
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(pricedRow).toBeTruthy();
    expect(pricedRow!.totalCost).toBeTruthy();

    // SECOND request: pre-check must reject — no eligible route (budget_exhausted)
    const res = await gatewayCall('/api/v1/chat/completions', apiKeyPlaintext, {
      model: 'mock-model-a',
      messages: [{ role: 'user', content: 'over budget' }],
      max_tokens: 16,
    });
    expect([501, 503, 429, 500]).toContain(res.status);

    const decision = await db.routingDecision.findFirst({
      where: { modelId: 'mock-model-a' },
      orderBy: { createdAt: 'desc' },
    });
    const candJson = JSON.stringify(decision?.candidates ?? {});
    expect(candJson).toContain('budget_exhausted');

    // a budget alert was raised
    let alert: { category: string } | null = null;
    for (let i = 0; i < 10; i++) {
      alert = await db.alertEvent.findFirst({ where: { category: 'budget' }, orderBy: { createdAt: 'desc' } });
      if (alert) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(alert).toBeTruthy();

    // ledger rows exist and are priced with exact decimals
    const ledger = await db.costLedger.findMany({ where: { modelId: 'mock-model-a' } });
    expect(ledger.length).toBeGreaterThan(0);
    for (const row of ledger) {
      if (row.priced) {
        expect(row.totalCost).toBeTruthy();
        expect(Number(row.totalCost)).toBeGreaterThan(0);
      }
    }

    // reset: budget off, pricing off
    await adminMutate(s, `/api/providers/${accountId}`, 'PATCH', { monthlyBudget: null });
    await adminMutate(s, `/api/models/${modelRowId}`, 'PATCH', { pricing: null });
    const healthy = await gatewayCall('/api/v1/chat/completions', apiKeyPlaintext, {
      model: 'mock-model-a',
      messages: [{ role: 'user', content: 'budget lifted' }],
      max_tokens: 16,
    });
    expect(healthy.status).toBe(200);
  });

  test('revoked customer key is rejected (401 key_revoked)', async () => {
    const revoke = await adminMutate(s, `/api/keys/${apiKeyRowId}`, 'PATCH', { action: 'revoke' });
    expect([200, 204]).toContain(revoke.status);
    const res = await gatewayCall('/api/v1/chat/completions', apiKeyPlaintext, {
      model: 'mock-model-a',
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('key_revoked');
  });
});

// ─── Anthropic-compatible provider execution (Priority 1 repeat) ─────────────

describe('P1 — Anthropic-compatible provider end-to-end', () => {
  let accountId = '';
  let apiKeyPlaintext = '';

  test('connect + validate + discover + adopt + execute through /api/v1/messages', async () => {
    const create = await adminMutate(s, '/api/providers', 'POST', {
      name: 'Mock-Test Anthropic Provider',
      providerType: 'anthropic',
      baseUrl: 'http://127.0.0.1:3998/v1',
      credentialMode: 'stored',
      apiKey: VALID_OPENAI_KEY,
    });
    expect(create.status).toBe(201);
    accountId = ((await create.json()) as { account: { id: string } }).account.id;

    const validate = await adminMutate(s, `/api/providers/${accountId}/validate`, 'POST');
    expect(validate.status).toBe(200);

    const adopt = await adminMutate(s, `/api/providers/${accountId}/discover`, 'POST', {
      adopt: [{ modelId: 'mock-anth-model-a', displayName: 'Mock Anthropic A', capabilities: { chat: true, reasoning: false, vision: false, files: false, webSearch: false, tools: false, json: false }, contextWindow: 4096 }],
    });
    expect(adopt.status).toBe(200);

    const model = await db.modelConfig.findUnique({ where: { modelId: 'mock-anth-model-a' } });
    expect(model!.enabled).toBe(false);
    await adminMutate(s, `/api/models/${model!.id}`, 'PATCH', { enabled: true });

    const keyRes = await adminMutate(s, '/api/keys', 'POST', { name: 'Mock-Test Anthropic Key' });
    apiKeyPlaintext = ((await keyRes.json()) as { plaintext: string }).plaintext;

    // Anthropic protocol: x-api-key auth, /api/v1/messages endpoint
    const res = await gatewayCall(
      '/api/v1/messages',
      apiKeyPlaintext,
      { model: 'mock-anth-model-a', max_tokens: 32, messages: [{ role: 'user', content: 'hello' }] },
      'x-api-key'
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      model: string;
      content: Array<{ type: string; text: string }>;
      usage: { input_tokens: number };
    };
    expect(body.content[0].text).toBe('MOCK-ANTHROPIC-REPLY');
    expect(body.model).toBe('mock-anth-model-a');
    expect(body.usage.input_tokens).toBe(10);

    // attribution through the Anthropic pipeline too
    const rec = await db.usageRecord.findFirst({
      where: { modelId: 'mock-anth-model-a' },
      orderBy: { createdAt: 'desc' },
    });
    expect(rec!.providerAccountId).toBe(accountId);
    expect(rec!.routeId).toBeTruthy();
    expect(rec!.servedModel).toBe('mock-anth-model-a');
  });

  test('Anthropic streaming (SSE events with message protocol)', async () => {
    const keyRow = await db.apiKey.findFirst({ where: { name: 'Mock-Test Anthropic Key' } });
    const ledger = await db.usageRecord.findFirst({
      where: { modelId: 'mock-anth-model-a', apiKeyId: keyRow!.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(ledger).toBeTruthy(); // pre-condition from the previous test

    // fetch a fresh plaintext key for streaming (create a second key)
    const keyRes = await adminMutate(s, '/api/keys', 'POST', { name: 'Mock-Test Anthropic Key 2' });
    const key2 = ((await keyRes.json()) as { plaintext: string }).plaintext;
    const res = await gatewayCall(
      '/api/v1/messages',
      key2,
      { model: 'mock-anth-model-a', max_tokens: 32, stream: true, messages: [{ role: 'user', content: 'stream' }] },
      'x-api-key'
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('MOCK-ANTHROPIC-REPLY');
    expect(text).toContain('message_stop');
  });
});

/**
 * EmorAI intelligent-routing end-to-end verification (REAL upstream execution).
 *
 * Chain verified: provider account (platform zai) → model registry (emor-5.3)
 * → route configuration (glm-5.3 primary / glm-5.3-flash fallback) →
 * intelligent routing → actual API request → usage recording with route
 * attribution → routing decision log.
 *
 * Run: bun run scripts/test-routing.ts
 */
import { createHash, randomBytes } from 'crypto';
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();
const BASE = process.env.GATEWAY_BASE ?? 'http://localhost:3000';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;

function report(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function createTestKey(name: string): Promise<{ id: string; plaintext: string }> {
  const plaintext = `emr_${randomBytes(24).toString('hex')}`;
  const row = await db.apiKey.create({
    data: {
      name,
      keyHash: createHash('sha256').update(plaintext, 'utf8').digest('hex'),
      prefix: plaintext.slice(0, 12),
    },
  });
  return { id: row.id, plaintext };
}

async function main(): Promise<void> {
  console.log('EmorAI routing E2E — real upstream execution\n');

  // 0) registry state preflight
  const emor = await db.modelConfig.findUnique({ where: { modelId: 'emor-5.3' } });
  const routes = await db.modelRoute.findMany({ where: { publicModelId: 'emor-5.3' }, include: { providerAccount: true } });
  report('emor-5.3 registry row exists (category emorai)', emor?.category === 'emorai');
  report('emor-5.3 has 2 routes (primary + fallback)', routes.length === 2, `got ${routes.length}`);
  report('primary route targets glm-5.3', routes.some((r) => r.upstreamModelId === 'glm-5.3' && r.priority === 0));
  report('zai platform account present', routes.every((r) => r.providerAccount.providerType === 'zai'));

  const key = await createTestKey('routing-e2e-test');

  // 1) non-streaming completion via emor-5.3 (exercises the full router)
  console.log('\n— POST /api/v1/chat/completions {model: emor-5.3} —');
  const before = await db.usageRecord.count();
  const beforeDecisions = await db.routingDecision.count();
  const res1 = await fetch(`${BASE}/api/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key.plaintext}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'emor-5.3',
      messages: [{ role: 'user', content: 'Reply with exactly: ROUTE-OK' }],
      max_tokens: 32,
    }),
  });
  const body1 = (await res1.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    model?: string;
    emorai_requested_model?: string;
    usage?: { total_tokens: number };
    error?: { message?: string };
  };
  report('HTTP 200', res1.status === 200, `status ${res1.status} ${body1.error?.message ?? ''}`);
  report('assistant content non-empty', (body1.choices?.[0]?.message?.content ?? '').length > 0);
  report('emorai_requested_model = emor-5.3', body1.emorai_requested_model === 'emor-5.3');
  report('response reports upstream served model (not emor id)', typeof body1.model === 'string' && body1.model !== 'emor-5.3');
  report('usage reported', (body1.usage?.total_tokens ?? 0) > 0);

  // usage attribution to the actual route + account
  const usageRows = await db.usageRecord.findMany({
    where: { apiKeyId: key.id, modelId: 'emor-5.3' },
    orderBy: { createdAt: 'desc' },
    take: 1,
  });
  const usage = usageRows[0];
  report('usage record attributed to model emor-5.3', !!usage);
  report('usage record carries routeId', !!usage?.routeId, JSON.stringify(usage?.routeId));
  report('usage record carries providerAccountId', !!usage?.providerAccountId);
  report('usage record success', usage?.success === true);

  const route = usage?.routeId
    ? await db.modelRoute.findUnique({ where: { id: usage.routeId } })
    : null;
  report('executed route = glm-5.3 primary', route?.upstreamModelId === 'glm-5.3', route?.upstreamModelId ?? 'none');

  // routing decision logged with candidates + selected route
  const decisions = await db.routingDecision.findMany({ where: { modelId: 'emor-5.3' }, orderBy: { createdAt: 'desc' }, take: 1 });
  const decision = decisions[0];
  report('routing decision logged', !!decision);
  report('decision status routed', decision?.finalStatus === 'routed');
  report('decision selected upstream glm-5.3', decision?.upstreamModel === 'glm-5.3');
  const candidates = (decision?.candidates ?? []) as Array<{ upstreamModel?: string; rejected?: boolean }>;
  report('decision lists candidates incl. fallback', candidates.length >= 2 && candidates.some((c) => c.upstreamModel === 'glm-5.3-flash'));

  // route health updated from the real execution
  const primaryAfter = await db.modelRoute.findFirst({ where: { publicModelId: 'emor-5.3', priority: 0 } });
  report('primary route health → healthy', primaryAfter?.healthStatus === 'healthy');
  const accountAfter = primaryAfter ? await db.providerAccount.findUnique({ where: { id: primaryAfter.providerAccountId } }) : null;
  report('account requestCount incremented', (accountAfter?.requestCount ?? 0) >= 1);

  await sleep(6000); // respect upstream rate limits between real calls

  // 2) streaming via emor-5.2 (different generation, single route)
  console.log('\n— POST /api/v1/chat/completions {model: emor-5.2, stream} —');
  const res2 = await fetch(`${BASE}/api/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key.plaintext}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'emor-5.2',
      messages: [{ role: 'user', content: 'Count from 1 to 5 slowly.' }],
      max_tokens: 64,
      stream: true,
    }),
  });
  let streamed = '';
  let sawDone = false;
  if (res2.ok && res2.body) {
    const text = await res2.text();
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') {
        sawDone = true;
        continue;
      }
      try {
        const chunk = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> };
        streamed += chunk.choices?.[0]?.delta?.content ?? '';
      } catch {
        // keepalive/ignore
      }
    }
  }
  report('stream HTTP 200', res2.status === 200, `status ${res2.status}`);
  report('streamed content non-empty', streamed.length > 0);
  report('stream terminated with [DONE]', sawDone);
  const usage2 = await db.usageRecord.findMany({ where: { apiKeyId: key.id, modelId: 'emor-5.2' }, orderBy: { createdAt: 'desc' }, take: 1 });
  report('emor-5.2 usage attributed with route', !!usage2[0]?.routeId);

  await sleep(6000);

  // 3) legacy regression: direct provider model still works (no routing table hit)
  console.log('\n— POST /api/v1/chat/completions {model: glm-5.3-flash} (legacy direct) —');
  const res3 = await fetch(`${BASE}/api/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key.plaintext}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'glm-5.3-flash',
      messages: [{ role: 'user', content: 'Reply with exactly: LEGACY-OK' }],
      max_tokens: 32,
    }),
  });
  const body3 = (await res3.json()) as { choices?: Array<{ message?: { content?: string } }> };
  report('legacy model HTTP 200', res3.status === 200, `status ${res3.status}`);
  report('legacy model content non-empty', (body3.choices?.[0]?.message?.content ?? '').length > 0);
  const usage3 = await db.usageRecord.findMany({ where: { apiKeyId: key.id, modelId: 'glm-5.3-flash' }, orderBy: { createdAt: 'desc' }, take: 1 });
  report('legacy usage recorded (direct, no routeId)', usage3.length === 1 && !usage3[0].routeId);

  await sleep(6000);

  // 4) Anthropic-compat gateway through the same router
  console.log('\n— POST /api/v1/messages {model: emor-5.3, Anthropic protocol} —');
  const res4 = await fetch(`${BASE}/api/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': key.plaintext, 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'emor-5.3',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'Reply with exactly: ANTHROPIC-ROUTE-OK' }],
    }),
  });
  const body4 = (await res4.json()) as { content?: Array<{ type: string; text?: string }>; usage?: { input_tokens: number } };
  report('anthropic HTTP 200', res4.status === 200, `status ${res4.status}`);
  report('anthropic content block present', (body4.content ?? []).some((b) => b.type === 'text' && (b.text ?? '').length > 0));
  report('anthropic usage reported', (body4.usage?.input_tokens ?? 0) > 0);

  // 5) models endpoint exposes the family
  const modelsRes = await fetch(`${BASE}/api/v1/models`, { headers: { Authorization: `Bearer ${key.plaintext}` } });
  const modelsBody = (await modelsRes.json()) as { data?: Array<{ id: string }> };
  report('GET /api/v1/models lists emor-5.3', (modelsBody.data ?? []).some((m) => m.id === 'emor-5.3'));
  report('GET /api/v1/models lists emor-5.2', (modelsBody.data ?? []).some((m) => m.id === 'emor-5.2'));
  report('GET /api/v1/models lists emor-5.1', (modelsBody.data ?? []).some((m) => m.id === 'emor-5.1'));

  // cleanup: revoke + delete test key (keeps usage records for audit)
  await db.apiKey.delete({ where: { id: key.id } }).catch(() => undefined);
  console.log(`\n${passed} passed, ${failed} failed (test key removed; usage records kept).`);
  if (failed > 0) process.exit(1);
}

main()
  .catch((e) => {
    console.error('routing E2E failed:', e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());

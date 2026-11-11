/**
 * EmorAI vision capability correctness — emor-5.3 (capability accuracy pass).
 *
 * 1. Honesty audit of the emor family (emor-5.3 / emor-5.2 / emor-5.1): any
 *    capability advertised on the public model that NO enabled route carries
 *    and that has never been verified by a successful real probe is flipped
 *    to false + an AlertEvent (category 'capability') is recorded.
 *    glm-* provider-category models are NOT touched.
 * 2. Idempotently adds the authorized vision-capable route:
 *      emor-5.3 → glm-4.6v-flash (priority 10, capabilities {chat, vision})
 *    Existing routes and model rows are never deleted or modified.
 * 3. Runs a REAL vision probe THROUGH the intelligent router
 *    (streamChatRouted, needs={vision:true}, 1×1 PNG image part, maxTokens 16):
 *      • SUCCESS  → emor-5.3 capabilities.vision = true + capsVerification
 *                  evidence (served model observed, route, probedAt)
 *      • FAILURE  → vision stays false; a definitive upstream rejection also
 *                  DISABLES the route (enabled=false) — honest state. A purely
 *                  rate-limited outcome (after at most two backoff retries)
 *                  keeps the route enabled and records the failure honestly.
 *
 * Run: bun scripts/configure-vision-route.ts
 */
import { streamChatRouted, type RouteAttribution } from '@/lib/ai/router';
import { ProviderError } from '@/lib/ai/zai-adapter';
import { db } from '@/lib/db';

type Caps = {
  chat: boolean;
  reasoning: boolean;
  vision: boolean;
  files: boolean;
  webSearch: boolean;
  tools: boolean;
  json: boolean;
};

const BASE_CAPS: Caps = {
  chat: true,
  reasoning: false,
  vision: false,
  files: false,
  webSearch: true,
  tools: false,
  json: false,
};

const CAP_KEYS: Array<keyof Caps> = ['chat', 'reasoning', 'vision', 'files', 'webSearch', 'tools', 'json'];

// 1×1 RGB PNG (69 bytes) — structure and pixel round-trip verified.
const TINY_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGPo8NECAAJeAP9e93caAAAAAElFTkSuQmCC';

const EMOR_MODELS = ['emor-5.3', 'emor-5.2', 'emor-5.1'] as const;
const VISION_ROUTE = {
  publicModelId: 'emor-5.3',
  upstreamModelId: 'glm-4.6v-flash',
  priority: 10,
  // task spec: { chat: true, vision: true, rest false }
  capabilities: {
    chat: true,
    reasoning: false,
    vision: true,
    files: false,
    webSearch: false,
    tools: false,
    json: false,
  } as Caps,
  maxConcurrency: 0,
  timeoutMs: 120_000,
  weight: 1,
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function readCaps(raw: unknown): Caps {
  return { ...BASE_CAPS, ...(isPlainObject(raw) ? (raw as Partial<Caps>) : {}) };
}

/** True when a route's capability subset carries `cap` (null → inherit model caps). */
function routeCarries(routeCapsRaw: unknown, modelCaps: Caps, cap: keyof Caps): boolean {
  if (!isPlainObject(routeCapsRaw)) return Boolean(modelCaps[cap]);
  const merged = readCaps(routeCapsRaw);
  return Boolean(merged[cap]);
}

async function alertCapability(message: string, meta: Record<string, unknown>): Promise<void> {
  await db.alertEvent.create({
    data: { level: 'warning', category: 'capability', message, meta: JSON.parse(JSON.stringify(meta)) },
  });
}

// ─── Step 1: honesty audit (declared vs route-carried capabilities) ──────────

async function auditEmorFamily(): Promise<string[]> {
  const fixes: string[] = [];
  for (const modelId of EMOR_MODELS) {
    const model = await db.modelConfig.findUnique({ where: { modelId } });
    if (!model) {
      console.log(`• ${modelId}: no model row (skipped)`);
      continue;
    }
    const caps = readCaps(model.capabilities);
    const routes = await db.modelRoute.findMany({
      where: { publicModelId: modelId, enabled: true },
      include: { providerAccount: { select: { enabled: true } } },
    });
    const activeRoutes = routes.filter((r) => r.providerAccount.enabled);
    const verification = isPlainObject(model.capsVerification) ? model.capsVerification : {};
    const mismatches: Array<keyof Caps> = [];
    for (const cap of CAP_KEYS) {
      if (!caps[cap]) continue;
      const carried = activeRoutes.some((r) => routeCarries(r.capabilities, caps, cap));
      const verified = verification[cap] === 'verified';
      if (!carried && !verified) {
        // advertised, no route can serve it, never verified → dishonest
        mismatches.push(cap);
      }
    }
    if (mismatches.length === 0) {
      console.log(`✓ ${modelId}: every advertised capability is carried by an enabled route (honest)`);
      continue;
    }
    const fixedCaps = { ...caps };
    for (const cap of mismatches) fixedCaps[cap] = false;
    await db.modelConfig.update({
      where: { id: model.id },
      data: {
        capabilities: JSON.parse(JSON.stringify(fixedCaps)),
        capsVerification: {
          ...verification,
          ...Object.fromEntries(mismatches.map((cap) => [cap, 'failed'])),
          probedAt: new Date().toISOString(),
          details: {
            ...(isPlainObject(verification.details) ? verification.details : {}),
            ...Object.fromEntries(
              mismatches.map((cap) => [
                cap,
                { status: 'failed', reason: 'advertised but no enabled route carries it and no probe ever verified it' },
              ])
            ),
          },
        },
      },
    });
    await alertCapability(
      `Model "${modelId}" advertised capabilities [${mismatches.join(', ')}] but no enabled route carries them — flipped to false (capability audit).`,
      { modelId, flipped: mismatches }
    );
    fixes.push(`${modelId}: flipped [${mismatches.join(', ')}] to false (no route carries them)`);
    console.log(`! ${modelId}: advertised [${mismatches.join(', ')}] with no carrying route — flipped false + capability alert`);
  }
  return fixes;
}

// ─── Step 2: authorized vision route (idempotent) ─────────────────────────────

async function ensureVisionRoute(accountId: string): Promise<{ created: boolean; routeId: string }> {
  const existing = await db.modelRoute.findFirst({
    where: {
      publicModelId: VISION_ROUTE.publicModelId,
      providerAccountId: accountId,
      upstreamModelId: VISION_ROUTE.upstreamModelId,
    },
  });
  if (existing) {
    console.log(`• vision route exists (emor-5.3 → ${VISION_ROUTE.upstreamModelId}, id ${existing.id}) — left untouched`);
    return { created: false, routeId: existing.id };
  }
  const route = await db.modelRoute.create({
    data: {
      publicModelId: VISION_ROUTE.publicModelId,
      providerAccountId: accountId,
      upstreamModelId: VISION_ROUTE.upstreamModelId,
      priority: VISION_ROUTE.priority,
      enabled: true,
      capabilities: JSON.parse(JSON.stringify(VISION_ROUTE.capabilities)),
      maxConcurrency: VISION_ROUTE.maxConcurrency,
      timeoutMs: VISION_ROUTE.timeoutMs,
      weight: VISION_ROUTE.weight,
      healthStatus: 'unknown',
    },
  });
  console.log(`✓ vision route created: emor-5.3 → ${VISION_ROUTE.upstreamModelId} (priority ${VISION_ROUTE.priority}, caps {chat, vision}) — id ${route.id}`);
  return { created: true, routeId: route.id };
}

// ─── Step 3: REAL vision probe through the router ────────────────────────────

type VisionProbeOutcome = {
  ok: boolean;
  servedModel: string | null;
  routeUpstream: string | null;
  routeId: string | null;
  error: string | null;
  transient: boolean;
  preview: string;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runVisionProbe(): Promise<VisionProbeOutcome> {
  const attribution: RouteAttribution = {};
  let gotDelta = false;
  let servedModel: string | null = null;
  let preview = '';
  for await (const ev of streamChatRouted(
    'emor-5.3',
    {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this image in one short word.' },
            { type: 'image_url', image_url: { url: TINY_PNG_DATA_URL } },
          ],
        },
      ],
      maxTokens: 16,
      timeoutMs: 90_000,
      requestId: `vision-route-probe-${Date.now().toString(36)}`,
      attribution,
    },
    { vision: true, tools: false }
  )) {
    if (ev.type === 'served-model') servedModel = ev.model;
    else if (ev.type === 'delta') {
      gotDelta = true;
      preview += ev.content;
    }
  }
  return {
    ok: gotDelta,
    servedModel,
    routeUpstream: attribution.upstreamModel ?? null,
    routeId: attribution.routeId ?? null,
    error: gotDelta ? null : 'vision request completed without any content delta',
    transient: false,
    preview,
  };
}

/** Probe with at most two backoff retries on transient (rate-limit) failures. */
async function probeWithRetry(): Promise<VisionProbeOutcome> {
  const MAX_RETRIES = 2;
  let lastError = 'unknown error';
  let lastTransient = false;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const backoffMs = attempt === 1 ? 4_000 : 8_000;
      console.log(`  … retrying vision probe in ${backoffMs / 1000}s (attempt ${attempt + 1} of ${MAX_RETRIES + 1})`);
      await sleep(backoffMs);
    }
    try {
      const outcome = await runVisionProbe();
      if (outcome.ok) return outcome;
      // completed but no delta — definitive failure, no retry helps
      return outcome;
    } catch (e) {
      lastError = e instanceof ProviderError ? `${e.code}: ${e.message}` : String((e as Error)?.message ?? e);
      lastTransient =
        e instanceof ProviderError && (e.code === 'rate_limited' || e.code === 'timeout' || e.code === 'provider_error');
      console.log(`  ✗ attempt ${attempt + 1} failed: ${lastError.slice(0, 160)}`);
      if (!lastTransient) break; // definitive rejection — fail honestly now
    }
  }
  return { ok: false, servedModel: null, routeUpstream: null, routeId: null, error: lastError, transient: lastTransient, preview: '' };
}

// ─── Step 4: record the outcome honestly ─────────────────────────────────────

async function main(): Promise<void> {
  console.log('EmorAI vision capability correctness — emor-5.3\n');

  const account = await db.providerAccount.findFirst({
    where: { providerType: 'zai', credentialMode: 'platform', enabled: true },
  });
  if (!account) throw new Error('platform zai provider account not found');
  console.log(`zai platform account: ${account.id} (${account.name})\n`);

  console.log('— Step 1: honesty audit (declared vs route-carried capabilities) —');
  const fixes = await auditEmorFamily();
  if (fixes.length === 0) console.log('  no advertised-without-carrier mismatches found in the emor family');

  console.log('\n— Step 2: authorized vision route (idempotent) —');
  const visionRoute = await ensureVisionRoute(account.id);

  console.log('\n— Step 3: REAL vision probe through the router (1×1 PNG, maxTokens 16) —');
  const probe = await probeWithRetry();
  console.log(
    `  outcome: ${probe.ok ? 'SUCCESS' : 'FAILURE'}${probe.transient ? ' (transient/rate-limited)' : ''}` +
      `\n  served model observed: ${probe.servedModel ?? 'n/a'}` +
      `\n  route upstream: ${probe.routeUpstream ?? 'n/a'} (route ${probe.routeId ?? 'n/a'})` +
      (probe.preview ? `\n  reply preview: ${JSON.stringify(probe.preview.slice(0, 60))}` : '') +
      (probe.error ? `\n  error: ${probe.error.slice(0, 200)}` : '')
  );

  console.log('\n— Step 4: recording the outcome —');
  const model = await db.modelConfig.findUnique({ where: { modelId: 'emor-5.3' } });
  if (!model) throw new Error('emor-5.3 model row not found');
  const caps = readCaps(model.capabilities);
  const verification = isPlainObject(model.capsVerification) ? model.capsVerification : {};
  const previousDetails = isPlainObject(verification.details) ? verification.details : {};
  const probedAt = new Date();

  if (probe.ok) {
    // SUCCESS: vision becomes true — now verified by a real probe.
    const updatedCaps = { ...caps, vision: true };
    await db.modelConfig.update({
      where: { id: model.id },
      data: {
        capabilities: JSON.parse(JSON.stringify(updatedCaps)),
        capsVerifiedAt: probedAt,
        capsVerification: {
          ...verification,
          vision: 'verified',
          probedAt: probedAt.toISOString(),
          details: {
            ...previousDetails,
            vision: {
              status: 'verified',
              servedModel: probe.servedModel,
              routeUpstream: probe.routeUpstream,
              routeId: probe.routeId,
              probe: 'real 1×1 PNG image part through streamChatRouted with needs={vision:true}',
              probedAt: probedAt.toISOString(),
            },
          },
        },
      },
    });
    console.log('  ✓ emor-5.3 capabilities.vision = true (verified by a real probe — evidence recorded)');
  } else {
    // FAILURE: vision stays false. Definitive upstream rejection → disable the
    // route (honest state: do not serve an unverified vision route). A purely
    // rate-limited outcome keeps the route enabled and records the failure.
    if (!probe.transient && visionRoute.routeId) {
      await db.modelRoute.update({ where: { id: visionRoute.routeId }, data: { enabled: false, lastError: (probe.error ?? '').slice(0, 400) } });
      console.log('  ✗ definitive upstream rejection — vision route DISABLED (enabled=false)');
    } else if (probe.transient) {
      console.log('  ✗ transient failure (rate limit) — route left ENABLED; vision stays false, failure recorded');
    }
    await db.modelConfig.update({
      where: { id: model.id },
      data: {
        capsVerifiedAt: probedAt,
        capsVerification: {
          ...verification,
          vision: 'failed',
          probedAt: probedAt.toISOString(),
          details: {
            ...previousDetails,
            vision: {
              status: 'failed',
              servedModel: probe.servedModel,
              routeUpstream: probe.routeUpstream,
              routeId: probe.routeId,
              error: probe.error,
              transient: probe.transient,
              probe: 'real 1×1 PNG image part through streamChatRouted with needs={vision:true}',
              probedAt: probedAt.toISOString(),
            },
          },
        },
      },
    });
    await alertCapability(
      `emor-5.3 vision probe FAILED against glm-4.6v-flash — vision capability stays false${probe.transient ? ' (transient rate-limit failure; route left enabled)' : ' (route disabled)'}.`,
      { modelId: 'emor-5.3', capability: 'vision', error: probe.error, transient: probe.transient }
    ).catch(() => undefined);
    console.log('  ✗ emor-5.3 capabilities.vision stays false (failed probe recorded honestly)');
  }

  console.log('\n— Final state —');
  for (const modelId of EMOR_MODELS) {
    const m = await db.modelConfig.findUnique({ where: { modelId } });
    if (!m) continue;
    console.log(`  ${modelId}: caps=${JSON.stringify(m.capabilities)} capsVerifiedAt=${m.capsVerifiedAt?.toISOString() ?? 'null'}`);
  }
  const routes = await db.modelRoute.findMany({
    where: { publicModelId: 'emor-5.3' },
    orderBy: { priority: 'asc' },
  });
  for (const r of routes) {
    console.log(`  route ${r.upstreamModelId} (priority ${r.priority}, enabled=${r.enabled}, caps=${JSON.stringify(r.capabilities)}, health=${r.healthStatus})`);
  }
  const probeVerdict = probe.ok
    ? 'VISION VERIFIED: emor-5.3 → glm-4.6v-flash serves real image input'
    : `VISION NOT VERIFIED: probe failed${probe.transient ? ' (rate-limited)' : ' (upstream rejected)'} — emor-5.3 vision stays false`;
  console.log(`\n${probeVerdict}`);
}

main()
  .catch((e) => {
    console.error('configure-vision-route failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    // give the router's fire-and-forget health/decision writes a moment to land
    await new Promise((r) => setTimeout(r, 1000));
    await db.$disconnect();
  });

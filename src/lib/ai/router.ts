// ─── Intelligent model router ────────────────────────────────────────────────
// Decides which authorized upstream route executes each request for a public
// EmorAI model, with eligibility verification, priority scoring, bounded
// failover, and a full admin-facing decision log.
//
// Flow (per request):
//   1. public model resolved upstream (registry + aliases — unchanged)
//   2. candidate routes loaded (enabled route + enabled account)
//   3. eligibility per route: known-bad health rejected, capability subset
//      verified, stored credentials must decrypt, adapter must exist
//   4. score (strategy-aware): priority + account priority + health recency
//      + weight — deterministic, documented, admin-tunable via route fields
//   5. execute via the route's adapter; on a retryable failure BEFORE any
//      output has been produced → fail over to the next eligible route
//      (public model identity is preserved); after output → surface the error
//      (never duplicate user-visible output or billing)
//   6. every decision logged to RoutingDecision; execution outcomes update
//      route + account health; the caller gets attribution for UsageRecord
//
// LEGACY PATH: models with no routes (e.g. directly-exposed provider models
// like glm-5.3) execute exactly as before — the router delegates straight to
// the zai adapter with the registry modelId. Zero behavior change.

import { db } from '@/lib/db';
import { resolveModel } from '@/lib/model-registry';
import { getAdapterByType, adapterContextForAccount } from '@/lib/ai/providers';
import type { AIProviderAdapter, AdapterContext, StreamChatOptions, StreamEvent, CompleteChatResult } from '@/lib/ai/providers';
import type { ModelCapabilities, ModelInfo, RoutingStrategyName } from '@/lib/types';
import { DEFAULT_CAPABILITIES } from '@/lib/types';
import { getSettings } from '@/lib/settings';
import { ProviderError } from '@/lib/ai/zai-adapter';

// ─── Types ───────────────────────────────────────────────────────────────────

export type RouteAttribution = {
  routeId?: string;
  providerAccountId?: string;
  providerType?: string;
  upstreamModel?: string;
  attempts?: number;
  failedCandidates?: Array<{ routeId: string; reason: string }>;
  routed?: boolean;
};

export type RoutingStrategy = RoutingStrategyName;

// Strategies:
//   balanced    — priority + account priority + health recency + weight blend
//   priority    — pure configured order (route.priority, then account priority)
//   cost        — lowest admin-configured route weight first (weight is the
//                 honest cost proxy; pricing metadata is never invented)
//   performance — lowest recently *measured* execution latency first
//                 (routes never measured use a neutral 1200 ms prior)
const STRATEGY_SCORE_PRIOR_MS = 1200;

type RouteRow = {
  id: string;
  publicModelId: string;
  providerAccountId: string;
  upstreamModelId: string;
  priority: number;
  enabled: boolean;
  capabilities: unknown;
  maxConcurrency: number;
  timeoutMs: number;
  weight: number;
  healthStatus: string;
  lastServedAt: Date | null;
  lastLatencyMs: number | null;
  lastError: string | null;
  providerAccount: {
    id: string;
    name: string;
    providerType: string;
    baseUrl: string | null;
    apiKeyEnc: string | null;
    credentialMode: string;
    enabled: boolean;
    priority: number;
    maxConcurrency: number;
    monthlyBudget: number | null;
    lastStatus: string | null;
    lastError: string | null;
  };
};

type Candidate = {
  route: RouteRow;
  adapter: AIProviderAdapter;
  ctx: AdapterContext;
  routeCaps: ModelCapabilities;
  score: number;
};

export type ExecutionRequest = {
  requestId: string;
  // capability requirements derived from the actual request
  needs: { vision: boolean; tools: boolean; streaming: boolean };
};

// ─── Eligibility + scoring ──────────────────────────────────────────────────

function routeCapabilities(route: RouteRow, modelCaps: ModelCapabilities): ModelCapabilities {
  const raw = route.capabilities as Partial<ModelCapabilities> | null;
  if (!raw || typeof raw !== 'object') return modelCaps;
  // explicit subset declared on the route; unspecified keys default OFF —
  // honest: a route only carries what was verified for it
  return { ...DEFAULT_CAPABILITIES, ...raw };
}

function eligible(route: RouteRow, model: ModelInfo, req: ExecutionRequest): { ok: boolean; reason?: string } {
  if (!route.enabled) return { ok: false, reason: 'route disabled' };
  if (!route.providerAccount.enabled) return { ok: false, reason: 'account disabled' };
  if (route.providerAccount.lastStatus === 'error') {
    return { ok: false, reason: `account failed last validation: ${(route.providerAccount.lastError ?? '').slice(0, 120)}` };
  }
  if (route.healthStatus === 'down') {
    return { ok: false, reason: `route marked down: ${(route.lastError ?? '').slice(0, 120)}` };
  }
  const adapter = getAdapterByType(route.providerAccount.providerType);
  if (!adapter) return { ok: false, reason: `no adapter registered for provider "${route.providerAccount.providerType}"` };
  if (route.providerAccount.credentialMode === 'stored' && !route.providerAccount.apiKeyEnc) {
    return { ok: false, reason: 'account has no stored credential' };
  }
  // capability subset verification
  const caps = routeCapabilities(route, model.capabilities);
  if (req.needs.vision && !caps.vision) return { ok: false, reason: 'route not vision-capable' };
  if (req.needs.tools && !caps.tools) return { ok: false, reason: 'route not tool-capable' };
  if (req.needs.streaming && !adapter.supports('streaming')) return { ok: false, reason: 'adapter cannot stream' };
  return { ok: true };
}

/** The strategy configured by the administrator (AppSetting, default balanced). */
export async function currentRoutingStrategy(): Promise<RoutingStrategy> {
  try {
    const settings = await getSettings();
    return settings.routingStrategy;
  } catch {
    return 'balanced'; // settings read must never break routing
  }
}

/** Deterministic route score (lower = preferred). Strategy-aware. */
function scoreRoute(route: RouteRow, strategy: RoutingStrategy): number {
  const base = route.priority * 100 + route.providerAccount.priority * 10;
  switch (strategy) {
    case 'priority':
      // pure configured order — no health/weight adjustments
      return base;
    case 'cost':
      // weight is the admin-configured cost proxy (default 1.0); lower first.
      // Priority only breaks ties — cost dominates.
      return Math.round(route.weight * 1000) + base;
    case 'performance': {
      // Measured recent execution latency only — never guessed. Unmeasured
      // routes get a neutral prior so they are not permanently starved.
      const latency = route.lastLatencyMs ?? STRATEGY_SCORE_PRIOR_MS;
      return latency + base * 0.05 + (route.healthStatus === 'degraded' ? 2000 : 0);
    }
    case 'balanced':
    default: {
      let score = base;
      // healthy recent activity is a small bonus; stale/unknown is neutral
      if (route.healthStatus === 'healthy') score -= 5;
      if (route.providerAccount.lastStatus === 'ok') score -= 2;
      // cost/performance weight: heavier routes rank later on ties
      score += Math.max(0, route.weight - 1) * 8;
      return score;
    }
  }
}

/** Loads + verifies + orders every candidate route for a public model. */
async function planCandidates(model: ModelInfo, req: ExecutionRequest, strategy: RoutingStrategy): Promise<{
  candidates: Candidate[];
  rejected: Array<{ routeId: string; upstreamModel: string; reason: string }>;
}> {
  const routes = (await db.modelRoute.findMany({
    where: { publicModelId: model.modelId },
    include: { providerAccount: true },
    orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
  })) as unknown as RouteRow[];

  const candidates: Candidate[] = [];
  const rejected: Array<{ routeId: string; upstreamModel: string; reason: string }> = [];
  for (const route of routes) {
    const check = eligible(route, model, req);
    if (!check.ok) {
      rejected.push({ routeId: route.id, upstreamModel: route.upstreamModelId, reason: check.reason ?? 'ineligible' });
      continue;
    }
    let ctx: AdapterContext;
    try {
      ctx = adapterContextForAccount(route.providerAccount);
    } catch (e) {
      rejected.push({ routeId: route.id, upstreamModel: route.upstreamModelId, reason: `credentials undecryptable: ${String((e as Error)?.message ?? e).slice(0, 120)}` });
      continue;
    }
    candidates.push({
      route,
      adapter: getAdapterByType(route.providerAccount.providerType)!,
      ctx,
      routeCaps: routeCapabilities(route, model.capabilities),
      score: scoreRoute(route, strategy),
    });
  }
  candidates.sort((a, b) => a.score - b.score);
  return { candidates, rejected };
}

// ─── Decision logging + health updates ───────────────────────────────────────

async function recordDecision(input: {
  requestId: string;
  modelId: string;
  strategy: RoutingStrategy;
  candidates: Candidate[];
  rejected: Array<{ routeId: string; upstreamModel: string; reason: string }>;
  attribution: RouteAttribution;
  finalStatus: 'routed' | 'failed' | 'direct';
  errorText?: string | null;
  latencyMs?: number | null;
}): Promise<void> {
  try {
    await db.routingDecision.create({
      data: {
        requestId: input.requestId,
        modelId: input.modelId,
        strategy: input.strategy,
        candidates: [
          ...input.candidates.map((c) => ({
            routeId: c.route.id,
            upstreamModel: c.route.upstreamModelId,
            providerType: c.route.providerAccount.providerType,
            account: c.route.providerAccount.name,
            score: c.score,
            rejected: false,
          })),
          ...input.rejected.map((r) => ({ ...r, providerType: 'unknown', account: 'unknown', score: 0, rejected: true })),
        ],
        selectedRouteId: input.attribution.routeId ?? null,
        upstreamModel: input.attribution.upstreamModel ?? null,
        providerType: input.attribution.providerType ?? null,
        attemptCount: input.attribution.attempts ?? 1,
        finalStatus: input.finalStatus,
        errorText: input.errorText ? input.errorText.slice(0, 400) : null,
        latencyMs: input.latencyMs ?? null,
      },
    });
  } catch {
    // decision logging must never break the request
  }
}

async function markRouteServed(routeId: string, accountId: string, latencyMs?: number): Promise<void> {
  const now = new Date();
  void db.modelRoute
    .update({
      where: { id: routeId },
      data: {
        healthStatus: 'healthy',
        lastServedAt: now,
        lastError: null,
        ...(typeof latencyMs === 'number' ? { lastLatencyMs: Math.max(0, Math.round(latencyMs)) } : {}),
      },
    })
    .catch(() => undefined);
  void db.providerAccount
    .update({ where: { id: accountId }, data: { requestCount: { increment: 1 }, lastStatus: 'ok', lastError: null } })
    .catch(() => undefined);
}

async function markRouteFailed(routeId: string, accountId: string, errorText: string, markDown: boolean): Promise<void> {
  void db.modelRoute
    .update({
      where: { id: routeId },
      data: { lastError: errorText.slice(0, 400), ...(markDown ? { healthStatus: 'down' } : {}) },
    })
    .catch(() => undefined);
  void db.providerAccount
    .update({ where: { id: accountId }, data: { lastError: errorText.slice(0, 400), ...(markDown ? { lastStatus: 'error' } : {}) } })
    .catch(() => undefined);
}

/** Should this failure trigger a failover attempt on the next route? */
function failoverWorthy(err: ProviderError): boolean {
  switch (err.code) {
    case 'rate_limited':
    case 'timeout':
    case 'provider_error':
      return true; // transient upstream issues → try another authorized route
    case 'provider_auth':
      return true; // this account's credentials failed; another account may be fine
    case 'model_unavailable':
      return true; // this upstream lacks the model; another route may serve it
    case 'bad_request':
    case 'content_filtered':
    case 'aborted':
      return false; // request-content issues follow the request everywhere
  }
}

// ─── Legacy direct path (models without routes) ─────────────────────────────

async function* directStream(model: ModelInfo, opts: StreamChatOptions): AsyncGenerator<StreamEvent> {
  // preserve the exact pre-router behavior: registry modelId straight to zai
  const { streamChat } = await import('@/lib/ai/zai-adapter');
  yield* streamChat({ ...opts, modelId: model.modelId, provider: model.provider });
}

async function directComplete(model: ModelInfo, opts: StreamChatOptions): Promise<CompleteChatResult> {
  const { completeChat } = await import('@/lib/ai/zai-adapter');
  return completeChat({ ...opts, modelId: model.modelId, provider: model.provider });
}

// ─── Public execution API ────────────────────────────────────────────────────

export type RoutedStreamPlan = {
  model: ModelInfo;
  viaAlias: string | null;
  strategy: RoutingStrategy;
  routed: boolean;
  candidates: Array<{ routeId: string; upstreamModel: string; providerType: string; account: string; score: number }>;
  rejected: Array<{ routeId: string; upstreamModel: string; reason: string }>;
};

/**
 * Resolves a public model + its execution plan (candidates in score order).
 * Use when the caller needs the plan before streaming (e.g. capability gates).
 * Legacy models return routed=false and execute through the direct path.
 */
export async function planExecution(requestedModelId: string): Promise<RoutedStreamPlan | null> {
  const resolved = await resolveModel(requestedModelId);
  if (!resolved) return null;
  const model = resolved.model;
  const strategy = await currentRoutingStrategy();
  const { candidates, rejected } = await planCandidates(
    model,
    { requestId: 'plan', needs: { vision: false, tools: false, streaming: true } },
    strategy
  );
  return {
    model,
    viaAlias: resolved.viaAlias,
    strategy,
    routed: candidates.length > 0,
    candidates: candidates.map((c) => ({
      routeId: c.route.id,
      upstreamModel: c.route.upstreamModelId,
      providerType: c.route.providerAccount.providerType,
      account: c.route.providerAccount.name,
      score: c.score,
    })),
    rejected,
  };
}

/**
 * Streams a chat completion for a public EmorAI model through the intelligent
 * router. Attribution (selected route/account) is written into `attribution`
 * before the first event so the caller can record usage against the route.
 */
export async function* streamChatRouted(
  requestedModelId: string,
  opts: StreamChatOptions & { requestId: string; attribution: RouteAttribution },
  needs: { vision: boolean; tools: boolean } = { vision: false, tools: false }
): AsyncGenerator<StreamEvent> {
  const attribution = opts.attribution;
  const resolved = await resolveModel(requestedModelId);
  if (!resolved) {
    throw new ProviderError('model_unavailable', `Model "${requestedModelId}" does not exist in this EmorAI installation.`, { status: 404 });
  }
  const model = resolved.model;
  const strategy = await currentRoutingStrategy();
  const req: ExecutionRequest = { requestId: opts.requestId, needs: { ...needs, streaming: true } };
  const { candidates, rejected } = await planCandidates(model, req, strategy);

  if (candidates.length === 0) {
    // EmorAI family models REQUIRE a configured eligible route — never
    // silently fall through to a direct upstream call.
    if (model.category === 'emorai') {
      throw new ProviderError(
        'model_unavailable',
        `Model "${model.modelId}" has no eligible route configured. Add or enable a route in Settings → Routes.`,
        { status: 501 }
      );
    }
    // legacy direct path — zero behavior change for un-routed provider models
    if (model.provider !== 'zai') {
      throw new ProviderError(
        'model_unavailable',
        `Model "${model.modelId}" routes to provider "${model.provider}", which is not configured on this installation.`,
        { status: 501 }
      );
    }
    attribution.routed = false;
    const started = Date.now();
    try {
      for await (const ev of directStream(model, opts)) {
        yield ev;
      }
      void recordDecision({
        requestId: opts.requestId,
        modelId: model.modelId,
        strategy,
        candidates: [],
        rejected,
        attribution: {},
        finalStatus: 'direct',
        latencyMs: Date.now() - started,
      });
    } catch (e) {
      void recordDecision({
        requestId: opts.requestId,
        modelId: model.modelId,
        strategy,
        candidates: [],
        rejected,
        attribution: {},
        finalStatus: 'failed',
        errorText: String((e as Error)?.message ?? e),
        latencyMs: Date.now() - started,
      });
      throw e;
    }
    return;
  }

  // routed path: try candidates in order; fail over only before first output
  attribution.routed = true;
  let emittedOutput = false;
  let lastError: ProviderError | null = null;
  const started = Date.now();

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    attribution.routeId = c.route.id;
    attribution.providerAccountId = c.route.providerAccountId;
    attribution.providerType = c.route.providerAccount.providerType;
    attribution.upstreamModel = c.route.upstreamModelId;
    attribution.attempts = i + 1;
    attribution.failedCandidates = attribution.failedCandidates ?? [];
    let producedOutput = false;
    const attemptStart = Date.now();
    try {
      const routeOpts: StreamChatOptions = {
        ...opts,
        modelId: c.route.upstreamModelId,
        timeoutMs: opts.timeoutMs ?? c.route.timeoutMs,
      };
      for await (const ev of c.adapter.streamChat(c.ctx, routeOpts)) {
        if (ev.type === 'delta' || ev.type === 'tool-call-delta') producedOutput = true;
        yield ev;
      }
      producedOutput &&= true;
      // success: mark healthy + served (with this attempt's measured latency)
      void markRouteServed(c.route.id, c.route.providerAccountId, Date.now() - attemptStart);
      void recordDecision({
        requestId: opts.requestId,
        modelId: model.modelId,
        strategy,
        candidates,
        rejected,
        attribution,
        finalStatus: 'routed',
        latencyMs: Date.now() - started,
      });
      return;
    } catch (e) {
      const err = e instanceof ProviderError ? e : new ProviderError('provider_error', String((e as Error)?.message ?? e), { status: 502, retryable: true });
      lastError = err;
      emittedOutput = emittedOutput || producedOutput;
      const canFailover = !producedOutput && !emittedOutput && failoverWorthy(err) && i < candidates.length - 1;
      attribution.failedCandidates!.push({ routeId: c.route.id, reason: `${err.code}: ${err.message.slice(0, 160)}` });
      void markRouteFailed(c.route.id, c.route.providerAccountId, err.message, err.code === 'provider_auth');
      if (!canFailover) break;
      // fail over to the next eligible route; public model identity preserved
    }
  }

  void recordDecision({
    requestId: opts.requestId,
    modelId: model.modelId,
    strategy,
    candidates,
    rejected,
    attribution,
    finalStatus: 'failed',
    errorText: lastError ? `${lastError.code}: ${lastError.message}` : 'all routes exhausted',
    latencyMs: Date.now() - started,
  });
  throw lastError ?? new ProviderError('provider_error', 'All routes failed for this request.', { status: 502 });
}

/**
 * Non-streaming completion through the intelligent router (same eligibility,
 * scoring, failover and decision logging as streamChatRouted).
 */
export async function completeChatRouted(
  requestedModelId: string,
  opts: StreamChatOptions & { requestId: string; attribution: RouteAttribution },
  needs: { vision: boolean; tools: boolean } = { vision: false, tools: false }
): Promise<CompleteChatResult> {
  const attribution = opts.attribution;
  const resolved = await resolveModel(requestedModelId);
  if (!resolved) {
    throw new ProviderError('model_unavailable', `Model "${requestedModelId}" does not exist in this EmorAI installation.`, { status: 404 });
  }
  const model = resolved.model;
  const strategy = await currentRoutingStrategy();
  const req: ExecutionRequest = { requestId: opts.requestId, needs: { ...needs, streaming: false } };
  const { candidates, rejected } = await planCandidates(model, req, strategy);

  if (candidates.length === 0) {
    if (model.category === 'emorai') {
      throw new ProviderError(
        'model_unavailable',
        `Model "${model.modelId}" has no eligible route configured. Add or enable a route in Settings → Routes.`,
        { status: 501 }
      );
    }
    if (model.provider !== 'zai') {
      throw new ProviderError(
        'model_unavailable',
        `Model "${model.modelId}" routes to provider "${model.provider}", which is not configured on this installation.`,
        { status: 501 }
      );
    }
    attribution.routed = false;
    const started = Date.now();
    try {
      const result = await directComplete(model, opts);
      void recordDecision({
        requestId: opts.requestId, modelId: model.modelId, strategy,
        candidates: [], rejected, attribution: {}, finalStatus: 'direct', latencyMs: Date.now() - started,
      });
      return result;
    } catch (e) {
      void recordDecision({
        requestId: opts.requestId, modelId: model.modelId, strategy,
        candidates: [], rejected, attribution: {}, finalStatus: 'failed',
        errorText: String((e as Error)?.message ?? e), latencyMs: Date.now() - started,
      });
      throw e;
    }
  }

  attribution.routed = true;
  let lastError: ProviderError | null = null;
  const started = Date.now();
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    attribution.routeId = c.route.id;
    attribution.providerAccountId = c.route.providerAccountId;
    attribution.providerType = c.route.providerAccount.providerType;
    attribution.upstreamModel = c.route.upstreamModelId;
    attribution.attempts = i + 1;
    attribution.failedCandidates = attribution.failedCandidates ?? [];
    const attemptStart = Date.now();
    try {
      const result = await c.adapter.completeChat(c.ctx, {
        ...opts,
        modelId: c.route.upstreamModelId,
        timeoutMs: opts.timeoutMs ?? c.route.timeoutMs,
      });
      void markRouteServed(c.route.id, c.route.providerAccountId, Date.now() - attemptStart);
      void recordDecision({
        requestId: opts.requestId, modelId: model.modelId, strategy,
        candidates, rejected, attribution, finalStatus: 'routed', latencyMs: Date.now() - started,
      });
      return result;
    } catch (e) {
      const err = e instanceof ProviderError ? e : new ProviderError('provider_error', String((e as Error)?.message ?? e), { status: 502, retryable: true });
      lastError = err;
      attribution.failedCandidates!.push({ routeId: c.route.id, reason: `${err.code}: ${err.message.slice(0, 160)}` });
      void markRouteFailed(c.route.id, c.route.providerAccountId, err.message, err.code === 'provider_auth');
      // non-streaming: a thrown request produced no user-visible output →
      // failover is always safe when the error is retryable
      if (!failoverWorthy(err) || i >= candidates.length - 1) break;
    }
  }
  void recordDecision({
    requestId: opts.requestId, modelId: model.modelId, strategy,
    candidates, rejected, attribution, finalStatus: 'failed',
    errorText: lastError ? `${lastError.code}: ${lastError.message}` : 'all routes exhausted',
    latencyMs: Date.now() - started,
  });
  throw lastError ?? new ProviderError('provider_error', 'All routes failed for this request.', { status: 502 });
}

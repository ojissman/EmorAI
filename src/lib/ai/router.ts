// ─── Intelligent model router ────────────────────────────────────────────────
// Decides which authorized upstream route executes each request for a public
// EmorAI model, with eligibility verification, priority scoring, bounded
// failover, and a full admin-facing decision log.
//
// Flow (per request):
//   1. public model resolved upstream (registry + aliases — unchanged)
//   2. candidate routes loaded (enabled route + enabled account)
//   3. eligibility per route: known-bad health rejected, capability subset
//      verified, stored credentials must decrypt, adapter must exist, and
//      — when budgets are enforced — the account must be under its monthly
//      budget (ONE batched spend query for the whole plan, never per route)
//   4. score (strategy-aware): priority + account priority + health recency;
//      the cost strategy uses REAL per-MTok pricing (effective CostRate or
//      ModelConfig.pricing) — route.weight is no longer a cost signal
//   5. execute via the route's adapter under bounded concurrency (in-process
//      account+route slots — every attempt holds a lease released in finally,
//      including on consumer abort); on a retryable failure BEFORE any output
//      has been produced → fail over to the next eligible route (public model
//      identity is preserved); after output → surface the error (never
//      duplicate user-visible output or billing)
//   6. every decision logged to RoutingDecision; execution outcomes update
//      route + account health; the caller gets attribution for UsageRecord
//      (and therefore for CostLedger accounting + budget enforcement)
//
// LEGACY PATH: models with no routes (e.g. directly-exposed provider models
// like glm-5.3) execute exactly as before — the router delegates straight to
// the zai adapter with the registry modelId. Zero behavior change. The
// platform-managed zai account is deliberately NOT concurrency-enforced
// (its capacity is managed by the platform SDK environment, not by admin
// config); every stored-credential account IS enforced.

import { db } from '@/lib/db';
import { resolveModel } from '@/lib/model-registry';
import { getAdapterByType, adapterContextForAccount } from '@/lib/ai/providers';
import type { AIProviderAdapter, AdapterContext, StreamChatOptions, StreamEvent, CompleteChatResult } from '@/lib/ai/providers';
import type { ModelCapabilities, ModelInfo, RoutingStrategyName, AppSettings } from '@/lib/types';
import { DEFAULT_CAPABILITIES } from '@/lib/types';
import { DEFAULT_SETTINGS, getSettings } from '@/lib/settings';
import { ProviderError } from '@/lib/ai/zai-adapter';
import { acquireSlots, ConcurrencyExhaustedError, type SlotLease } from '@/lib/ai/concurrency';
import { budgetStatusMapFor, effectiveRatesForModel, alertBudgetExceededBatch, type AccountBudgetStatus } from '@/lib/billing';
import { addScaled, microToDecimalString, parseDecimalString, type ScaledDecimal } from '@/lib/money';

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
//   cost        — REAL pricing: blended (input + output) per-MTok price of the
//                 public model resolved per candidate account (effective
//                 CostRate overrides ModelConfig.pricing). Unknown pricing →
//                 NEUTRAL score + pricingKnown:false marker — never invented,
//                 and route.weight is never used as a fake cost signal.
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
  // cost strategy only: true when real pricing resolved for this candidate
  pricingKnown: boolean;
};

export type ExecutionRequest = {
  requestId: string;
  // capability requirements derived from the actual request
  needs: { vision: boolean; tools: boolean; streaming: boolean };
};

// ─── Settings (never throws — routing must survive settings failures) ────────

async function loadSettingsSafe(): Promise<AppSettings> {
  try {
    return await getSettings();
  } catch {
    // documented defaults (budget enforced, queue-mode concurrency) apply
    return DEFAULT_SETTINGS;
  }
}

/** The strategy configured by the administrator (AppSetting, default balanced). */
export async function currentRoutingStrategy(): Promise<RoutingStrategy> {
  const settings = await loadSettingsSafe();
  return settings.routingStrategy;
}

// ─── Eligibility + scoring ───────────────────────────────────────────────────

function routeCapabilities(route: RouteRow, modelCaps: ModelCapabilities): ModelCapabilities {
  const raw = route.capabilities as Partial<ModelCapabilities> | null;
  if (!raw || typeof raw !== 'object') return modelCaps;
  // explicit subset declared on the route; unspecified keys default OFF —
  // honest: a route only carries what was verified for it
  return { ...DEFAULT_CAPABILITIES, ...raw };
}

function eligible(
  route: RouteRow,
  model: ModelInfo,
  req: ExecutionRequest,
  budgets: Map<string, AccountBudgetStatus> | null
): { ok: boolean; reason?: string } {
  if (!route.enabled) return { ok: false, reason: 'route disabled' };
  if (!route.providerAccount.enabled) return { ok: false, reason: 'account disabled' };
  if (route.providerAccount.lastStatus === 'error') {
    return { ok: false, reason: `account failed last validation: ${(route.providerAccount.lastError ?? '').slice(0, 120)}` };
  }
  if (route.healthStatus === 'down') {
    return { ok: false, reason: `route marked down: ${(route.lastError ?? '').slice(0, 120)}` };
  }
  // budget pre-check (only injected when settings.budget.enforce): one
  // precomputed Map of accountId → over-budget, built with ONE batched query
  // in planCandidates — never N queries per route
  if (budgets) {
    const b = budgets.get(route.providerAccountId);
    if (b && b.overBudget && b.budgetMicro !== null) {
      return {
        ok: false,
        reason: `budget_exhausted: spent ${microToDecimalString(b.spentMicro)} of ${microToDecimalString(b.budgetMicro)} this month`,
      };
    }
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

/**
 * Blended per-MTok price (input + output) for one candidate route, exact
 * BigInt math. null ⇒ pricing unknown (never invented).
 */
function candidateCostBlend(
  priceByAccount: Map<string, { inputPerMTok: string; outputPerMTok: string }> | null,
  route: RouteRow
): ScaledDecimal | null {
  if (!priceByAccount) return null;
  const rate = priceByAccount.get(route.providerAccountId);
  if (!rate) return null;
  const inP = parseDecimalString(rate.inputPerMTok);
  const outP = parseDecimalString(rate.outputPerMTok);
  if (!inP || !outP) return null;
  return addScaled(inP, outP);
}

/** Deterministic route score (lower = preferred). Strategy-aware. */
function scoreRoute(route: RouteRow, strategy: RoutingStrategy, costBlend: ScaledDecimal | null): number {
  const base = route.priority * 100 + route.providerAccount.priority * 10;
  switch (strategy) {
    case 'priority':
      // pure configured order — no health/weight adjustments
      return base;
    case 'cost': {
      // REAL pricing only: blended (input+output) per-MTok price for THIS
      // public model on THIS account's effective rate (account-scoped CostRate
      // → model-wide CostRate → ModelConfig.pricing). Unknown pricing is
      // NEUTRAL (base score only, pricingKnown:false in the decision log) —
      // pricing is never invented and route.weight is not a cost signal.
      if (costBlend === null) return base;
      // float conversion is for ORDERING ONLY — money math stays in BigInt
      const blend = Number(costBlend.scaled) / 10 ** costBlend.scale;
      return Math.round(blend * 1000) + base; // cost dominates; priority breaks ties
    }
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
async function planCandidates(
  model: ModelInfo,
  req: ExecutionRequest,
  ctx: { strategy: RoutingStrategy; budgetEnforced: boolean }
): Promise<{
  candidates: Candidate[];
  rejected: Array<{ routeId: string; upstreamModel: string; reason: string }>;
}> {
  const routes = (await db.modelRoute.findMany({
    where: { publicModelId: model.modelId },
    include: { providerAccount: true },
    orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
  })) as unknown as RouteRow[];

  // budget pre-check: ONE batched ledger query for every account reachable
  // from this model's routes (never per route)
  let budgets: Map<string, AccountBudgetStatus> | null = null;
  if (ctx.budgetEnforced) {
    budgets = await budgetStatusMapFor(
      routes.map((r) => ({ id: r.providerAccountId, monthlyBudget: r.providerAccount.monthlyBudget })),
      true
    );
    // over-budget flip → critical AlertEvent (fire-and-forget; once per hour
    // per account — the guard lives in alertBudgetExceededBatch)
    const over = [...routes]
      .map((r) => ({ route: r, status: budgets!.get(r.providerAccountId) }))
      .filter((e) => e.status && e.status.overBudget && e.status.enforced && e.status.budgetMicro !== null);
    if (over.length > 0) {
      void alertBudgetExceededBatch(
        over.map((e) => ({
          accountId: e.route.providerAccountId,
          accountName: e.route.providerAccount.name,
          spentMicro: e.status!.spentMicro,
          budgetMicro: e.status!.budgetMicro!,
          currency: e.status!.currency,
        }))
      ).catch(() => undefined);
    }
  }

  // real pricing for the cost strategy: ONE CostRate query for the whole
  // model — account-scoped rates override the model-wide rate (which itself
  // falls back to ModelConfig.pricing inside effectiveRatesForModel)
  const rates =
    ctx.strategy === 'cost' ? await effectiveRatesForModel(model.modelId, model.pricing) : null;
  const priceByAccount: Map<string, { inputPerMTok: string; outputPerMTok: string }> | null = rates
    ? (() => {
        const m = new Map<string, { inputPerMTok: string; outputPerMTok: string }>();
        if (rates.modelWide) {
          const wide = { inputPerMTok: rates.modelWide.inputPerMTok, outputPerMTok: rates.modelWide.outputPerMTok };
          for (const r of routes) m.set(r.providerAccountId, wide);
        }
        for (const [accId, rate] of rates.accountRates) {
          m.set(accId, { inputPerMTok: rate.inputPerMTok, outputPerMTok: rate.outputPerMTok });
        }
        return m;
      })()
    : null;

  const candidates: Candidate[] = [];
  const rejected: Array<{ routeId: string; upstreamModel: string; reason: string }> = [];
  for (const route of routes) {
    const check = eligible(route, model, req, budgets);
    if (!check.ok) {
      rejected.push({ routeId: route.id, upstreamModel: route.upstreamModelId, reason: check.reason ?? 'ineligible' });
      continue;
    }
    let ctxAccount: AdapterContext;
    try {
      ctxAccount = adapterContextForAccount(route.providerAccount);
    } catch (e) {
      rejected.push({ routeId: route.id, upstreamModel: route.upstreamModelId, reason: `credentials undecryptable: ${String((e as Error)?.message ?? e).slice(0, 120)}` });
      continue;
    }
    const costBlend = candidateCostBlend(priceByAccount, route);
    candidates.push({
      route,
      adapter: getAdapterByType(route.providerAccount.providerType)!,
      ctx: ctxAccount,
      routeCaps: routeCapabilities(route, model.capabilities),
      score: scoreRoute(route, ctx.strategy, costBlend),
      pricingKnown: ctx.strategy !== 'cost' || costBlend !== null,
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
            // cost strategy honesty marker: false ⇒ no real pricing resolved
            pricingKnown: c.pricingKnown,
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

/** Maps a local concurrency exhaustion to its customer-facing shape. */
function concurrencyToProviderError(e: ConcurrencyExhaustedError): ProviderError {
  return new ProviderError('rate_limited', 'concurrency limit reached for account/route', {
    status: 503,
    retryable: true,
  });
}

// ─── Legacy direct path (models without routes) ──────────────────────────────

async function* directStream(model: ModelInfo, opts: StreamChatOptions): AsyncGenerator<StreamEvent> {
  // preserve the exact pre-router behavior: registry modelId straight to zai.
  // Deliberately NOT concurrency-enforced: the zai account is platform-managed
  // (credentialMode "platform" — capacity is governed by the platform SDK
  // environment, not by per-account admin limits).
  const { streamChat } = await import('@/lib/ai/zai-adapter');
  yield* streamChat({ ...opts, modelId: model.modelId, provider: model.provider });
}

async function directComplete(model: ModelInfo, opts: StreamChatOptions): Promise<CompleteChatResult> {
  // see directStream: platform-managed account — unenforced by design
  const { completeChat } = await import('@/lib/ai/zai-adapter');
  return completeChat({ ...opts, modelId: model.modelId, provider: model.provider });
}

// ─── Public execution API ────────────────────────────────────────────────────

export type RoutedStreamPlan = {
  model: ModelInfo;
  viaAlias: string | null;
  strategy: RoutingStrategy;
  routed: boolean;
  candidates: Array<{ routeId: string; upstreamModel: string; providerType: string; account: string; score: number; pricingKnown?: boolean }>;
  rejected: Array<{ routeId: string; upstreamModel: string; reason: string }>;
};

/**
 * Resolves a public model + its execution plan (candidates in score order).
 * Use when the caller needs the plan before streaming (e.g. capability gates).
 * Legacy models return routed=false and execute through the direct path.
 * Admin surface: resolves disabled models too (route previews must see them).
 */
export async function planExecution(requestedModelId: string): Promise<RoutedStreamPlan | null> {
  const resolved = await resolveModel(requestedModelId, { allowDisabled: true });
  if (!resolved) return null;
  const model = resolved.model;
  const settings = await loadSettingsSafe();
  const { candidates, rejected } = await planCandidates(
    model,
    { requestId: 'plan', needs: { vision: false, tools: false, streaming: true } },
    { strategy: settings.routingStrategy, budgetEnforced: settings.budget.enforce }
  );
  return {
    model,
    viaAlias: resolved.viaAlias,
    strategy: settings.routingStrategy,
    routed: candidates.length > 0,
    candidates: candidates.map((c) => ({
      routeId: c.route.id,
      upstreamModel: c.route.upstreamModelId,
      providerType: c.route.providerAccount.providerType,
      account: c.route.providerAccount.name,
      score: c.score,
      pricingKnown: c.pricingKnown,
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
  const settings = await loadSettingsSafe();
  const strategy = settings.routingStrategy;
  const req: ExecutionRequest = { requestId: opts.requestId, needs: { ...needs, streaming: true } };
  const { candidates, rejected } = await planCandidates(model, req, {
    strategy,
    budgetEnforced: settings.budget.enforce,
  });

  if (candidates.length === 0) {
    // EmorAI family models REQUIRE a configured eligible route — never
    // silently fall through to a direct upstream call. The rejection reasons
    // (budget_exhausted, disabled, capability gaps…) are ALWAYS recorded —
    // a no-candidate rejection is still a routing decision with an audit trail.
    if (model.category === 'emorai') {
      void recordDecision({
        requestId: opts.requestId, modelId: model.modelId, strategy,
        candidates: [], rejected, attribution: { ...attribution, routed: false },
        finalStatus: 'failed', errorText: 'no eligible route configured',
      });
      throw new ProviderError(
        'model_unavailable',
        `Model "${model.modelId}" has no eligible route configured. Add or enable a route in Settings → Routes.`,
        { status: 501 }
      );
    }
    // legacy direct path — zero behavior change for un-routed zai provider
    // models (glm-5.3-flash and friends; the dashboard default depends on it)
    if (model.provider !== 'zai') {
      void recordDecision({
        requestId: opts.requestId, modelId: model.modelId, strategy,
        candidates: [], rejected, attribution: { ...attribution, routed: false },
        finalStatus: 'failed', errorText: 'no eligible route to an authorized provider account',
      });
      throw new ProviderError(
        'model_unavailable',
        `Model "${model.modelId}" (provider "${model.provider}") has no route to an authorized provider account — adopt it via Provider discovery (Settings → Providers) or configure a route in Settings → Routes.`,
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

  // routed path: try candidates in order; fail over only before first output.
  // A sustained rate limit is account-wide upstream — retrying OTHER routes on
  // the SAME account just restarts the full backoff storm against the same
  // limit, so once an account comes back rate-limited (or exhausts its
  // ACCOUNT concurrency slot) its remaining routes are skipped and only
  // genuinely different accounts are tried.
  attribution.routed = true;
  let emittedOutput = false;
  let lastError: ProviderError | null = null;
  const rateLimitedAccounts = new Set<string>();
  const started = Date.now();

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (rateLimitedAccounts.has(c.route.providerAccountId)) {
      attribution.failedCandidates!.push({
        routeId: c.route.id,
        reason: 'rate_limited: skipped — same account already came back rate-limited',
      });
      continue;
    }
    attribution.routeId = c.route.id;
    attribution.providerAccountId = c.route.providerAccountId;
    attribution.providerType = c.route.providerAccount.providerType;
    attribution.upstreamModel = c.route.upstreamModelId;
    attribution.attempts = (attribution.attempts ?? 0) + 1;
    attribution.failedCandidates = attribution.failedCandidates ?? [];
    let producedOutput = false;
    let lease: SlotLease | null = null;
    const attemptStart = Date.now();
    try {
      // Concurrency gate: bounded in-process slots for the account (and this
      // route when maxConcurrency > 0). Lease release is GUARANTEED by the
      // finally below — it runs on success, on error, AND on consumer abort
      // (the for-await return/throw propagates into the finally).
      lease = await acquireSlots({
        accountId: c.route.providerAccountId,
        accountMax: c.route.providerAccount.maxConcurrency,
        routeId: c.route.id,
        routeMax: c.route.maxConcurrency,
      });
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
      } finally {
        lease?.release();
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
      if (e instanceof ConcurrencyExhaustedError) {
        // local capacity, not upstream health: no route/account health marks,
        // but the candidate is recorded and failover is allowed (the next
        // route may have free capacity)
        const err = concurrencyToProviderError(e);
        lastError = err;
        attribution.failedCandidates!.push({
          routeId: c.route.id,
          reason: `concurrency_exhausted: ${e.message}`,
        });
        if (e.keys.some((k) => k.startsWith('account:'))) rateLimitedAccounts.add(c.route.providerAccountId);
        if (i < candidates.length - 1) continue;
        break;
      }
      const err = e instanceof ProviderError ? e : new ProviderError('provider_error', String((e as Error)?.message ?? e), { status: 502, retryable: true });
      lastError = err;
      emittedOutput = emittedOutput || producedOutput;
      const canFailover = !producedOutput && !emittedOutput && failoverWorthy(err) && i < candidates.length - 1;
      attribution.failedCandidates!.push({ routeId: c.route.id, reason: `${err.code}: ${err.message.slice(0, 160)}` });
      if (err.code === 'rate_limited') rateLimitedAccounts.add(c.route.providerAccountId);
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
  const settings = await loadSettingsSafe();
  const strategy = settings.routingStrategy;
  const req: ExecutionRequest = { requestId: opts.requestId, needs: { ...needs, streaming: false } };
  const { candidates, rejected } = await planCandidates(model, req, {
    strategy,
    budgetEnforced: settings.budget.enforce,
  });

  if (candidates.length === 0) {
    // rejection reasons are always recorded — audit trail for budget/disabled/
    // capability rejections even when no candidate ever ran
    if (model.category === 'emorai') {
      void recordDecision({
        requestId: opts.requestId, modelId: model.modelId, strategy,
        candidates: [], rejected, attribution: { ...attribution, routed: false },
        finalStatus: 'failed', errorText: 'no eligible route configured',
      });
      throw new ProviderError(
        'model_unavailable',
        `Model "${model.modelId}" has no eligible route configured. Add or enable a route in Settings → Routes.`,
        { status: 501 }
      );
    }
    if (model.provider !== 'zai') {
      void recordDecision({
        requestId: opts.requestId, modelId: model.modelId, strategy,
        candidates: [], rejected, attribution: { ...attribution, routed: false },
        finalStatus: 'failed', errorText: 'no eligible route to an authorized provider account',
      });
      throw new ProviderError(
        'model_unavailable',
        `Model "${model.modelId}" (provider "${model.provider}") has no route to an authorized provider account — adopt it via Provider discovery (Settings → Providers) or configure a route in Settings → Routes.`,
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
  const rateLimitedAccounts = new Set<string>();
  const started = Date.now();
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (rateLimitedAccounts.has(c.route.providerAccountId)) {
      attribution.failedCandidates!.push({
        routeId: c.route.id,
        reason: 'rate_limited: skipped — same account already came back rate-limited',
      });
      continue;
    }
    attribution.routeId = c.route.id;
    attribution.providerAccountId = c.route.providerAccountId;
    attribution.providerType = c.route.providerAccount.providerType;
    attribution.upstreamModel = c.route.upstreamModelId;
    attribution.attempts = (attribution.attempts ?? 0) + 1;
    attribution.failedCandidates = attribution.failedCandidates ?? [];
    let lease: SlotLease | null = null;
    const attemptStart = Date.now();
    let result: CompleteChatResult | null = null;
    try {
      lease = await acquireSlots({
        accountId: c.route.providerAccountId,
        accountMax: c.route.providerAccount.maxConcurrency,
        routeId: c.route.id,
        routeMax: c.route.maxConcurrency,
      });
      try {
        result = await c.adapter.completeChat(c.ctx, {
          ...opts,
          modelId: c.route.upstreamModelId,
          timeoutMs: opts.timeoutMs ?? c.route.timeoutMs,
        });
      } finally {
        lease?.release(); // guaranteed on success, error, and caller abort
      }
      // success: mark healthy + served, log the routed decision
      void markRouteServed(c.route.id, c.route.providerAccountId, Date.now() - attemptStart);
      void recordDecision({
        requestId: opts.requestId, modelId: model.modelId, strategy,
        candidates, rejected, attribution, finalStatus: 'routed', latencyMs: Date.now() - started,
      });
      return result;
    } catch (e) {
      if (e instanceof ConcurrencyExhaustedError) {
        // local capacity, not upstream health; failover to the next route is
        // allowed (it may have free capacity)
        const err = concurrencyToProviderError(e);
        lastError = err;
        attribution.failedCandidates!.push({
          routeId: c.route.id,
          reason: `concurrency_exhausted: ${e.message}`,
        });
        if (e.keys.some((k) => k.startsWith('account:'))) rateLimitedAccounts.add(c.route.providerAccountId);
        if (i < candidates.length - 1) continue;
        break;
      }
      const err = e instanceof ProviderError ? e : new ProviderError('provider_error', String((e as Error)?.message ?? e), { status: 502, retryable: true });
      lastError = err;
      attribution.failedCandidates!.push({ routeId: c.route.id, reason: `${err.code}: ${err.message.slice(0, 160)}` });
      if (err.code === 'rate_limited') rateLimitedAccounts.add(c.route.providerAccountId);
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

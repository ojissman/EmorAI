# Task 3 — Provider-model execution + real concurrency enforcement + budget/cost accounting

Agent: provider-execution/concurrency/budget builder (Priorities 1 + 3 + 4)
Status: COMPLETE — `bun test tests/unit/concurrency.test.ts tests/unit/money.test.ts` 26/26 green; `bun run lint` 0 errors / 0 warnings in my files (33 pre-existing warnings all in scripts/test-gateway.ts); `bunx tsc --noEmit` clean for every file I touched; dev.log shows my routes compiling (ops/metrics, ops/budgets, routes GET/POST → 401 admin_auth_required as designed once guarded; /api/chat compiles, 401 is the guard agent's expected state); billing pipeline smoke-tested against the dev DB with full cleanup (cost math, ledger idempotency, rate precedence, unpriced honesty, budget map, alert dedup all verified live).

## Files created

| File | Purpose |
|---|---|
| `src/lib/money.ts` | Pure BigInt decimal arithmetic: parseDecimalString (scale ≤ 12), toScaled, addScaled, compareScaled, formatScaled, computeCostMicro (tokens × price-per-MTok → micro units, floored, null = unknown), microToDecimalString. No imports — unit-testable. |
| `src/lib/ai/concurrency.ts` | In-process semaphore registry keyed `account:<id>` / `route:<id>`. acquireSlots acquires ALL required slots atomically (both-or-neither ⇒ no account/route deadlock), FIFO waiting queue (earliest-fitting grant — queue head never stalls unrelated accounts), bounded by settings `concurrency.queueWaitMs` (default 30 s), reject mode throws immediately, ConcurrencyExhaustedError carries keys/waitedMs/queueDepth/mode, concurrencySnapshot() for ops. Settings via getSettings() with ≤5 s cache, never throws (defaults queue/30 s). Test hooks (`__setConcurrencyConfigResolverForTests`, `__resetConcurrencyStateForTests`) keep unit tests DB-free. |
| `src/lib/billing.ts` | Cost accounting: recordCostForUsage (rate precedence: account-scoped CostRate → model-wide CostRate → ModelConfig.pricing; idempotent CostLedger create on unique usageRecordId — first write wins on duplicate retries; no rate ⇒ priced=false with NULL costs, NEVER zero; post-record budget alert); effectiveRatesForModel (ONE query); monthlySpendMicroForAccount / budgetStatusForAccount / budgetStatusMapFor (ONE ledger query for many accounts); alertBudgetExceededBatch (critical AlertEvent, once per hour per account via one guard query + client-side meta.accountId filter — SQLite Prisma cannot filter JSON columns). |
| `src/app/api/ops/metrics/route.ts` | GET (requireAdmin): concurrencySnapshot + RoutingDecision groupBy last 24 h (total/routed/failed/direct) + provider accounts (lastStatus, requestCount). |
| `src/app/api/ops/budgets/route.ts` | GET (requireAdmin): per budgeted account {budget, spentMicro (string), spent, overBudget, pricedCount, unpricedCount} + totals, via budgetStatusMapFor (one query). |
| `tests/unit/money.test.ts` | 15 tests: parse/edge rejection, rescale, add/compare exactness, format, cost micro math (floor dust, unknown ⇒ null), the 0.1+0.2 float-poison case exact in micro. |
| `tests/unit/concurrency.test.ts` | 11 tests: unlimited-null lease, snapshot, idempotent release, no over-grant under parallelism, FIFO order (no leap-frog), queue timeout (waitedMs), queue head never stalls unrelated accounts, reject mode, account+route atomic slots, unique-waiter totals. |

## Files modified

| File | Change |
|---|---|
| `src/app/api/routes/route.ts` | requireAdmin on GET+POST; emorai-only restriction REMOVED (any registered ModelConfig routable); account providerType must have a registered adapter → 400 unknown_provider; duplicate check kept. |
| `src/app/api/routes/[id]/route.ts` | requireAdmin on PATCH+DELETE (all methods present). |
| `src/app/api/providers/[id]/discover/route.ts` | requireAdmin on POST; adoption creates ModelConfig with **enabled:false** (adoption ≠ publication — customers cannot resolve disabled models) AND auto-creates the ModelRoute {upstreamModelId=pick.modelId, capabilities=verified subset, priority 0, enabled true} idempotently; response includes `routes` (created vs existing) + honest note. |
| `src/lib/model-registry.ts` | resolveModel(requested, {allowDisabled}) — customer resolution EXCLUDES disabled models (exact, case-insensitive, and alias paths all filtered); admin listing (listModels) still returns everything; planExecution passes allowDisabled so route previews work on unpublished models. |
| `src/lib/usage.ts` | recordUsage captures the created UsageRecord row and fire-and-forgets recordCostForUsage with full attribution (routeId/providerAccountId/servedModel/tokens) + budget alert; RecordUsageInput already had the attribution fields so all callers compile unchanged. |
| `src/lib/ai/router.ts` | See below. |

## router.ts behavior changes (exact)

- **Settings once per request**: streamChatRouted/completeChatRouted/planExecution read settings via loadSettingsSafe() (getSettings with DEFAULT_SETTINGS fallback — routing survives settings/DB failure) and pass strategy + budgetEnforced into planCandidates; currentRoutingStrategy() still exported.
- **Budget eligibility (pre-check)**: when settings.budget.enforce, planCandidates builds a Map accountId → AccountBudgetStatus with ONE batched CostLedger query (budgetStatusMapFor — never N queries per route); eligible() rejects over-budget accounts with reason `budget_exhausted: spent X of Y` (decimal strings). Over-budget flip fires alertBudgetExceededBatch (critical AlertEvent, once/hour/account) fire-and-forget.
- **Cost strategy = REAL pricing**: ONE effectiveRatesForModel query per plan; per candidate, blend = inputPerMTok + outputPerMTok (exact BigInt via money.addScaled); score = round(blend × 1000) + base; unknown pricing ⇒ NEUTRAL (base score) + `pricingKnown:false` marker in the candidates JSON (accepted entries now carry pricingKnown). route.weight is NO LONGER a cost signal (kept only in balanced as before). Strategy comment block updated honestly.
- **Concurrency enforcement**: every routed attempt acquires lease = acquireSlots({accountId, accountMax, routeId, routeMax}) and releases it in a finally that wraps the adapter call — runs on success, on error, AND on consumer abort (for-await return/throw propagates into the finally; complete path same via try/finally). ConcurrencyExhaustedError → ProviderError('rate_limited', 'concurrency limit reached for account/route', {status: 503, retryable: true}), failedCandidates reason `concurrency_exhausted: <detail>`, NO route-health marks (local capacity, not upstream health), failover to the next route allowed; if the exhausted key is the ACCOUNT slot the account joins rateLimitedAccounts so its remaining routes are skipped instead of each waiting the full queue timeout.
- **Legacy direct path unchanged for zai** (glm-5.3-flash etc.); deliberately NOT concurrency-enforced (platform-managed account — documented). Non-zai provider models with no routes now get an actionable 501: adopt via Provider discovery or Routes admin.
- planExecution resolves with allowDisabled (admin surface); RoutedStreamPlan candidates carry pricingKnown.

## Concurrency semantics summary

Acquire: account slot (maxConcurrency > 0) + route slot (routeMax > 0) granted ATOMICALLY (both or neither ⇒ no deadlock between account/route pairs). Limits 0 = unlimited (key untracked). Queue mode: FIFO waiters granted in enqueue order among those that fit (head-of-line stalls avoided); wait bounded by queueWaitMs → ConcurrencyExhaustedError(keys, waitedMs, queueDepth, mode). Reject mode: any full slot throws immediately with queue-depth info. Release: idempotent, frees all slots, wakes the queue. Lease held across the whole adapter attempt only (acquire → execute → release in finally). Direct zai path unenforced by design. In-process only (single server process is the documented deployment).

## Budget/cost flow

Pre-check (router): one batched ledger query per plan → ineligible routes with budget_exhausted reason + alert on flip (hour guard). Execution → UsageRecord (attribution) → fire-and-forget recordCostForUsage → rate resolution (account CostRate → model CostRate → ModelConfig.pricing) → exact BigInt micro costs → CostLedger upsert-idempotent on usageRecordId (first write wins; duplicate retry returns the original result) → post-record budget check → alert if newly over (hour guard). No rate ⇒ priced=false + NULL costs (unknown stays unknown). Unpriced rows counted but excluded from spend sums (budget = floor, not ceiling — documented). Currency from rate; mixed-currency aggregation out of scope (documented in billing.ts + budgets endpoint note).

## Verification evidence

- `bun test tests/unit/concurrency.test.ts tests/unit/money.test.ts` → 26 pass / 0 fail / 110 expect() calls.
- `bun run lint` → 0 errors; all 33 warnings are pre-existing scripts/test-gateway.ts lines (my files: zero findings).
- `bunx tsc --noEmit` → zero diagnostics in my files (BigInt literals converted to BigInt() constructor calls to stay clean under the project's ES2017 tsconfig target; tests use `/// <reference types="bun-types" />` for the bun:test module).
- dev.log: `GET /api/ops/metrics 401 (compile 98ms)`, `GET /api/ops/budgets 401`, `GET+POST /api/routes 401`, `POST /api/chat 401` (guard agent's expected state) — all compiled with no errors; the only dev.log warnings are the SSRF agent's in-progress `@/lib/net/url-policy` module-not-found lines (their files, not mine).
- Live DB smoke (fully cleaned up): 1000/2000 tokens at 1.50/3.00 per MTok → totalCost "0.007500" USD; duplicate retry → still exactly 1 CostLedger row (unique-violation path); unpriced model → priced=false, NULL costs; budgetStatusMapFor spentMicro 7500n with 0.000001 budget → overBudget; alertBudgetExceededBatch twice → exactly 1 AlertEvent (dedup) with correct message.

## Coordination notes / limitations

- In-process semaphores only: multi-process deployments would need a shared store (documented in concurrency.ts).
- Budget spend is a floor: unpriced usage (no rate) cannot be summed honestly — counted separately, excluded from enforcement totals.
- Mixed-currency ledgers: sums report the first-seen currency; multi-currency aggregation out of scope (documented).
- AlertEvent dedup is best-effort (hour window; concurrent flips within the window race is accepted — one extra alert at worst).
- route.maxConcurrency semantics: DB convention "0 = account default" maps to no route-specific bound (account slot still enforced when account.maxConcurrency > 0).
- The zai platform account is unenforced for concurrency by explicit design decision (task instruction).
- Integration verification of full chat-through-router runtime is deferred to integration tests per task instructions (guard agent's 401s are expected until admin session flows exist).

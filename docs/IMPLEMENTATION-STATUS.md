# EmorAI — Implementation Status

Honest, verifiable status of the multi-provider platform transformation.
Date: 2026-11-11. Everything listed as **verified** was exercised with real
upstream executions (no mocks) — see "Evidence" per section.

## Phase 0 — Project audit ✅
Audited the real codebase before any change: single-page app (chat/studio/
agents/developer views), OpenAI+Anthropic compatible gateway (`/api/v1/*`,
root `/v1` mirrors), DB-backed model registry, hashed API keys, per-request
usage accounting, Z.ai execution in `src/lib/ai/zai-adapter.ts` + `media.ts`.

## Phase 1 — Provider abstraction ✅ (verified by E2E + regression suite)
- `AIProviderAdapter` contract: `src/lib/ai/providers/types.ts`
- Adapters: `zai.ts` (wraps the hardened legacy layer — retry/backoff, tool
  name round-trip, vision, web search), `openai-compat.ts` (OpenAI/DeepSeek/
  Mistral/Groq/vLLM/Ollama/self-hosted), `anthropic-compat.ts`.
- Registry: `src/lib/ai/providers/index.ts` — adapter per providerType +
  per-account credential resolution.
- Legacy behavior preserved: every pre-existing consumer still works
  (33/33 gateway regression scenarios pass).

## Phase 2 — Database + provider accounts ✅ (verified live)
- New tables (additive migration, `prisma db push`, zero data loss):
  `ProviderAccount`, `ModelRoute`, `RoutingDecision`; extended
  `ModelConfig` (category/lifecycle/generation/pricing) and
  `UsageRecord` (routeId/providerAccountId).
- Credential encryption at rest: AES-256-GCM (`src/lib/crypto.ts`),
  master key from `EMORAI_MASTER_KEY` env; **fails securely** when the key
  is absent (stored-credential accounts cannot be created — verified via API).
- Platform zai account requires no stored secret (SDK-managed).
- Admin API: `/api/providers` CRUD + `/validate` (real health check: 356 ms)
  + `/discover` (honest 501 for providers without a listing API).

## Phase 3 — Model registry ✅ (verified)
- Unified EmorAI family seeded: **emor-5.3, emor-5.2, emor-5.1**
  (category `emorai`, generation, lifecycle, honest capabilities copied from
  probe-backed upstream rows; context window = MIN across routes; pricing
  left UNCONFIGURED — never invented).
- Provider models remain Category B (`glm-*` rows, unchanged).
- Model catalogue UI shows EmorAI badges + grouped sections.
- Discovery for OpenAI-compatible providers via `POST /api/providers/[id]/discover`
  with explicit admin `adopt` (no auto-publication).

## Phase 4 — Intelligent routing ✅ (verified with real executions)
`src/lib/ai/router.ts`:
- Eligibility: route+account enabled, known-bad health rejected, capability
  subset verified, credentials decryptable, adapter exists.
- Scoring: priority → account priority → health recency → weight
  ("balanced" strategy; failover preserves public model identity).
- Bounded failover: only retryable errors, only before first output token
  (never duplicates user-visible output/billing).
- Decision log: every routed request writes `RoutingDecision`
  (candidates, rejections, selected route, attempts, outcome).
- Usage attribution: `routeId`/`providerAccountId` on every `UsageRecord`
  through both protocols and the dashboard chat.
- Legacy path: un-routed provider models execute exactly as before
  (`finalStatus: direct` in decisions).

## Phase 5 — Public API ✅ (verified)
Both gateways now execute through the router with identical public contracts:
`POST /api/v1/chat/completions`, `POST /api/v1/messages`, `GET /api/v1/models`
(lists the emor family), root `/v1` mirrors, streaming, tools, usage — all
regression-tested. `emorai_requested_model` transparency field preserved.

## Phases 6-9 — partially implemented / pending (honest)
- **Customer/organization/billing entities: NOT started** (single-owner
  installation preserved; multi-tenancy is a future phase).
- Pricing fields exist (DB + admin edit) but no cost computation or billing.
- Self-hosted adapter ready (`self-hosted` providerType); needs a real
  endpoint + key to activate — architecture verified by code, not by live run.
- Background jobs (scheduled health checks/sync) not yet built; explicit admin
  "Validate" provides health checks today.
- Subscription plans, quotas UI, audit logs beyond usage/decisions: pending.

## Evidence (all real, reproducible)
- `bun run scripts/test-routing.ts` → **33/33** — full chain: registry →
  route → router → real Z.ai execution → usage attribution → decision log;
  streaming; Anthropic protocol; legacy regression.
- `bun run scripts/test-gateway.ts` → **33/33** (14 pre-existing scenarios).
- Browser E2E: model selector → Emor-5.3 → real chat reply
  (`BROWSER-E2E-OK`) with honest served-model disclosure + usage row
  carrying routeId/providerAccountId.
- `bun run lint` → 0 errors. `bunx tsc --noEmit` → 0 errors in project src
  (pre-existing example/skill script errors excluded).

## Configuration required
- `EMORAI_MASTER_KEY` (≥16 chars) — enables encrypted credential storage
  for non-zai providers. Without it the platform still runs on the
  platform-managed zai account; adding stored-credential providers fails
  with a clear message (by design).
- Real upstream API key per external provider account (entered once via
  Settings → Providers; encrypted, never displayed again).

## Known gaps / outstanding
1. `EMORAI_MASTER_KEY` not yet set in this environment (banner shown in UI).
2. OpenAI-compat + Anthropic-compat adapters implemented and lint/type-clean
   but **not exercised against a live external provider** (no credentials in
   this environment) — activation requires a real account.
3. Discovery UI button not wired in Providers tab (API exists; Models-tab
   probe covers zai discovery today).
4. Vision-capable route for the EmorAI family not configured (upstream
   vision model glm-4.6v-flash exists; add a route with `vision: true`
   capabilities to enable — union-capability recompute then applies).
5. Settings "Provider" tab was relabeled "Security" (content unchanged) to
   disambiguate from the new "Providers" tab.

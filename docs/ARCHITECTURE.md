# EmorAI — Architecture: Providers, Routing, Models

## Execution flow (one request)

```
customer request (OpenAI / Anthropic / dashboard)
  → authenticate EmorAI API key (scopes, limits, allowlist)
  → resolveModel(requestedId)          [registry + aliases, transparent]
  → router.planCandidates(model)       [eligibility + scoring]
        route enabled? account enabled? health known-bad?
        capability subset (vision/tools/streaming)?
        credentials decryptable? adapter registered?
        score = route.priority*100 + account.priority*10
                − health bonuses + weight penalty
  → adapter.streamChat/completeChat(account ctx, upstream modelId)
        failover: retryable errors, BEFORE first output token only,
        next eligible route; public model identity preserved
  → normalize response (protocol layers unchanged)
  → recordUsage(routeId, providerAccountId, …)
  → RoutingDecision row (candidates, rejections, selection, outcome)
```

Legacy path: models with no routes (provider-category, e.g. glm-5.3-flash)
execute directly against their provider exactly as before
(`finalStatus: direct`). EmorAI-family models with no eligible route fail
honestly with 501 instead of silently falling through.

## Key modules

| Module | Role |
|---|---|
| `src/lib/ai/providers/types.ts` | `AIProviderAdapter` contract + normalized request/response types |
| `src/lib/ai/providers/zai.ts` | Z.ai adapter (wraps the hardened legacy layer; platform credentials) |
| `src/lib/ai/providers/openai-compat.ts` | OpenAI-wire-compatible adapter + `self-hosted` variant |
| `src/lib/ai/providers/anthropic-compat.ts` | Anthropic Messages API adapter (both directions translated) |
| `src/lib/ai/providers/index.ts` | adapter registry + per-account credential resolution (server-side only) |
| `src/lib/ai/router.ts` | eligibility, scoring, bounded failover, decision logging, attribution |
| `src/lib/crypto.ts` | AES-256-GCM credential encryption (master key from env) |
| `src/lib/model-registry.ts` | catalogue source of truth (ModelConfig) + seeding/probes |

## Data model (see prisma/schema.prisma for full detail)

- `ModelConfig` — public catalogue row; `category` distinguishes the official
  EmorAI family (`emorai`) from directly-exposed provider models (`provider`);
  `lifecycle`, `generation`, `pricing` (admin-configured, never invented).
- `ProviderAccount` — authorized upstream account; `credentialMode`
  `platform` (zai, no stored secret) or `stored` (AES-256-GCM ciphertext).
- `ModelRoute` — many-to-many public model → (account, upstream model);
  priority, capability subset, timeout, weight, health.
- `RoutingDecision` — admin-facing decision log per routed request.
- `UsageRecord` — per-request accounting incl. `routeId`/`providerAccountId`.

## How to add a provider (Generation 1/2)

1. Settings → Providers → Add provider (name, type, base URL, API key).
   Requires `EMORAI_MASTER_KEY` in the environment (else the API refuses —
   by design). Types: `openai`, `anthropic`, `self-hosted`, `zai` (platform).
2. Validate (real health call). Optional: Discover models → adopt selected.
3. Add a route: public model (emorai category) + account + upstream model ID
   + priority. Requests to the public model now flow through the router.

Adding a NEW provider type in code: implement `AIProviderAdapter`
(`src/lib/ai/providers/`), register it in `index.ts` — nothing else changes.

## Environment variables

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | SQLite path (existing) |
| `EMORAI_MASTER_KEY` | ≥16 chars; master key for credential encryption. Generate: `openssl rand -base64 32`. Fails securely when absent. |
| `GATEWAY_BASE` | optional, test scripts only |

## Scripts

| Script | Purpose |
|---|---|
| `bun run scripts/seed-emor-family.ts` | idempotent EmorAI family + zai account + routes seed |
| `bun run scripts/test-routing.ts` | routing E2E (real upstream executions) |
| `bun run scripts/test-gateway.ts` | full gateway regression (14 scenarios) |
| `bun run scripts/model-availability-probe.ts` | honest availability probing (zai) |

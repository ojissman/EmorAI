# EmorAI

**Intelligence Without Limits.**

EmorAI is a production-quality, single-owner personal AI platform **and a universal AI provider gateway**: a ChatGPT-style dashboard powered by real Z.ai GLM integration, plus an OpenAI-compatible *and* Anthropic-compatible developer API that external coding agents (ZCode, Claude Code, OpenClaw/AutoClaw, …) can plug into exactly like OpenAI or Anthropic.

---

## Feature overview

### Dashboard
- ChatGPT-style UI: collapsible sidebar (icon rail on desktop, drawer on mobile), new chat, conversation history, search
- Conversations: pin, rename, delete, organize into **folders/projects**, auto-generated titles
- Chat engine: **true SSE streaming**, markdown + GFM tables, syntax-highlighted code blocks with copy, copy/edit user messages, regenerate, **stop generation** (partials are persisted), retry with error surfacing
- Model selector with capability badges (vision / reasoning / tools / JSON), free-tier prioritisation, honest availability status
- Attachments: images (vision models) and documents (PDF/text/code) with server-side text extraction
- **Web search** tool (Z.ai `web_search`) with inline citations and source chips
- Reasoning-trace display for models that emit `reasoning_content`
- Conversation summarization on demand
- Usage dashboard (requests, tokens, 14-day chart, per-model breakdown)
- Light/dark/system themes, responsive layouts, keyboard-accessible menus

### Universal AI provider gateway (`/api/v1` + `/v1`)

EmorAI is a **drop-in AI provider** for external applications. One gateway, two wire protocols, real protocol translation (not a rename):

| Protocol | Endpoint | Description |
| --- | --- | --- |
| OpenAI | `POST /api/v1/chat/completions` | Chat completions, streaming SSE or blocking, **tool calling round-trips**, vision parts |
| OpenAI | `GET /api/v1/models` | Model list with capabilities, context windows, aliases, availability |
| OpenAI | `GET /api/v1/models/{id}` | Model retrieve |
| Anthropic | `POST /api/v1/messages` | **Full Anthropic Messages API**: content blocks, system prompts, `tool_use`/`tool_result` round-trips, `input_json_delta` streaming, proper `stop_reason` semantics |
| Anthropic | `POST /api/v1/messages/count_tokens` | Token estimation (Claude Code calls this) |
| OpenAI | `GET /api/v1/usage` | Usage report for the presenting key |
| Media | `/api/v1/images/generations`, `/api/v1/audio/speech`, `/api/v1/videos/generations` | Images, speech, video |

**Base URLs** (all work concurrently):
- OpenAI-compatible: `{origin}/api/v1` — also `{origin}` (root `/v1/*` mirror for clients that append `/v1/…` themselves)
- Anthropic-compatible: `{origin}/api` — also `{origin}` (root `/v1/*` mirror). Claude Code: `ANTHROPIC_BASE_URL={origin}/api`

**Authentication**: `Authorization: Bearer emr_…` (OpenAI-style) **or** `x-api-key: emr_…` (Anthropic-style) — both accepted on every endpoint. CORS is open on gateway routes (Bearer keys, no ambient credentials).

### Model registry
- Ships with GLM-5.3, GLM-5.3-Flash (default), GLM-4.7-Flash, GLM-4.5-Flash, GLM-4.6V-Flash — every ID verified against the live gateway
- Per-model metadata: context window, max output tokens, capabilities, streaming support, health status
- **Admin-configured aliases** (e.g. `claude-sonnet-4-5` → `glm-5.3-flash`) — transparent: aliases are listed in `/v1/models` and responses report the actual served model. Nothing is silently rerouted; unknown IDs return 404 with the available list
- **Discover availability**: one-click spaced probing of the whole registry records what the provider gateway *actually serves* (`last_served_model`)
- No silent model switching: errors (quota, disabled, unavailable) are shown verbatim
- Provider column (`zai` today) makes future provider adapters a drop-in extension

### API key management
- Generate cryptographically secure keys (`emr_<48 hex>`) — **SHA-256 hash stored, plaintext shown exactly once**
- **Permission scopes**: `chat`, `tools`, `vision`, `media`, `models`, `usage` — enforced per request
- **Per-key limits**: rate limit override, monthly request limit, monthly token limit, allowed-models list
- Request counts, last-used timestamps, monthly usage monitoring
- Revoke / restore / delete; full request logs with protocol, endpoint, status code, latency

### EmorAI API & Integrations dashboard section
- Dual base URLs with copy buttons, integration status, available model list
- **Integration guides**: ZCode (OpenAI + Anthropic format), Claude Code (env vars + settings.json), OpenClaw/AutoClaw, generic agents — each with copyable snippets
- Live playground for both protocols (OpenAI SSE and Anthropic event rendering)
- Usage statistics + **request logs** (filter by protocol, status pills, endpoint breakdown)
- API reference for every endpoint including the Anthropic protocol

### Security notes
- Provider (Z.ai) credentials live **server-side only** (`.z-ai-config` or gateway environment). They are never sent to the browser, never embedded in client code, and never exposed to external applications — external apps authenticate with EmorAI keys only
- EmorAI API keys are hashes; only the dashboard can mint them
- Per-key rate limiting (sliding window), request validation (zod), hard request timeouts, provider retry with backoff (never bypassing upstream limits — repeated 429s surface honestly)
- Usage logging without secrets
- Cross-origin mutating requests to the dashboard API are rejected by an origin guard (`src/proxy.ts`); gateway routes use Bearer/x-api-key tokens (CSRF-inapplicable)
- **This is a single-owner installation.** Generated keys share one provider quota; add an auth layer (e.g. NextAuth) before multi-user or public deployment

## Tech stack
- Next.js 16 (App Router) · React 19 · TypeScript
- Tailwind CSS 4 + shadcn/ui (New York) + Lucide icons
- Prisma ORM (SQLite here — portable to PostgreSQL by swapping the datasource)
- Zustand (UI state) · TanStack Query (server state) · Zod (validation)
- `z-ai-web-dev-sdk` (server-side only) for GLM chat/vision/web-search

## Getting started

```bash
bun install
bun run db:push      # sync Prisma schema
bun run dev          # http://localhost:3000
```

### Environment / configuration
| Item | Where | Notes |
| --- | --- | --- |
| `DATABASE_URL` | `.env` | `file:/home/z/my-project/db/custom.db` in this sandbox. For production PostgreSQL: set `provider = "postgresql"` in `prisma/schema.prisma` and a `postgresql://…` URL. |
| Z.ai credentials | `/etc/.z-ai-config` (or project/home dir) | `{"baseUrl": "...", "apiKey": "..."}`. Resolved server-side by the SDK. Never expose publicly. |
| `EMORAI_MASTER_KEY` | `.env` | ≥16 chars; master key for provider-credential encryption at rest (AES-256-GCM). Generate: `openssl rand -base64 32`. While unset, adding stored-credential provider accounts (OpenAI-compatible / Anthropic / self-hosted) is refused — by design; the platform zai account keeps working. |
| Uploads | `db/uploads/` | Stored on disk; metadata in the `FileMetadata` table. 10 MB per file limit. |

### Multi-provider platform (intelligent routing)
EmorAI now runs as a provider-independent platform with its own unified model
family (`emor-5.3`, `emor-5.2`, `emor-5.1`) served through an intelligent
router over authorized upstream routes:

- **Settings → Providers**: add/validate/rotate upstream accounts (encrypted
  credentials; Z.ai runs on platform-managed credentials).
- **Settings → Routing**: configure per-model routes (primary + fallback),
  priorities, capability subsets, health state.
- Every routed request is attributed in `UsageRecord` (route + account) and
  logged in `RoutingDecision` (candidates, rejections, selection).
- Seed the family after a fresh clone: `bun run scripts/seed-emor-family.ts`.
- Verify with real executions: `bun run scripts/test-routing.ts`.
- Docs: `docs/IMPLEMENTATION-STATUS.md`, `docs/ARCHITECTURE.md`, `docs/SECURITY.md`.

### Private data bundle (encrypted)
This public repo keeps personal data out of git and ships it as one encrypted archive instead:

- **Bundle**: `secrets/emorai-secrets.tar.gz.enc` — AES-256-CBC (PBKDF2, 600k iterations) archive of `.env`, `db/custom.db`, `db/uploads/`.
- **Restore onto a fresh clone**:
  ```bash
  export EMORAI_SECRET_PASSPHRASE='…'   # your passphrase — never stored in this repo
  ./scripts/secrets.sh decrypt          # restores .env, db/custom.db, db/uploads/
  bun run db:push && bun run dev        # then start the server
  ```
- **Refresh after changes** (re-encrypts the current live state): `./scripts/secrets.sh encrypt`, then commit the updated bundle.
- The passphrase is provided out-of-band only. Old snapshots stay recoverable from git history (previous bundle versions remain in past commits).

### Model availability
The Z.ai gateway in this environment currently serves `glm-4-plus` regardless of the requested model ID — EmorAI reports this honestly (see *Settings → Models → Discover availability*, the `served model` note under each assistant reply, and `emorai_served_model` in API responses). If your provider plan grants specific model IDs, they will route through unchanged; candidates in the registry match the requested set (GLM-5.3, GLM-5.3-Flash, GLM-4.7-Flash, GLM-4.5-Flash, GLM-4.6V-Flash).

Rate limits: the upstream gateway enforces strict request-rate limits (HTTP 429); the adapter retries with backoff and surfaces the error if it persists. Dashboard and per-API-key limits are configurable in **Settings → General**.

## Project structure
```
src/
  app/
    api/                  # server routes (dashboard + gateway)
      chat/               # streaming chat engine (SSE)
      conversations/      # CRUD + messages + summary
      folders/ keys/ models/ settings/ usage/
      export/ import/     # data portability
      files/              # upload + serve
      v1/                 # Universal gateway (canonical mount)
        chat/completions/ # OpenAI protocol
        messages/         # Anthropic protocol (+ count_tokens)
        models/           # model listing + retrieve
        usage/ images/ audio/ videos/
    v1/                   # root-level mirror mount ({origin}/v1/…)
    page.tsx              # single-page dashboard
  components/
    emor/
      sidebar/ chat/ dialogs/  # UI
      developer/          # EMORAI API & INTEGRATIONS hub
        agent-guides.tsx  # ZCode / Claude Code / OpenClaw setup guides
        request-logs.tsx  # gateway request log viewer
        key-manager.tsx   # scopes / limits / revocation UI
        playground.tsx    # live tester (both protocols)
  lib/
    ai/
      zai-adapter.ts      # provider adapter: chat, vision, tools, retry/backoff
      sse.ts              # upstream SSE parsing
      protocol/
        openai.ts         # OpenAI wire protocol: schemas, envelopes
        anthropic.ts      # REAL Anthropic protocol translation layer
    api/
      auth.ts             # Bearer + x-api-key, scopes, limits, allowlists
      cors.ts             # gateway CORS
    model-registry.ts     # dynamic model catalog + aliases + discovery
    api-keys.ts settings.ts rate-limit.ts usage.ts files.ts
  stores/ hooks/          # zustand store, query/stream hooks
prisma/schema.prisma      # Conversations, Messages, Folders, ApiKeys (+scopes/limits),
                          # ModelConfigs (+context/aliases), AppSettings,
                          # UsageRecords (+protocol/endpoint/status), Files, Artifacts
scripts/
  test-gateway.ts         # end-to-end gateway test (real provider calls)
  model-availability-probe.ts
```

## Quickstart: use EmorAI as an AI provider

```bash
# 1. Create a key: Dashboard → API & Integrations → Overview → Generate key
# 2. Call the OpenAI-compatible endpoint:
curl -N http://localhost:3000/api/v1/chat/completions \
  -H "Authorization: Bearer emr_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"glm-5.3-flash","messages":[{"role":"user","content":"Hello!"}],"stream":true}'

# 3. Or the Anthropic-compatible endpoint:
curl http://localhost:3000/api/v1/messages \
  -H "x-api-key: emr_YOUR_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{"model":"glm-5.3-flash","max_tokens":256,"messages":[{"role":"user","content":"Hello!"}]}'
```

### Claude Code
```bash
export ANTHROPIC_BASE_URL="https://your-emorai-host/api"
export ANTHROPIC_API_KEY="emr_YOUR_KEY"
export ANTHROPIC_MODEL="glm-5.3-flash"
claude
```

### ZCode — Add Provider
- API Base URL: `https://your-emorai-host/api/v1` (OpenAI format) or `…/api` (Anthropic format)
- API Key: your EmorAI key · Model: `glm-5.3-flash` (manual model registration)

### End-to-end test
```bash
bun run scripts/test-gateway.ts   # real-provider integration test of the whole gateway
```

# EmorAI

**Intelligence Without Limits.**

EmorAI is a production-quality, single-owner personal AI platform: a ChatGPT-style dashboard powered by real Z.ai GLM integration, a dynamic model registry, API key management, and an OpenAI-compatible developer API.

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

### Model registry
- Ships with GLM-5.3, GLM-5.3-Flash (default), GLM-4.7-Flash, GLM-4.5-Flash, GLM-4.6V-Flash as candidates
- Administrators can enable/disable, add custom model IDs, remove entries, and **test availability** — the probe records what the provider gateway *actually serves* (`last_served_model`) so aliasing/routing is visible, never hidden
- No silent model switching: errors (quota, disabled, unavailable) are shown verbatim
- Provider column (`zai` today) makes future provider adapters a drop-in extension

### API key management
- Generate cryptographically secure keys (`emr_<48 hex>`) — **SHA-256 hash stored, plaintext shown exactly once**
- Custom names, creation dates, last-used timestamps, request counts
- Revoke / restore / delete
- Server-side validation + per-key rate limiting

### Developer API (`/api/v1`) — OpenAI-compatible
| Endpoint | Method | Description |
| --- | --- | --- |
| `/api/v1/chat/completions` | POST | Chat completions, streaming (`stream: true`) or blocking, OpenAI chunk protocol |
| `/api/v1/models` | GET | Enabled models with capabilities |
| `/api/v1/usage` | GET | Usage report for the presenting key |

Auth: `Authorization: Bearer emr_…`. Errors follow the OpenAI envelope. See the in-app **API documentation** dialog for curl/JavaScript/Python examples.

### Security notes (v1, single-owner)
- Provider (Z.ai) credentials live **server-side only** (`.z-ai-config` or gateway environment). They are never sent to the browser or embedded in client code.
- EmorAI API keys are hashes; only the dashboard can mint them.
- Cross-origin mutating requests to the dashboard API are rejected by an origin guard (`src/middleware.ts`); `/api/v1` uses Bearer tokens (CSRF-inapplicable).
- **This is a single-owner installation.** Generated keys share one provider quota; add an auth layer (e.g. NextAuth) before multi-user or public deployment.

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
| Uploads | `db/uploads/` | Stored on disk; metadata in the `FileMetadata` table. 10 MB per file limit. |

### Model availability
The Z.ai gateway in this environment currently serves `glm-4-plus` regardless of the requested model ID — EmorAI reports this honestly (see *Settings → Models → Test availability*, and the `served model` note under each assistant reply). If your provider plan grants specific model IDs, they will route through unchanged; candidates in the registry match the requested set (GLM-5.3, GLM-5.3-Flash, GLM-4.7-Flash, GLM-4.5-Flash, GLM-4.6V-Flash).

Rate limits: the gateway enforces request-rate limits (HTTP 429); the adapter retries with backoff and surfaces the error if it persists. Dashboard and per-API-key limits are configurable in **Settings → General**.

## Project structure
```
src/
  app/
    api/                  # server routes (dashboard + /api/v1)
      chat/               # streaming chat engine (SSE)
      conversations/      # CRUD + messages + summary
      folders/ models/ keys/ settings/ usage/
      export/ import/     # data portability
      files/              # upload + serve
      v1/                 # developer API (OpenAI-compatible)
    page.tsx              # single-page dashboard
  components/
    emor/
      sidebar/ chat/ dialogs/  # UI
  lib/
    ai/                   # zai-adapter, SSE parsing, prompt builder
    api/                  # auth, response helpers
    model-registry.ts     # dynamic model catalog
    settings.ts rate-limit.ts api-keys.ts usage.ts files.ts
  stores/ hooks/          # zustand store, query/stream hooks
prisma/schema.prisma      # Conversations, Messages, Folders, ApiKeys,
                          # ModelConfigs, AppSettings, UsageRecords, FileMetadata
scripts/                  # dev utilities (provider probes)
```

## Quickstart: developer API
```bash
# 1. Create a key: Dashboard → More → API keys → Generate key
# 2. Call:
curl -N http://localhost:3000/api/v1/chat/completions \
  -H "Authorization: Bearer emr_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"glm-5.3-flash","messages":[{"role":"user","content":"Hello!"}],"stream":true}'
```

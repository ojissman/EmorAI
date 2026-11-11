# Task 1-b — Administrator route guards (Priority 0)

**Agent:** 1-b admin-route-guards
**Repo:** /home/z/my-project (EmorAI, Next.js 16 App Router)
**Status:** COMPLETE — all acceptance checks green.

## What was done

Inserted `requireAdmin(req)` as the FIRST statement of every exported
GET/POST/PUT/PATCH/DELETE handler in the administrative API surface.
Pattern applied everywhere:

```ts
import { requireAdmin } from '@/lib/api/admin-auth';

export async function X(req: Request [, { params }: Params]) {
  const denied = await requireAdmin(req);
  if (denied) return denied;
  // ...existing logic untouched
}
```

- Handlers that had no `req` param got one added (`GET()` -> `GET(req: Request)`).
- Handlers using `_req` were renamed to `req` (now used).
- `[id]` second args kept exactly as-is. `artifacts/[id]/preview/[...path]/route.ts`
  keeps its `{ params: Promise<{ path: string[] }> }` shape.
- OPTIONS handlers: none exist in the guarded surface (only in v1 — untouched),
  so nothing to skip.
- SSE/streaming POSTs (`/api/chat`, `/api/agent/run`) guard before any
  streaming/DB work starts.
- No zod schemas, response shapes, or business logic were changed.

## SSRF url-policy hook (providers only)

`providers/route.ts` (POST, before `db.providerAccount.create`) and
`providers/[id]/route.ts` (PATCH, before `db.providerAccount.update`) gained:

```ts
if (data.baseUrl) {
  try {
    const { assertProviderUrlAllowed } = await import('@/lib/net/url-policy');
    const policy = await assertProviderUrlAllowed(String(data.baseUrl));
    if (!policy.ok) return fail(422, 'url_blocked', `Base URL rejected by destination policy: ${policy.reason}`);
  } catch { /* module not present yet — SSRF agent lands it in parallel */ }
}
```

- Runs only when a non-null `baseUrl` is actually being set/changed.
- `src/lib/net/url-policy.ts` does NOT exist yet (owned by another agent, NOT created here).
- Turbopack logs a benign `Module not found: '@/lib/net/url-policy'` warning and
  the runtime catch skips validation — requests still succeed (verified: POST 201, PATCH 200).
  Once the module lands, hot reload resolves it and enforcement starts automatically.

## Files guarded (38)

providers/route.ts, providers/[id]/route.ts, providers/[id]/validate/route.ts,
providers/[id]/discover/route.ts, models/route.ts, models/[id]/route.ts,
models/[id]/probe/route.ts, models/discover/route.ts, routes/route.ts,
routes/[id]/route.ts, keys/route.ts, keys/[id]/route.ts, settings/route.ts,
usage/route.ts, conversations/route.ts, conversations/[id]/route.ts,
conversations/[id]/messages/route.ts, conversations/[id]/summary/route.ts,
folders/route.ts, folders/[id]/route.ts, files/[id]/route.ts, import/route.ts,
export/route.ts, agent/run/route.ts, chat/route.ts, artifacts/route.ts,
artifacts/[id]/route.ts, artifacts/[id]/zip/route.ts, artifacts/[id]/file/route.ts,
artifacts/[id]/preview/route.ts, artifacts/[id]/preview/[...path]/route.ts,
studio/image/route.ts, studio/image/edit/route.ts, studio/audio/route.ts,
studio/video/route.ts, studio/document/route.ts, voice/tts/route.ts,
voice/transcribe/route.ts.

Note: `chat/route.ts` is not in the task's explicit file list but the SSE rule says
"chat, agent run, studio" — it is a dashboard SSE endpoint and NOT in the skip list,
so it was guarded. Flag to reviewer if intentional exclusion was desired.

## Untouched (verified)

- src/app/api/admin/** (self-managing auth endpoints)
- src/app/api/v1/** + src/app/v1/** (customer gateway — key-authenticated)
- src/app/route.ts, src/app/api/route.ts (public placeholders)
- src/lib/** (no lib edits; url-policy NOT created)

## Verification matrix (all via curl against localhost:3000)

| # | Command | Result | Expected |
|---|---------|--------|----------|
| 1 | GET /api/providers (bare) | 401 | 401 |
| 2 | GET /api/providers + `Authorization: Bearer emr_...` | 403 `api_key_not_admin_credential` | 403 |
| 3 | POST /api/admin/auth/login (correct password) | 200, cookies + csrfToken | 200 |
| 4 | GET /api/providers + session cookie | 200 | 200 |
| 5 | POST /api/conversations + session, no CSRF header | 403 `csrf_token_invalid` | 403 |
| 6 | POST /api/conversations + session + X-CSRF-Token | 201 (business success) | pass auth layer |
| 7 | bare GETs: /api/models /api/routes /api/keys /api/settings /api/usage /api/artifacts /api/artifacts/{id} /api/artifacts/{id}/zip /api/folders /api/export | all 401 | 401 |
| 7b | bare POSTs: models routes keys studio/document voice/tts conversations folders agent/run chat import models/discover | all 401 | 401 |
| 7c | bare PUT /api/settings, PATCH /api/providers/{id}, DELETE /api/keys/{id}, DELETE /api/artifacts/{id} | all 401 | 401 |
| 8 | POST /api/v1/chat/completions (no auth) | 401 `missing_api_key` | NOT admin_auth_required — v1 untouched |

405s observed for methods a route never defined (e.g. POST /api/usage) are
Next.js framework responses (no handler exists) — no data exposure possible.

SSRF path proof: POST /api/providers with non-null baseUrl (zai type) → dynamic
import fails → catch → 201. PATCH provider with name only → 200.

## Lint

`bun run lint`: 0 errors, 33 warnings — all pre-existing in scripts/test-gateway.ts
(not touched by this task). No warnings/errors from the 38 guarded files.

## Signature changes

- `GET()` -> `GET(req: Request)`: providers, models, routes, keys, settings,
  folders, export, artifacts (GET); `DELETE()` -> `DELETE(req: Request)`: artifacts.
- `POST()` -> `POST(req: Request)`: models/discover.
- `_req` -> `req`: all handlers that previously ignored the request object.
- No second-arg changes anywhere; no response-shape/schema changes.

## Anomalies

1. `artifacts/[id]/preview/[...path]/route.ts` uses `{ path: string[] }` params
   (catch-all), not `{ id: string }` — kept as-is, guarded normally.
2. `chat/route.ts` guarded per the SSE instruction (not in the explicit list) — see note above.
3. Turbopack logs `Module not found: '@/lib/net/url-policy'` warnings until the
   SSRF agent lands the module — expected, benign, swallowed by the catch.
4. dev.log had an old EADDRINUSE entry from a duplicate-start attempt; the live
   server kept serving throughout (all curls above prove it).

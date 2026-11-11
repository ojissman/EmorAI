# Task UI-1 — Admin UI for the multi-provider platform (Providers / Routing / model badges)

Agent: admin-ui builder (Task ID: UI-1)
Status: COMPLETE — `bun run lint` passes with 0 errors and 0 warnings in owned files (the only remaining warnings are pre-existing in `scripts/test-gateway.ts`, not mine); `bunx tsc --noEmit` shows no errors in owned files (all remaining project TS errors live in backend files owned by other tasks); dev.log shows clean compiles; smoke-tested `GET /api/providers` + `GET /api/routes` payload shapes against the UI types.

## Files created

| File | Purpose |
|---|---|
| `src/components/emor/dialogs/providers-tab.tsx` | `ProvidersTab` — provider-account cards (name, providerType label badge, baseUrl code / "Platform credentials", stored-key masked hint, enabled Switch, OK/Error/Not-checked status badge with lastError tooltip + truncated line, requestCount/routeCount/priority/last-checked stats). Actions per card: Validate (POST `/api/providers/[id]/validate`, toast shows validation message + health latency), Edit (inline form: name / baseUrl / rotate API key (password, blank = keep) / priority / maxConcurrency / monthlyBudget, sends only changed fields, URL-shape guarded), Clear key (PATCH `clearApiKey`), Delete (AlertDialog confirm; 409 `in_use` message surfaced verbatim via sonner). Add-provider form: name, providerType Select from `providerTypes`, baseUrl + password API-key fields shown only for non-zai types, priority, monthlyBudget. Amber banner "Set EMORAI_MASTER_KEY in the environment to store credentials" when `encryptionAvailable=false`, and the Add button is disabled for stored-credential types (zai/platform still allowed). Loading = Skeleton cards; error = retry card; empty = dashed guidance card (no invented metrics). |
| `src/components/emor/dialogs/routing-tab.tsx` | `RoutesTab` — routes grouped by `publicModelId` (group header: displayName + code modelId + generation + route count + "Model missing" amber badge if the public model vanished from the registry). Route rows: upstreamModelId code, providerType badge, account name, "Account disabled" / "Failing validation" tags, healthStatus badge (healthy=emerald, degraded=amber, down=destructive, unknown=muted), inline priority number input (commit on Enter/blur, 0–1000 guarded), enabled Switch, lastServedAt (`timeAgo`), timeout/weight, lastError behind a Tooltip trigger. Actions: Reset health (PATCH `resetHealth:true`), Delete (AlertDialog confirm; 409 `last_route` message verbatim). Add-route form: publicModelId Select (models `category==='emorai'`, disabled ones marked), providerAccountId Select (enabled accounts only), upstreamModelId text, priority, enabled Switch; submit blocked with guidance when no emorai models / no enabled accounts; on success shows the router's eligible-preview note (first candidate / rejection reason) via `toast.info`. Loading skeletons, error retry, empty-state guidance. |
| `src/components/emor/dialogs/provider-shared.tsx` | `providerTypeLabel()` (zai/OpenAI-compatible/Anthropic-compatible/Self-hosted + raw-key fallback) and `timeAgo()` (same style as `studio-shared.tsx`). Used by both new tabs. |

## Files modified

| File | Change |
|---|---|
| `src/hooks/use-emor-queries.ts` | Added serialized types (`ProviderAccount`, `ProvidersResponse`, `CreateProviderInput`, `UpdateProviderInput`, `ProviderValidationResponse`, `ModelRouteRow`, `RoutePlanPreview`, `CreateRouteInput`, `UpdateRouteInput`, `ProviderRouteSummary`) and hooks following existing patterns: `useProviders`, `useCreateProvider`, `useUpdateProvider`, `useDeleteProvider`, `useValidateProvider`, `useRoutes`, `useCreateRoute`, `useUpdateRoute`, `useDeleteRoute` (all mutations invalidate `['providers']`/`['routes']`; route create also invalidates `['providers']` for route counts). `useInvalidateAll()` now also invalidates `providers` + `routes`. |
| `src/components/emor/dialogs/settings-dialog.tsx` | TabsList now `grid-cols-4 sm:grid-cols-7` with two new triggers — `providers` ("Providers") and `routes` ("Routing") — plus matching `TabsContent` slots. **Relabeled** the pre-existing `provider` tab trigger from "Provider" to "Security" (value unchanged, nothing deep-links to it) to avoid confusion with the new "Providers" tab; its informational content is untouched. `ModelRow` gains an "EmorAI" category badge (`bg-primary/10 text-primary` + dot, brand color, no indigo/blue) and a subtle `LifecycleBadge` for non-active lifecycle (preview=violet, deprecated=amber, retired=destructive, draft=muted). `ModelsTab` list is now grouped: "EmorAI models" section first, then "Provider models", each with an empty-section note. |
| `src/components/emor/model-selector.tsx` | Enabled-list items for `category === 'emorai'` show a small "EmorAI" pill (`bg-primary/10 text-primary`, same sizing scale as the Free/Plan badges). |

## Contracts consumed (read-only — no backend files touched)

- `GET/POST /api/providers`, `GET/PATCH/DELETE /api/providers/[id]`, `POST /api/providers/[id]/validate` (validation + health result toasted).
- `GET/POST /api/routes`, `PATCH/DELETE /api/routes/[id]` (`resetHealth` included).
- Error codes surfaced verbatim via sonner toasts: `in_use` (409 provider delete), `last_route` (409 route delete), `unknown_model` / `unknown_account` / `not_routable` / `duplicate_route`, `missing_base_url` / `missing_api_key` / `encryption_unavailable`.
- The `POST /api/providers/[id]/discover` 501 `discovery_unsupported` path was NOT given a UI button: per the task note ("use the Models tab probe instead") discovery stays out of scope for this task; the error would simply toast if wired later.

## Notes for integrators

1. `encryptionAvailable` is only reported per-account by `GET /api/providers`; with zero accounts it is unknown, so the tab assumes available and lets the server's `encryption_unavailable` refusal (verbatim toast) educate the admin. On this sandbox the flag is `false`, so the banner renders.
2. Priority edits on routes use a compact inline number input (Enter/blur commit) rather than a dialog — matches the inline-edit pattern used by model aliases in this codebase.
3. Route "Model missing" badge appears when a route references a publicModelId no longer in the registry (routes store plain strings, not FKs).
4. No new pages/routes were created (single-page app constraint respected); no chat-area/composer/playground/studio files touched.

## Verification

- `bun run lint` → **0 errors, 0 warnings in owned files** (33 pre-existing warnings in `scripts/test-gateway.ts`).
- `bunx tsc --noEmit` → no errors in `src/components/emor/dialogs/{providers-tab,routing-tab,provider-shared,settings-dialog}.tsx`, `src/components/emor/model-selector.tsx`, `src/hooks/use-emor-queries.ts`.
- `curl /` → 200; `GET /api/providers` and `GET /api/routes` payloads match the declared UI types field-for-field; dev.log clean.

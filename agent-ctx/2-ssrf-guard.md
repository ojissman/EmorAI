# Task 2 — SSRF / destination security policy (url-policy + secureFetch)

Task ID: 2 · Agent: ssrf-guard · Status: COMPLETE (52/52 unit tests green, lint clean)

## Deliverables (strictly within my file ownership)

| File | Kind | Purpose |
|---|---|---|
| `src/lib/net/url-policy.ts` | new | Destination policy: URL parse/scheme rules, IPv4+IPv6 blocked-address classes, strict literal guard, fresh-DNS resolution, allowlist matching, `assertProviderUrlAllowed`, `loadNetworkPolicy` |
| `src/lib/net/secure-fetch.ts` | new | Policy-enforcing fetch: per-hop re-validation, manual redirects (max 3), cross-host credential stripping, combined timeout, byte-capped body stream; exports `DestinationBlockedError`, `ResponseTooLargeError`, `isAbortLikeError` |
| `src/lib/ai/providers/openai-compat.ts` | modified | All outbound calls (`fetchJson` → listModels / validateCredentials / checkHealth / completeChat, plus `streamChat`) now route through `secureFetch` with policy from `loadNetworkPolicy()`; timeout/abort semantics preserved |
| `src/lib/ai/providers/anthropic-compat.ts` | modified | Same integration for `listModels`, `streamChat`, `completeChat` (validateCredentials / checkHealth delegate to listModels) |
| `tests/unit/url-policy.test.ts` | new | 52 bun:test cases incl. Bun.serve mock-server tests (redirect-block, credential strip, size cap, timeout); run with `bun test tests/unit/url-policy.test.ts` |

Untouched (verified): `zai.ts`, `providers/index.ts`, `router.ts`, all `src/app/api/**`, `prisma/schema.prisma`, `zai-adapter.ts`, `settings.ts`, `types.ts`.

## Key behavior notes for other agents

1. **Provider save-time validation hook (admin routes — agent 1-b):**
   call `await import('@/lib/net/url-policy')` → `assertProviderUrlAllowed(baseUrl, { allowlist, requireHttps })`.
   Returns `{ ok: true, resolved: string[] }` or `{ ok: false, reason }`. Reason strings:
   `invalid_url` · `scheme_not_allowed` · `missing_hostname` · `userinfo_not_allowed` · `invalid_port` ·
   `insecure_scheme` (http + requireHttps + not allowlisted) · `invalid_ip_literal` · `invalid_hostname` ·
   `dns_unresolvable` · address classes: `loopback` `link_local` `private` `cgnat` `unique_local`
   `multicast` `unspecified` `broadcast` `reserved` (incl. IPv4-mapped IPv6 and IPv4-compatible ::/96).
   Allowlist entries: exact trimmed case-insensitive `host` or `host:port` (IPv6 port entries must be
   bracketed, e.g. `[::1]:3999`); scheme-default ports (443/80) count as equivalent.

2. **IMPORTANT dev-server note:** the dynamic-import resolution inside
   `src/app/api/providers/route.ts` + `[id]/route.ts` was cached as "Module not found" because those
   routes were saved at 15:47, BEFORE `src/lib/net/url-policy.ts` existed (15:53). Turbopack does NOT
   re-resolve that dynamic import on later compiles — I confirmed the warning persists even after
   content-changing the target/dependents. A **re-save of the route file** (any content change by its
   owner) regenerates the import map and resolves it. Until then their `catch` skips save-time
   validation — request-time enforcement via secureFetch is fully active regardless, so no egress
   gap exists. In a production build there is no such cache.

3. **Runtime error surface:** adapters map policy failures to `ProviderError` with codes
   `destination_blocked` / `response_too_large` (runtime-widened; the `ProviderErrorCode` union in
   `zai-adapter.ts` — owned elsewhere — was intentionally not edited; unknown codes fall through to
   generic handling downstream). Timeout/abort keeps existing semantics (`timeout` code in
   fetchJson; raw AbortError propagation in stream generators exactly as before).

4. **Timeouts:** secureFetch combines the caller's signal with `AbortSignal.timeout(timeoutMs)`
   (`AbortSignal.any` when available, manual controller fallback). Adapters keep their own
   timers/controllers and pass the same budget — behavior unchanged, aborts cover connect+headers+body.

5. **Redirects:** `redirect: 'manual'` always; ≤3 hops; every hop re-validated through the SAME
   policy (fresh DNS — blocked/private/insecure downgrades refused mid-chain). Host change
   (hostname OR effective port) strips `authorization`, `x-api-key`, `api-key`, `cookie`,
   `proxy-authorization`. 303→GET, 301/302 non-GET/HEAD→GET (body dropped), 307/308 preserved
   (string bodies only; streams can't replay → error).

6. **Size cap:** response bodies wrapped in a byte-counting ReadableStream — exceeding
   `maxResponseBytes` cancels the upstream and raises `ResponseTooLargeError` at read time; no
   buffering. Empty/204/205/304 bodies pass through un-wrapped.

7. **Settings:** `loadNetworkPolicy()` reads `network` from `getSettings()` (5s in-process memo,
   fail-closed to empty allowlist + requireHttps + 32 MiB cap on read errors).

## Known limitations (documented in code)

- DNS-rebinding TOCTOU window: DNS is resolved immediately before connecting, but the runtime's own
  resolver may cache or the upstream may race — pinning to the validated address (custom undici
  dispatcher) is the future hardening step.
- IPv6 zone ids are ignored for classification (stripped); Bun's URL parser rejects bracketed zone
  URLs outright anyway.
- IPv4-embedded translation prefixes (6to4 2002::/16, Teredo 2001::/32, NAT64 64:ff9b::/96) are not
  decoded — a public-wrapped translation of a private IPv4 is out of scope here.
- Multicast/broadcast/reserved ranges are blocked by class even though some stacks would simply
  fail to route them (defense-in-depth).

## Verification performed

- `bun test tests/unit/url-policy.test.ts` → 52 pass / 0 fail / 100 expect() calls.
- `bun run lint` → 0 errors (33 pre-existing warnings elsewhere; my files lint clean in isolation).
- E2E under bun with Bun.serve mocks: default policy blocks `http://127.0.0.1:3999` (`insecure_scheme`
  → ProviderError `destination_blocked`); with `network.allowlist = ["127.0.0.1:<port>"]`,
  `validateCredentials`/`listModels` succeed through secureFetch (Authorization / x-api-key verified
  server-side); settings restored afterwards (allowlist back to `[]`).
- Dev server (:3000) never stopped/restarted; no compile errors attributable to my files.

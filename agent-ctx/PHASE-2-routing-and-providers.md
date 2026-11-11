# Task Phase 2 — Routing strategies + stored-credential provider chain + GitHub push

Agent: platform builder (Task IDs: 2-a, 2-b, 2-c)
Status: COMPLETE — all three sub-tasks verified with real executions; `bun run lint` 0 errors (33 pre-existing warnings in scripts/test-gateway.ts only); `bunx tsc --noEmit` clean in touched files; dev.log clean; Agent Browser UI verification passed (strategy selector renders, switches persist, latency rows visible, mobile OK).

## 2-a Routing strategies (balanced | priority | cost | performance)

Files modified:
| File | Change |
|---|---|
| `src/lib/types.ts` | `RoutingStrategyName` (4 strategies) + `ROUTING_STRATEGIES` + `AppSettings.routingStrategy` |
| `src/lib/settings.ts` | default `routingStrategy: 'balanced'` + zod enum validation |
| `prisma/schema.prisma` | `ModelRoute.lastLatencyMs Int?` (additive; pushed with `bun run db:push`) |
| `src/lib/ai/router.ts` | `currentRoutingStrategy()` reads the setting; `scoreRoute()` strategy-aware (priority = pure order; cost = weight×1000 dominates, weight is the admin-configured cost proxy — pricing never invented; performance = measured `lastLatencyMs` with a neutral 1200 ms prior for unmeasured routes); every decision records the actual strategy; per-attempt latency passed to `markRouteServed` |
| `src/hooks/use-emor-queries.ts` | `ModelRouteRow.lastLatencyMs` |
| `src/components/emor/dialogs/routing-tab.tsx` | strategy Select (4 options + honest one-line hints) saving through `/api/settings`; route rows show measured latency |

Scoring evidence (from RoutingDecision.candidates scores):
- priority: glm-5.3 (prio 0) score 0 vs flash (prio 10) score 1000
- cost with flash flipped to weight 0.5/prio 0: flash 500 < glm 1000 → selection flipped by weight, then restored
- performance: flash selected at score 391 (341 ms measured + 50 priority tiebreak) vs glm 392 — measured latency overrode the priority order
- lastLatencyMs recorded on real executions only (392/397 ms on the two emor-5.3 routes)

## 2-b Stored-credential provider chain drill (temporary, fully cleaned up)

A local OpenAI-compatible drill endpoint (`.tmp/drill-server.ts`, port 3031, Bearer auth enforced) verified the full stored-credential path with real HTTP:
1. POST /api/providers (self-hosted, baseUrl http://localhost:3031/v1, apiKey) → stored as `v1:…` AES-256-GCM ciphertext (verified: no plaintext at rest)
2. validate → ok (decrypt → HTTP → auth, 4 ms); masked hint `dril…1234 (21 chars, encrypted)`
3. discover + adopt → `drill-mini` catalogued from the real listing endpoint
4. Route emor-5.2 → drill-mini (priority 0; zai route temporarily 5) → request served `DRILL-SERVED-BY-LOCAL(drill-mini)` with upstream usage (5/7/12)
5. SSE streaming through the drill parsed correctly
6. **Failover E2E**: drill server killed → next request failed over to Z.ai (attemptCount 2, drill route in failedCandidates, usage attributed to the zai route, `FAILOVER-OK` content)
7. Cleanup verified: back to 1 account / 4 routes / 8 models / 1 key; strategy balanced; drill artifacts deleted

## 2-c GitHub push

- Verified the 3 unpushed commits contained only source/docs/encrypted-bundle paths (0 secret patterns in added lines)
- Pushed `7a99079..fea5ad3` with the PAT (one-time use); remote main confirmed = local HEAD
- Final push of the Phase 2 commits happens after this doc

## Notes for integrators

- `EMORAI_MASTER_KEY` is now configured in `.env` (gitignored); the Providers tab amber encryption warning is gone
- Strategy applies per-request (read from settings at plan time) — no server restart needed to change it
- Test API keys used during verification were deleted after use; the Phase 1 key ("E2E Chain Verification") remains for the user

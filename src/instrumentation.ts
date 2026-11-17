// ─── Server boot instrumentation (Phase 10, Priority 7) ──────────────────────
// Next.js App Router hook: register() runs once per server process at boot,
// before the first request is served. Two things happen here, in order:
//
//   1. SELF-HEAL (src/lib/self-heal.ts) — the platform recycles idle
//      workspaces and resets .env + db/ to scaffold state; the heal detects
//      that and restores both from the git-carried encrypted bundle BEFORE
//      any route module loads. Must run first: routes read EMORAI_MASTER_KEY
//      and open the database lazily, and the scheduler queries immediately.
//   2. Job scheduler (src/lib/jobs/scheduler.ts) — operational background
//      jobs. API routes import the same module for manual triggers, but
//      timers only ever start here.
//
// Guards:
//   • nodejs runtime only — instrumentation also runs for the edge runtime,
//     and both heal + scheduler need Node (Prisma, openssl child_process,
//     timers, node:crypto via adapters).
//   • never during `next build` (NEXT_PHASE = phase-production-build): the
//     build process must not restore secrets, run background jobs or write
//     JobRun rows.
//
// NOTE for dev: adding this file requires a dev-server restart before it is
// picked up (Turbopack loads instrumentation at process start). That is
// expected — manual triggers via POST /api/ops/jobs work meanwhile.

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.NEXT_PHASE === 'phase-production-build') return;
  try {
    const { selfHealIfNeeded } = await import('./lib/self-heal');
    await selfHealIfNeeded();
  } catch (e) {
    // a failed heal must never keep the platform from serving requests
    console.error('[self-heal] boot heal crashed:', e);
  }
  try {
    const { startScheduler } = await import('./lib/jobs/scheduler');
    startScheduler(); // idempotent (module-level + globalThis double-start guard)
  } catch (e) {
    // the platform must serve requests even if background jobs cannot start
    console.error('[jobs] scheduler failed to start:', e);
  }
}

// ─── Server boot instrumentation (Phase 10, Priority 7) ──────────────────────
// Next.js App Router hook: register() runs once per server process at boot,
// before the first request is served. This is where the operational job
// scheduler (src/lib/jobs/scheduler.ts) starts — API routes import the same
// module for manual triggers, but timers only ever start here.
//
// Guards:
//   • nodejs runtime only — instrumentation also runs for the edge runtime,
//     and the scheduler needs Node (Prisma, timers, node:crypto via adapters).
//   • never during `next build` (NEXT_PHASE = phase-production-build): the
//     build process must not execute background jobs or write JobRun rows.
//
// NOTE for dev: adding this file requires a dev-server restart before it is
// picked up (Turbopack loads instrumentation at process start). That is
// expected — manual triggers via POST /api/ops/jobs work meanwhile.

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.NEXT_PHASE === 'phase-production-build') return;
  try {
    const { startScheduler } = await import('./lib/jobs/scheduler');
    startScheduler(); // idempotent (module-level + globalThis double-start guard)
  } catch (e) {
    // the platform must serve requests even if background jobs cannot start
    console.error('[jobs] scheduler failed to start:', e);
  }
}

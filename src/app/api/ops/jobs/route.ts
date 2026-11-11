// ─── Ops jobs (admin) ─────────────────────────────────────────────────────────
// JobRun history + manual job triggering for operational monitoring
// (Phase 10, Priority 7). GET returns the latest 100 JobRuns with a small
// 24h aggregate and the live scheduler state; POST runs a job NOW through the
// exact same runJobNow path as the scheduler — the triggered execution gets
// its own JobRun row like every scheduled one. Admin session + CSRF guarded
// via requireAdmin (CSRF applies to the POST).

import { z } from 'zod';
import { db } from '@/lib/db';
import { ok, fail } from '@/lib/api/response';
import { requireAdmin } from '@/lib/api/admin-auth';
import { runJobNow, schedulerRunning, JOB_NAMES, type JobName } from '@/lib/jobs/scheduler';
import { getSettings } from '@/lib/settings';

export const runtime = 'nodejs';

function serializeJobRun(row: {
  id: string;
  jobName: string;
  status: string;
  startedAt: Date;
  finishedAt: Date | null;
  result: unknown;
  errorText: string | null;
}) {
  return {
    id: row.id,
    jobName: row.jobName,
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    result: row.result ?? null,
    errorText: row.errorText,
  };
}

export async function GET(req: Request) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [runs, total24h, failed24h, perJobRows, settings] = await Promise.all([
    db.jobRun.findMany({ orderBy: { startedAt: 'desc' }, take: 100 }),
    db.jobRun.count({ where: { startedAt: { gte: since } } }),
    db.jobRun.count({ where: { startedAt: { gte: since }, status: 'failed' } }),
    Promise.all(
      JOB_NAMES.map(async (job) =>
        Promise.all([
          job,
          db.jobRun.findFirst({ where: { jobName: job }, orderBy: { startedAt: 'desc' } }),
        ])
      )
    ),
    getSettings().catch(() => null),
  ]);

  const perJob: Record<string, { lastStatus: string | null; lastStartedAt: string | null }> = {};
  for (const [job, row] of perJobRows) {
    perJob[job] = {
      lastStatus: row?.status ?? null,
      lastStartedAt: row?.startedAt.toISOString() ?? null,
    };
  }

  const healthCheckMin = settings?.jobs.healthCheckMin ?? 15;
  const modelSyncHrs = settings?.jobs.modelSyncHrs ?? 6;

  return ok({
    scheduler: {
      // false means this process has not run startScheduler yet (e.g. the dev
      // server has not been restarted since instrumentation.ts landed) — manual
      // triggers above still work and record rows like scheduled runs.
      running: schedulerRunning(),
      jobs: [
        { job: 'provider-health', cadence: `every ${healthCheckMin} min (settings.jobs.healthCheckMin)` },
        { job: 'model-sync', cadence: `every ${modelSyncHrs} h (settings.jobs.modelSyncHrs)` },
        { job: 'usage-reconcile', cadence: 'every 60 min (fixed)' },
        { job: 'log-prune', cadence: 'every 24 h (fixed)' },
      ],
    },
    runs: runs.map(serializeJobRun),
    aggregate: {
      total24h,
      failed24h,
      perJob,
    },
  });
}

const triggerSchema = z.object({
  job: z.enum(JOB_NAMES),
});

export async function POST(req: Request) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail(400, 'bad_json', 'Request body must be valid JSON.');
  }
  const parsed = triggerSchema.safeParse(body);
  if (!parsed.success) {
    return fail(400, 'invalid_request', `Unknown job. Trigger one of: ${JOB_NAMES.join(', ')}.`, { details: parsed.error.flatten() });
  }

  try {
    // manual trigger — same wrapping as the scheduler: its own JobRun row,
    // finalized success / failed / skipped; failures are recorded, not thrown
    const run = await runJobNow(parsed.data.job as JobName);
    return ok({ run: serializeJobRun(run) });
  } catch (e) {
    // only reachable if the JobRun row itself could not be written
    console.error('[api] ops/jobs trigger failed:', e);
    return fail(500, 'job_trigger_failed', 'The job could not be recorded. Check the server logs for details.');
  }
}

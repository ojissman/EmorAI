// ─── Operational job scheduler (Phase 10, Priority 7) ─────────────────────────
// In-process background jobs for operational monitoring. Started once at server
// boot from src/instrumentation.ts (Next.js App Router register hook) — NOT on
// import: API routes import runJobNow/JOB_NAMES for manual admin triggers and
// must not start timers.
//
// Honesty rules (same philosophy as the adapters/billing):
//   • Every execution — scheduled OR manually triggered — is wrapped in a
//     JobRun row: created 'running', finalized 'success' (result summary) /
//     'failed' (errorText, truncated) / 'skipped' (reason). Job bodies never
//     throw out; the row records the failure instead.
//   • Platform-managed accounts (the bundled Z.ai installation account) expose
//     no independent health endpoint — they are SKIPPED, never probed with a
//     fabricated status, and their lastStatus stays untouched.
//   • Model-sync NEVER adopts anything: it compares upstream listings with the
//     adopted provider-category catalogue rows and reports available/stale.
//     Adoption stays an explicit administrator decision.
//   • Alerting is record-only (AlertEvent rows); delivery channels (email/
//     webhook) are configuration, not fabricated. Quota sync is unsupported —
//     providers expose no quota API; nothing is invented.
//   • Single-process design: one server → one scheduler. Multi-node deployments
//     would need external coordination (documented limitation, out of scope).
//
// Cadence sources: settings.jobs.healthCheckMin / modelSyncHrs are re-read
// fresh on every cycle (clamped to their schema ranges) so changes apply from
// the next scheduled run; usage-reconcile and log-prune are fixed cadences.

import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { getSettings } from '@/lib/settings';
import { recordCostForUsage } from '@/lib/billing';
import { getAdapterByType, adapterContextForAccount } from '@/lib/ai/providers';
import type { AdapterContext, ProviderHealth } from '@/lib/ai/providers';

// ─── Job registry ────────────────────────────────────────────────────────────

export const JOB_NAMES = ['provider-health', 'model-sync', 'usage-reconcile', 'log-prune'] as const;
export type JobName = (typeof JOB_NAMES)[number];

/** Whole-job skip sentinel — the JobRun row is finalized 'skipped' with a reason. */
class SkippedJob extends Error {}

type JobBody = () => Promise<Record<string, unknown>>;

const JOB_BODIES: Record<JobName, JobBody> = {
  'provider-health': runProviderHealth,
  'model-sync': runModelSync,
  'usage-reconcile': runUsageReconcile,
  'log-prune': runLogPrune,
};

// ─── Scheduler lifecycle (state on globalThis — survives module re-evaluation
// under hot reload; the guard prevents double-started interval sets) ─────────

type SchedulerState = {
  started: boolean;
  intervals: Map<JobName, ReturnType<typeof setInterval>>;
  delays: Map<JobName, ReturnType<typeof setTimeout>>;
  intervalMs: Map<JobName, number>;
};

// module-level flag (same instance) + globalThis flag (across instances)
let moduleStarted = false;

function schedulerState(): SchedulerState {
  const g = globalThis as typeof globalThis & { __emoraiJobScheduler?: SchedulerState };
  let state = g.__emoraiJobScheduler;
  if (!state) {
    state = { started: false, intervals: new Map(), delays: new Map(), intervalMs: new Map() };
    g.__emoraiJobScheduler = state;
  }
  return state;
}

/** Fixed fallbacks if a settings read fails during (re-)registration. */
const FALLBACK_CADENCE_MS: Record<JobName, number> = {
  'provider-health': 15 * 60_000,
  'model-sync': 6 * 3_600_000,
  'usage-reconcile': 60 * 60_000,
  'log-prune': 24 * 3_600_000,
};

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Effective interval for a job — settings-driven jobs are read fresh. */
async function cadenceMsFor(job: JobName): Promise<number> {
  switch (job) {
    case 'provider-health': {
      let minutes = 15;
      try {
        minutes = (await getSettings()).jobs.healthCheckMin;
      } catch {
        minutes = 15; // settings unreadable → documented default
      }
      return clampInt(minutes, 1, 1440) * 60_000;
    }
    case 'model-sync': {
      let hours = 6;
      try {
        hours = (await getSettings()).jobs.modelSyncHrs;
      } catch {
        hours = 6;
      }
      return clampInt(hours, 1, 168) * 3_600_000;
    }
    case 'usage-reconcile':
      return 60 * 60_000;
    case 'log-prune':
      return 24 * 3_600_000;
  }
}

function registerInterval(job: JobName, ms: number): void {
  const state = schedulerState();
  const existing = state.intervals.get(job);
  if (existing) clearInterval(existing);
  const handle = setInterval(() => {
    void tick(job);
  }, ms);
  state.intervals.set(job, handle);
  state.intervalMs.set(job, ms);
}

/** One scheduler cycle: run, then re-read the cadence (settings may have changed). */
async function tick(job: JobName): Promise<void> {
  await runJobNow(job); // never throws (failures land in the JobRun row)
  try {
    const fresh = await cadenceMsFor(job);
    if (schedulerState().intervalMs.get(job) !== fresh) {
      registerInterval(job, fresh);
    }
  } catch {
    // cadence re-read failed — keep the current interval
  }
}

/** First execution ~10s after boot (staggered per job), then steady cadence. */
function scheduleFirstRun(job: JobName, delayMs: number): void {
  const state = schedulerState();
  const handle = setTimeout(() => {
    state.delays.delete(job);
    void tick(job);
    // steady cadence registers AFTER the first run so nothing double-fires
    void cadenceMsFor(job)
      .then((ms) => registerInterval(job, ms))
      .catch(() => registerInterval(job, FALLBACK_CADENCE_MS[job]));
  }, delayMs);
  state.delays.set(job, handle);
}

/**
 * Starts the scheduler exactly once per server process. Idempotent across hot
 * reloads (module-level + globalThis guards). Called from
 * src/instrumentation.ts `register()` only.
 */
export function startScheduler(): void {
  const state = schedulerState();
  if (moduleStarted || state.started) return; // double-start guard
  moduleStarted = true;
  state.started = true;
  // small initial delays so the server settles first; staggered to avoid a burst
  scheduleFirstRun('provider-health', 10_000);
  scheduleFirstRun('model-sync', 15_000);
  scheduleFirstRun('usage-reconcile', 20_000);
  scheduleFirstRun('log-prune', 30_000);
  console.log('[jobs] scheduler started:', JOB_NAMES.join(', '));
}

/** Whether the scheduler is live in THIS server process (ops reporting). */
export function schedulerRunning(): boolean {
  return schedulerState().started;
}

/** Clears every timer and resets the guards (testability/completeness). */
export function stopScheduler(): void {
  const state = schedulerState();
  for (const handle of state.intervals.values()) clearInterval(handle);
  for (const handle of state.delays.values()) clearTimeout(handle);
  state.intervals.clear();
  state.delays.clear();
  state.intervalMs.clear();
  state.started = false;
  moduleStarted = false;
}

// ─── JobRun wrapping ─────────────────────────────────────────────────────────

export type FinishedJobRun = {
  id: string;
  jobName: string;
  status: string;
  startedAt: Date;
  finishedAt: Date | null;
  result: Prisma.JsonValue | null;
  errorText: string | null;
};

/**
 * Runs one job NOW — used by the admin endpoint (POST /api/ops/jobs) and by the
 * scheduler's timers. Every execution is recorded as a JobRun row: created
 * 'running', finalized 'success' | 'failed' | 'skipped'. Never throws.
 */
export async function runJobNow(jobName: JobName): Promise<FinishedJobRun> {
  const row = await db.jobRun.create({ data: { jobName, status: 'running' } });
  try {
    const result = await JOB_BODIES[jobName]();
    const finished = await db.jobRun.update({
      where: { id: row.id },
      data: { status: 'success', finishedAt: new Date(), result: result as unknown as Prisma.InputJsonValue },
    });
    logRun(finished);
    return finished;
  } catch (e) {
    if (e instanceof SkippedJob) {
      const finished = await db.jobRun.update({
        where: { id: row.id },
        data: { status: 'skipped', finishedAt: new Date(), result: { reason: e.message } as unknown as Prisma.InputJsonValue },
      });
      logRun(finished);
      return finished;
    }
    const errorText = truncateError(e, 1000);
    console.error(`[jobs] ${jobName} failed:`, errorText);
    const finished = await db.jobRun.update({
      where: { id: row.id },
      data: { status: 'failed', finishedAt: new Date(), errorText },
    });
    return finished;
  }
}

function logRun(row: FinishedJobRun): void {
  const ms = row.finishedAt ? row.finishedAt.getTime() - row.startedAt.getTime() : null;
  console.log(`[jobs] ${row.jobName} → ${row.status}${ms != null ? ` (${ms}ms)` : ''}`);
}

// ─── Shared helpers ──────────────────────────────────────────────────────────

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}

function truncateError(e: unknown, max: number): string {
  const raw = String((e as { message?: unknown })?.message ?? e);
  return truncate(raw, max);
}

/** Updates an account's health snapshot; never throws (row may be gone mid-run). */
async function setAccountHealth(accountId: string, status: 'ok' | 'error', errorTextValue: string | null): Promise<void> {
  try {
    await db.providerAccount.update({
      where: { id: accountId },
      data: { lastCheckedAt: new Date(), lastStatus: status, lastError: errorTextValue },
    });
  } catch {
    // account deleted mid-run — nothing to update
  }
}

// alert dedup windows
const PROVIDER_ALERT_DEDUPE_MS = 6 * 60 * 60 * 1000; // warning + critical: once per 6h per account
const MODEL_SYNC_DEDUPE_MS = 24 * 60 * 60 * 1000; // info: once per 24h per account

/** Whether an account already has an alert of a category inside the window —
 *  Prisma/SQLite cannot filter JSON columns, so the guard is one findMany +
 *  client-side filter (the billing.ts house pattern). Guard-read failure →
 *  dedup skipped (one extra alert beats silence). */
async function recentAlertsForAccount(category: string, accountId: string, windowMs: number): Promise<boolean> {
  try {
    const recent = await db.alertEvent.findMany({
      where: { category, createdAt: { gte: new Date(Date.now() - windowMs) } },
      select: { meta: true },
    });
    return recent.some((r) => ((r.meta ?? {}) as { accountId?: unknown }).accountId === accountId);
  } catch {
    return false;
  }
}

/** Records an AlertEvent; never throws and never breaks a job. */
async function recordAlert(
  level: 'info' | 'warning' | 'critical',
  category: string,
  message: string,
  meta: Record<string, unknown>
): Promise<void> {
  try {
    await db.alertEvent.create({
      data: {
        level,
        category,
        message: truncate(message, 1000),
        meta: meta as unknown as Prisma.InputJsonValue,
      },
    });
  } catch {
    // alerting is record-only and must never break a job
  }
}

// ─── provider-health ─────────────────────────────────────────────────────────
// For each enabled ProviderAccount: platform-managed/zai accounts are skipped
// honestly (no independent health endpoint, lastStatus untouched). openai /
// anthropic / self-hosted accounts are probed through their adapter's
// checkHealth(); failures update the account snapshot, and a provider that is
// unhealthy across 2 consecutive runs raises a critical AlertEvent (dedup 6h
// per account). Credential preparation failures raise a warning (dedup 6h per
// account).

type HealthEntry = {
  id: string;
  name: string;
  status: 'ok' | 'error' | 'skipped';
  detail: string;
};

async function runProviderHealth(): Promise<Record<string, unknown>> {
  const accounts = await db.providerAccount.findMany({
    where: { enabled: true },
    orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
  });
  const previous = await previousHealthStatuses();
  const entries: HealthEntry[] = [];

  for (const account of accounts) {
    // Platform-managed accounts (e.g. the bundled Z.ai installation account)
    // have no independent health endpoint — probing one would fabricate a
    // status the platform does not expose. Honest skip; lastStatus untouched.
    if (account.providerType === 'zai' || account.credentialMode === 'platform') {
      entries.push({ id: account.id, name: account.name, status: 'skipped', detail: 'platform-managed, no independent health endpoint' });
      continue;
    }

    const adapter = getAdapterByType(account.providerType);
    if (!adapter) {
      const detail = `no adapter registered for provider type "${account.providerType}"`;
      entries.push({ id: account.id, name: account.name, status: 'error', detail });
      await setAccountHealth(account.id, 'error', detail);
      continue;
    }

    // credential preparation (decrypt failures are honest errors — never probed)
    let ctx: AdapterContext;
    try {
      ctx = adapterContextForAccount(account);
    } catch (e) {
      const detail = truncateError(e, 300);
      entries.push({ id: account.id, name: account.name, status: 'error', detail });
      await setAccountHealth(account.id, 'error', detail);
      if (!(await recentAlertsForAccount('provider_health', account.id, PROVIDER_ALERT_DEDUPE_MS))) {
        await recordAlert('warning', 'provider_health', `Provider account "${account.name}" could not be health-checked — credentials could not be prepared: ${detail}`, {
          accountId: account.id,
          accountName: account.name,
          kind: 'credential_error',
          detail,
        });
      }
      continue;
    }

    // the probe itself — adapters normalize upstream failures to ProviderHealth
    let health: ProviderHealth;
    try {
      health = await adapter.checkHealth(ctx);
    } catch (e) {
      health = { ok: false, latencyMs: 0, message: truncateError(e, 300) };
    }

    if (health.ok) {
      entries.push({ id: account.id, name: account.name, status: 'ok', detail: `healthy (${health.latencyMs} ms)` });
      await setAccountHealth(account.id, 'ok', null);
    } else {
      const detail = health.message ? truncate(health.message, 300) : 'unhealthy';
      entries.push({ id: account.id, name: account.name, status: 'error', detail });
      await setAccountHealth(account.id, 'error', detail);
      // escalation: unhealthy across 2 consecutive runs → critical alert
      if (previous.get(account.id) === 'error') {
        if (!(await recentAlertsForAccount('provider_health', account.id, PROVIDER_ALERT_DEDUPE_MS))) {
          await recordAlert('critical', 'provider_health', `Provider account "${account.name}" is unhealthy across 2 consecutive health checks: ${detail}`, {
            accountId: account.id,
            accountName: account.name,
            kind: 'consecutive_unhealthy',
            runs: 2,
            detail,
          });
        }
      }
    }
  }

  return {
    accounts: entries,
    summary: {
      checked: entries.filter((e) => e.status !== 'skipped').length,
      ok: entries.filter((e) => e.status === 'ok').length,
      error: entries.filter((e) => e.status === 'error').length,
      skipped: entries.filter((e) => e.status === 'skipped').length,
    },
  };
}

/**
 * Per-account status of the previous SUCCESSFUL provider-health run, from its
 * result JSON — the persistence layer for "2 consecutive unhealthy runs"
 * (in-memory state would not survive restarts). The current run is still
 * 'running' when the body executes, so the latest 'success' row IS the
 * previous run.
 */
async function previousHealthStatuses(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const rows = await db.jobRun.findMany({
      where: { jobName: 'provider-health', status: 'success' },
      orderBy: { startedAt: 'desc' },
      take: 1,
    });
    const result = rows[0]?.result as { accounts?: Array<{ id?: unknown; status?: unknown }> } | null;
    if (result && Array.isArray(result.accounts)) {
      for (const entry of result.accounts) {
        if (entry && typeof entry.id === 'string' && typeof entry.status === 'string') {
          out.set(entry.id, entry.status);
        }
      }
    }
  } catch {
    // unreadable history → no escalation this cycle (treated as first failure)
  }
  return out;
}

// ─── model-sync ───────────────────────────────────────────────────────────────
// For each enabled account whose adapter supports('discovery'): listModels and
// compare with the adopted provider-category catalogue rows (modelId still
// discovered = present; discovered-but-not-adopted = available; adopted-but-
// gone = stale). NEVER auto-adopts. New upstream models → info AlertEvent
// (dedup 24h per account). The real API call updates the account health
// snapshot as a side effect.

type SyncEntry = {
  id: string;
  name: string;
  skipped?: string;
  error?: string;
  upstreamCount?: number;
  available?: string[];
  stale?: string[];
};

async function runModelSync(): Promise<Record<string, unknown>> {
  const accounts = await db.providerAccount.findMany({
    where: { enabled: true },
    orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
  });
  if (accounts.length === 0) throw new SkippedJob('no enabled provider accounts to sync');

  // adopted = provider-category catalogue rows (adoption is ALWAYS an explicit
  // administrator action — discovery never publishes anything)
  const adoptedRows = await db.modelConfig.findMany({
    where: { category: 'provider' },
    select: { modelId: true, provider: true },
  });
  const adoptedByProvider = new Map<string, Set<string>>();
  for (const row of adoptedRows) {
    const key = row.provider.trim().toLowerCase();
    const set = adoptedByProvider.get(key) ?? new Set<string>();
    set.add(row.modelId);
    adoptedByProvider.set(key, set);
  }

  const entries: SyncEntry[] = [];
  for (const account of accounts) {
    const adapter = getAdapterByType(account.providerType);
    if (!adapter || !adapter.supports('discovery')) {
      // honest: this provider exposes no listing API (e.g. the Z.ai web-dev SDK);
      // availability probing (Settings → Models → Discover) is the supported path
      entries.push({
        id: account.id,
        name: account.name,
        skipped: adapter
          ? 'adapter does not expose a model-listing API (discovery unsupported) — availability probing is the supported path'
          : `no adapter registered for provider type "${account.providerType}"`,
      });
      continue; // no upstream call was made — account health untouched
    }

    let discovered: string[];
    try {
      const ctx = adapterContextForAccount(account);
      discovered = (await adapter.listModels(ctx)).map((m) => m.modelId);
    } catch (e) {
      const detail = truncateError(e, 300);
      entries.push({ id: account.id, name: account.name, error: detail });
      await setAccountHealth(account.id, 'error', detail);
      continue;
    }

    // side effect of the real upstream call: the account demonstrably responds
    await setAccountHealth(account.id, 'ok', null);

    const adopted = adoptedByProvider.get(account.providerType.trim().toLowerCase()) ?? new Set<string>();
    const discoveredSet = new Set(discovered);
    const available = discovered.filter((id) => !adopted.has(id)).sort();
    const stale = Array.from(adopted).filter((id) => !discoveredSet.has(id)).sort();
    entries.push({ id: account.id, name: account.name, upstreamCount: discovered.length, available, stale });

    if (available.length > 0) {
      await alertNewUpstreamModels(account, available);
    }
  }

  return {
    accounts: entries,
    note: 'Compared upstream listings with adopted provider-category catalogue rows; nothing is auto-adopted or auto-published — adoption stays an explicit administrator decision.',
  };
}

async function alertNewUpstreamModels(account: { id: string; name: string }, available: string[]): Promise<void> {
  if (await recentAlertsForAccount('model_sync', account.id, MODEL_SYNC_DEDUPE_MS)) return;
  const preview = available.slice(0, 10).join(', ');
  const more = available.length > 10 ? ` (+${available.length - 10} more)` : '';
  await recordAlert('info', 'model_sync', `Provider account "${account.name}" exposes ${available.length} upstream model(s) not adopted yet: ${preview}${more}. Adoption is a manual administrator decision — nothing was auto-adopted.`, {
    accountId: account.id,
    accountName: account.name,
    available,
  });
}

// ─── usage-reconcile ──────────────────────────────────────────────────────────
// Last 24h UsageRecords vs CostLedger rows: records with no ledger row are
// counted and BACKFILLED (at most 200 per run) through the same idempotent
// pricing path as live accounting (recordCostForUsage). Ledger rows without a
// matching usage record are report-only (never deleted).

async function runUsageReconcile(): Promise<Record<string, unknown>> {
  const BACKFILL_CAP = 200;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const usage = await db.usageRecord.findMany({
    where: { createdAt: { gte: since } },
    select: {
      id: true,
      apiKeyId: true,
      providerAccountId: true,
      modelId: true,
      servedModel: true,
      promptTokens: true,
      completionTokens: true,
      routeId: true,
    },
    orderBy: { createdAt: 'asc' },
  });
  const ledger = await db.costLedger.findMany({
    where: { createdAt: { gte: since } },
    select: { usageRecordId: true },
  });

  const usageIds = new Set(usage.map((u) => u.id));
  // ledger rows matching a usage record in the window (ledger rows are written
  // at or after their usage record, so window coverage is exact)
  const ledgeredIds = new Set(ledger.filter((l) => usageIds.has(l.usageRecordId)).map((l) => l.usageRecordId));

  const missing = usage.filter((u) => !ledgeredIds.has(u.id));
  const toBackfill = missing.slice(0, BACKFILL_CAP); // oldest first

  let backfilled = 0;
  const backfillErrors: string[] = [];
  for (const u of toBackfill) {
    try {
      await recordCostForUsage({
        id: u.id,
        apiKeyId: u.apiKeyId,
        providerAccountId: u.providerAccountId,
        modelId: u.modelId,
        servedModel: u.servedModel,
        promptTokens: u.promptTokens,
        completionTokens: u.completionTokens,
        routeId: u.routeId,
      });
      backfilled++;
    } catch (e) {
      backfillErrors.push(`${u.id}: ${truncateError(e, 160)}`);
    }
  }

  // ledger rows in the window whose usage record is NOT in the window (usage
  // older than 24h priced late, or usage since deleted) — reported only
  const orphanLedgerRows = ledger.length - ledgeredIds.size;

  return {
    checked: usage.length,
    missingBefore: missing.length,
    backfilled,
    remaining: missing.length - backfilled,
    orphanLedgerRows,
    backfillErrors: backfillErrors.slice(0, 20),
    note: 'Backfills missing CostLedger rows (max 200 per run) via the same idempotent pricing path as live accounting; ledger rows without usage are report-only, never deleted.',
  };
}

// ─── log-prune ───────────────────────────────────────────────────────────────
// Retention: JobRuns beyond the latest 500 by startedAt are deleted;
// acknowledged AlertEvents older than 30 days are deleted; unacknowledged
// alerts are ALWAYS kept (an unacknowledged operational event may still need
// the administrator's attention).

async function runLogPrune(): Promise<Record<string, unknown>> {
  const JOB_RUN_KEEP = 500;
  const ALERT_RETENTION_DAYS = 30;

  let jobRunsDeleted = 0;
  const totalBefore = await db.jobRun.count();
  if (totalBefore > JOB_RUN_KEEP) {
    // the 500th-newest run by startedAt is the retention boundary
    const boundary = await db.jobRun.findMany({
      orderBy: { startedAt: 'desc' },
      skip: JOB_RUN_KEEP - 1,
      take: 1,
      select: { startedAt: true },
    });
    const cutoff = boundary[0]?.startedAt;
    if (cutoff) {
      jobRunsDeleted = (await db.jobRun.deleteMany({ where: { startedAt: { lt: cutoff } } })).count;
    }
  }
  const jobRunsKept = await db.jobRun.count();

  // acknowledgedAt < cutoff: rows with null acknowledgedAt never match lt — kept
  const alertCutoff = new Date(Date.now() - ALERT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const alertEventsDeleted = (
    await db.alertEvent.deleteMany({ where: { acknowledgedAt: { lt: alertCutoff } } })
  ).count;

  return {
    jobRunsDeleted,
    jobRunsKept,
    alertEventsDeleted,
    note: `JobRuns retained to the latest ${JOB_RUN_KEEP} by startedAt; acknowledged AlertEvents older than ${ALERT_RETENTION_DAYS} days pruned; unacknowledged alerts always kept.`,
  };
}

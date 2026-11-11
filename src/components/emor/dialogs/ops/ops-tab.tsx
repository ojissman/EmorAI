"use client";

// Ops tab (Phase 10, Priority 7) — jobs, alerts, live metrics and budget
// panels rendered in Settings → Ops. Data may legitimately be sparse; every
// panel renders clean empty states and honest error states with retry.

import { Loader2, Play, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Progress } from '@/components/ui/progress';
import { timeAgo } from '../provider-shared';
import {
  useAckOpsAlert,
  useOpsAlerts,
  useOpsBudgets,
  useOpsJobs,
  useOpsMetrics,
  useRunOpsJob,
  type OpsAlert,
  type OpsJobRun,
} from '@/hooks/use-ops';

function PanelError({ title, message, onRetry }: { title: string; message: string; onRetry: () => void }) {
  return (
    <div className="rounded-xl border border-destructive/40 p-4 text-center">
      <p className="text-sm font-medium text-destructive">{title}</p>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{message}</p>
      <Button variant="outline" size="sm" className="mt-3 h-9 gap-1.5" onClick={onRetry} aria-label={`Retry loading ${title}`}>
        <RefreshCw className="size-3.5" /> Retry
      </Button>
    </div>
  );
}

function PanelLoading({ rows = 2 }: { rows?: number }) {
  return (
    <div className="space-y-2.5" aria-busy="true">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-16 w-full rounded-xl" />
      ))}
    </div>
  );
}

function jobStatusBadge(status: string) {
  if (status === 'running') {
    return (
      <Badge variant="outline" className="gap-1 border-amber-500/40 text-[10px] text-amber-600 dark:text-amber-400">
        <Loader2 className="size-2.5 animate-spin" /> Running
      </Badge>
    );
  }
  if (status === 'success') {
    return (
      <Badge variant="secondary" className="gap-1 text-[10px] text-emerald-600 dark:text-emerald-400">
        <span className="size-1.5 rounded-full bg-emerald-500" /> Success
      </Badge>
    );
  }
  if (status === 'failed') {
    return <Badge variant="outline" className="border-destructive/40 text-[10px] text-destructive">Failed</Badge>;
  }
  return <Badge variant="outline" className="text-[10px] text-muted-foreground">{status || 'unknown'}</Badge>;
}

function alertLevelBadge(level: string) {
  if (level === 'critical') {
    return <Badge variant="outline" className="border-destructive/40 text-[10px] text-destructive">Critical</Badge>;
  }
  if (level === 'warning') {
    return (
      <Badge variant="outline" className="border-amber-500/40 text-[10px] text-amber-600 dark:text-amber-400">
        Warning
      </Badge>
    );
  }
  if (level === 'info') {
    return <Badge variant="secondary" className="text-[10px] text-violet-600 dark:text-violet-400">Info</Badge>;
  }
  return <Badge variant="outline" className="text-[10px] text-muted-foreground">{level || 'unknown'}</Badge>;
}

function accountHealthBadge(status: string | null) {
  if (status === 'ok') {
    return (
      <Badge variant="secondary" className="gap-1 text-[10px] text-emerald-600 dark:text-emerald-400">
        <span className="size-1.5 rounded-full bg-emerald-500" /> OK
      </Badge>
    );
  }
  if (status === 'error') {
    return <Badge variant="outline" className="border-destructive/40 text-[10px] text-destructive">Error</Badge>;
  }
  return <Badge variant="outline" className="text-[10px] text-muted-foreground">Not checked</Badge>;
}

function runDuration(run: OpsJobRun): string {
  if (!run.finishedAt) return '—';
  const started = Date.parse(run.startedAt);
  const finished = Date.parse(run.finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished)) return '—';
  return `${Math.max(0, (finished - started) / 1000).toFixed(1)}s`;
}

function resultTooltip(run: OpsJobRun): string {
  if (run.errorText) return run.errorText.slice(0, 400);
  if (run.result != null) {
    try {
      return JSON.stringify(run.result).slice(0, 400);
    } catch {
      return 'Result is not displayable';
    }
  }
  return 'No result recorded';
}

// ─── Jobs panel ────────────────────────────────────────────────────────────────

function JobsPanel() {
  const { data, isLoading, error, refetch } = useOpsJobs();
  const runJob = useRunOpsJob();

  const trigger = async (jobName: string) => {
    try {
      await runJob.mutateAsync(jobName);
      toast.success(`Job “${jobName}” triggered — its run will appear in the history below.`);
    } catch (e) {
      toast.error(String((e as Error).message));
    }
  };

  return (
    <section className="space-y-3" aria-label="Background jobs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">Background jobs</p>
          <p className="text-xs text-muted-foreground">
            Health checks and model re-syncs run on schedule; trigger a run manually when you need it now.
          </p>
        </div>
        <Button variant="ghost" size="sm" className="h-9 gap-1.5 text-xs" onClick={() => void refetch()} aria-label="Refresh job runs">
          <RefreshCw className="size-3" /> Refresh
        </Button>
      </div>

      {isLoading && <PanelLoading />}

      {error && (
        <PanelError
          title="Failed to load job runs"
          message={String((error as Error).message)}
          onRetry={() => void refetch()}
        />
      )}

      {!isLoading && !error && (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="outline" className="text-[10px] text-muted-foreground">
              24h runs: {data?.aggregate.total24h ?? 0}
            </Badge>
            <Badge variant="outline" className="text-[10px] text-muted-foreground">
              24h failures: {data?.aggregate.failed24h ?? 0}
            </Badge>
            {data?.scheduler.running ? (
              <Badge variant="secondary" className="gap-1 text-[10px] text-emerald-600 dark:text-emerald-400">
                <span className="size-1.5 rounded-full bg-emerald-500" /> Scheduler running
              </Badge>
            ) : (
              <Badge variant="outline" className="text-[10px] text-amber-600 dark:text-amber-400">
                Scheduler idle in this process
              </Badge>
            )}
          </div>

          <div className="space-y-2">
            {(data?.scheduler.jobs ?? []).map(({ job, cadence }) => {
              const perJob = data?.aggregate.perJob[job];
              return (
                <div key={job} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border p-3">
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">{job}</code>
                  <span className="text-xs text-muted-foreground">{cadence}</span>
                  {perJob?.lastStatus ? jobStatusBadge(perJob.lastStatus) : null}
                  {perJob?.lastStartedAt && (
                    <span className="text-xs text-muted-foreground">last {timeAgo(perJob.lastStartedAt) || '—'}</span>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    className="ml-auto h-9 gap-1.5 text-xs"
                    onClick={() => void trigger(job)}
                    disabled={runJob.isPending}
                    aria-label={`Run job ${job} now`}
                  >
                    {runJob.isPending ? <Loader2 className="size-3 animate-spin" /> : <Play className="size-3" />}
                    Run now
                  </Button>
                </div>
              );
            })}
          </div>

          {(data?.runs ?? []).length === 0 ? (
            <div className="rounded-xl border border-dashed p-6 text-center">
              <p className="text-sm font-medium">No job runs recorded</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Trigger a job above — every run (scheduled or manual) is recorded here with its result.
              </p>
            </div>
          ) : (
            <div className="emor-scroll max-h-96 space-y-2 overflow-y-auto pr-1" aria-label="Recent job runs">
              {(data?.runs ?? []).map((run) => (
                <div key={run.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border p-3">
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                    {run.jobName}
                  </code>
                  {jobStatusBadge(run.status)}
                  <span className="text-xs text-muted-foreground">Started {timeAgo(run.startedAt) || '—'}</span>
                  <span className="text-xs text-muted-foreground">Duration {runDuration(run)}</span>
                  <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground" title={resultTooltip(run)}>
                    {run.errorText ? run.errorText.slice(0, 90) : 'Result available in tooltip'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

// ─── Alerts panel ─────────────────────────────────────────────────────────────

function AlertRow({ alert }: { alert: OpsAlert }) {
  const ack = useAckOpsAlert();
  const acknowledge = async () => {
    try {
      await ack.mutateAsync(alert.id);
      toast.success('Alert acknowledged.');
    } catch (e) {
      toast.error(String((e as Error).message));
    }
  };
  return (
    <div className="rounded-xl border p-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        {alertLevelBadge(alert.level)}
        <Badge variant="outline" className="text-[10px] text-muted-foreground">{alert.category}</Badge>
        <span className="text-xs text-muted-foreground">{timeAgo(alert.createdAt) || '—'}</span>
        {alert.acknowledgedAt ? (
          <Badge variant="outline" className="text-[10px] text-emerald-600 dark:text-emerald-400">
            Acknowledged {timeAgo(alert.acknowledgedAt)}
          </Badge>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="ml-auto h-9 gap-1.5 text-xs"
            onClick={() => void acknowledge()}
            disabled={ack.isPending}
            aria-label={`Acknowledge alert ${alert.id}`}
          >
            {ack.isPending ? <Loader2 className="size-3 animate-spin" /> : null}
            Acknowledge
          </Button>
        )}
      </div>
      <p className="mt-1.5 text-sm leading-relaxed">{alert.message}</p>
    </div>
  );
}

function AlertsPanel() {
  const { data, isLoading, error, refetch } = useOpsAlerts();
  const alerts = data?.alerts ?? [];

  return (
    <section className="space-y-3" aria-label="Alert events">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">Alerts</p>
          <p className="text-xs text-muted-foreground">
            Operational events (provider health, budgets, jobs, concurrency) recorded for the administrator.
          </p>
        </div>
        <Button variant="ghost" size="sm" className="h-9 gap-1.5 text-xs" onClick={() => void refetch()} aria-label="Refresh alerts">
          <RefreshCw className="size-3" /> Refresh
        </Button>
      </div>

      {isLoading && <PanelLoading />}

      {error && (
        <PanelError
          title="Failed to load alerts"
          message={String((error as Error).message)}
          onRetry={() => void refetch()}
        />
      )}

      {!isLoading && !error && alerts.length === 0 && (
        <div className="rounded-xl border border-dashed p-6 text-center">
          <p className="text-sm font-medium">No alert events</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Nothing has tripped an alert — critical budget flips and failing provider checks appear here.
          </p>
        </div>
      )}

      {!isLoading && !error && alerts.length > 0 && (
        <div className="emor-scroll max-h-96 space-y-2 overflow-y-auto pr-1" aria-label="Recent alert events">
          {alerts.map((alert) => (
            <AlertRow key={alert.id} alert={alert} />
          ))}
        </div>
      )}
      {data?.note && <p className="text-[10px] leading-relaxed text-muted-foreground">{data.note}</p>}
    </section>
  );
}

// ─── Metrics panel (concurrency + routing + account health) ───────────────────

function MetricsPanel() {
  const { data, isLoading, error, refetch } = useOpsMetrics();

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div>
        <p className="text-sm font-medium">Live metrics</p>
        <p className="text-xs text-muted-foreground">Concurrency slots, 24-hour routing decisions, account health.</p>
      </div>
      <span className="text-[10px] text-muted-foreground">auto-refreshes every 15s</span>
    </div>
  );

  if (isLoading) {
    return (
      <section className="space-y-3" aria-label="Live metrics">
        {header}
        <PanelLoading rows={3} />
      </section>
    );
  }

  if (error) {
    return (
      <section className="space-y-3" aria-label="Live metrics">
        {header}
        <PanelError
          title="Failed to load live metrics"
          message={String((error as Error).message)}
          onRetry={() => void refetch()}
        />
      </section>
    );
  }

  const concurrency = data?.concurrency;
  const keyEntries = Object.entries(concurrency?.keys ?? {});
  const routing = data?.routing.last24h;

  return (
    <section className="space-y-4" aria-label="Live metrics">
      {header}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="rounded-xl border p-3">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Slot keys</p>
          <p className="mt-1 text-lg font-semibold">{concurrency?.totals.keys ?? 0}</p>
        </div>
        <div className="rounded-xl border p-3">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">In flight</p>
          <p className="mt-1 text-lg font-semibold">{concurrency?.totals.inFlight ?? 0}</p>
        </div>
        <div className="rounded-xl border p-3">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Queued</p>
          <p className="mt-1 text-lg font-semibold">{concurrency?.totals.queued ?? 0}</p>
        </div>
        <div className="rounded-xl border p-3">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Exhausted keys</p>
          <p className="mt-1 text-lg font-semibold">{concurrency?.totals.exhausted ?? 0}</p>
        </div>
      </div>

      {keyEntries.length > 0 && (
        <div className="emor-scroll max-h-60 space-y-1.5 overflow-y-auto pr-1" aria-label="Concurrency slot detail">
          {keyEntries.map(([key, snap]) => (
            <div key={key} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2 text-xs">
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">{key}</code>
              <span className="text-muted-foreground">in flight {snap.inFlight}</span>
              <span className="text-muted-foreground">queued {snap.queued}</span>
              <span className="text-muted-foreground">limit {snap.limit}</span>
              {snap.exhausted ? (
                <Badge variant="outline" className="ml-auto border-destructive/40 text-[10px] text-destructive">
                  Exhausted
                </Badge>
              ) : (
                <Badge variant="outline" className="ml-auto text-[10px] text-emerald-600 dark:text-emerald-400">
                  Available
                </Badge>
              )}
            </div>
          ))}
        </div>
      )}
      {keyEntries.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No bounded concurrency slots are registered yet — limits of 0 mean unlimited and stay untracked.
        </p>
      )}

      {routing && (
        <div className="rounded-xl border p-3.5">
          <p className="text-xs font-medium">Routing decisions — last 24 hours</p>
          <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-muted-foreground sm:grid-cols-4">
            <span>Total: <span className="font-medium text-foreground">{routing.total.toLocaleString()}</span></span>
            <span>Routed: <span className="font-medium text-emerald-600 dark:text-emerald-400">{routing.routed.toLocaleString()}</span></span>
            <span>Failed: <span className="font-medium text-destructive">{routing.failed.toLocaleString()}</span></span>
            <span>Direct: <span className="font-medium text-foreground">{routing.direct.toLocaleString()}</span></span>
          </div>
        </div>
      )}

      <div className="space-y-1.5">
        <p className="text-xs font-medium">Account health</p>
        {(data?.accounts ?? []).length === 0 ? (
          <p className="text-xs text-muted-foreground">No provider accounts on this installation yet.</p>
        ) : (
          (data?.accounts ?? []).map((account) => (
            <div key={account.id} className="flex items-center gap-2 rounded-lg border px-3 py-2 text-xs">
              <span className="min-w-0 truncate font-medium">{account.name}</span>
              <span className="text-muted-foreground">{account.requestCount.toLocaleString()} requests</span>
              <span className="ml-auto">{accountHealthBadge(account.lastStatus)}</span>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

// ─── Budgets panel ────────────────────────────────────────────────────────────

function BudgetsPanel() {
  const { data, isLoading, error, refetch } = useOpsBudgets();

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div>
        <p className="text-sm font-medium">Budgets</p>
        <p className="text-xs text-muted-foreground">Monthly spend per budgeted provider account.</p>
      </div>
      {data?.enforce ? (
        <Badge variant="secondary" className="gap-1 text-[10px] text-emerald-600 dark:text-emerald-400">
          <span className="size-1.5 rounded-full bg-emerald-500" /> Enforcement on
        </Badge>
      ) : (
        <Badge variant="outline" className="text-[10px] text-muted-foreground">Reporting only</Badge>
      )}
    </div>
  );

  if (isLoading) {
    return (
      <section className="space-y-3" aria-label="Budgets">
        {header}
        <PanelLoading />
      </section>
    );
  }

  if (error) {
    return (
      <section className="space-y-3" aria-label="Budgets">
        {header}
        <PanelError
          title="Failed to load budgets"
          message={String((error as Error).message)}
          onRetry={() => void refetch()}
        />
      </section>
    );
  }

  const rows = data?.accounts ?? [];
  const totals = data?.totals;

  return (
    <section className="space-y-3" aria-label="Budgets">
      {header}

      {rows.length === 0 ? (
        <div className="rounded-xl border border-dashed p-6 text-center">
          <p className="text-sm font-medium">No budgeted accounts</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Set a monthly budget on a provider account (Providers tab) to track spend here.
          </p>
        </div>
      ) : (
        <div className="emor-scroll max-h-96 space-y-2 overflow-y-auto pr-1" aria-label="Account budgets">
          {rows.map((row) => {
            const budgetValue = row.budget !== null ? Number(row.budget) : null;
            const spentValue = Number(row.spent);
            const ratio =
              budgetValue !== null && Number.isFinite(budgetValue) && budgetValue > 0 && Number.isFinite(spentValue)
                ? Math.min(1, spentValue / budgetValue)
                : null;
            return (
              <div key={row.accountId} className="rounded-xl border p-3.5">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
                  <span className="text-sm font-medium">{row.name}</span>
                  {row.overBudget && (
                    <Badge variant="outline" className="border-destructive/40 text-[10px] text-destructive">
                      Over budget
                    </Badge>
                  )}
                  {row.currency && <Badge variant="outline" className="text-[10px] text-muted-foreground">{row.currency}</Badge>}
                  <span className="ml-auto font-mono text-xs text-muted-foreground" title="Exact decimal strings from the ledger">
                    {row.spent} / {row.budget ?? 'no budget'}
                  </span>
                </div>
                {ratio !== null && (
                  <Progress value={Math.round(ratio * 100)} className="mt-2.5 h-1.5" aria-label={`Spend ratio for ${row.name}`} />
                )}
                <p className="mt-1.5 text-[11px] text-muted-foreground">
                  {row.pricedCount} priced · {row.unpricedCount} unpriced ledger rows
                  {row.enforced ? ' · enforced' : ' · not enforced'}
                </p>
              </div>
            );
          })}
        </div>
      )}

      {totals && (
        <p className="text-[11px] text-muted-foreground">
          {totals.accounts} budgeted account{totals.accounts === 1 ? '' : 's'} · {totals.overBudget} over budget ·{' '}
          {totals.pricedCount} priced · {totals.unpricedCount} unpriced rows
        </p>
      )}
      {data?.note && <p className="text-[10px] leading-relaxed text-muted-foreground">{data.note}</p>}
    </section>
  );
}

export function OpsTab() {
  return (
    <div className="space-y-7">
      <JobsPanel />
      <AlertsPanel />
      <MetricsPanel />
      <BudgetsPanel />
    </div>
  );
}

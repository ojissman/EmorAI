'use client';

import { useQuery } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  Coins,
  KeyRound,
  RefreshCw,
  XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import {
  getPlaygroundKey,
  getPlaygroundKeyServerSnapshot,
  subscribePlaygroundKey,
} from './key-vault';

// ─── Types (verified against src/app/api/v1/usage/route.ts — snake_case!) ─────

type V1UsageReport = {
  object: string;
  api_key: { name: string };
  window_days: number;
  totals: {
    requests: number;
    failed: number;
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  by_model: { model_id: string; requests: number; total_tokens: number }[];
  recent: {
    id: string;
    model_id: string;
    served_model: string | null;
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    success: boolean;
    created: string;
  }[];
};

type UsageResult =
  | { ok: true; report: V1UsageReport }
  | { ok: false; status: number; message: string };

const BAR_TONES = [
  'bg-emerald-500/70',
  'bg-violet-500/70',
  'bg-amber-500/70',
  'bg-red-500/70',
  'bg-teal-500/70',
];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function formatInt(n: number): string {
  return n.toLocaleString();
}

// ─── Fetcher ──────────────────────────────────────────────────────────────────

async function fetchV1Usage(key: string): Promise<UsageResult> {
  const res = await fetch('/api/v1/usage?days=7', {
    headers: { Authorization: `Bearer ${key}` },
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const message =
      isRecord(body) && isRecord(body.error) && typeof body.error.message === 'string'
        ? body.error.message
        : `Request failed with status ${res.status}`;
    return { ok: false, status: res.status, message };
  }
  if (!isRecord(body)) return { ok: false, status: res.status, message: 'Unexpected response body.' };
  return { ok: true, report: body as unknown as V1UsageReport };
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: typeof Activity;
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 text-muted-foreground">
        <Icon className="size-4" />
        <span className="text-xs font-medium uppercase tracking-wide">{label}</span>
      </div>
      <p className="mt-2 font-mono text-2xl font-semibold">{value}</p>
      {sub ? <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p> : null}
    </Card>
  );
}

function EmptyKeyState({ onNavigate }: { onNavigate?: (tab: string) => void }) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-muted">
          <KeyRound className="size-6 text-muted-foreground" />
        </span>
        <div>
          <p className="font-medium">A playground key is required</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            <code className="font-mono text-xs">GET /api/v1/usage</code> reports usage for the
            presenting Bearer key. Paste your key in the{' '}
            <span className="font-medium text-foreground">Playground</span> tab (it is stored only in
            this browser) and come back.
          </p>
        </div>
        {onNavigate ? (
          <Button variant="outline" size="sm" onClick={() => onNavigate('playground')}>
            Open Playground
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ─── Exported Usage tab ───────────────────────────────────────────────────────

export function UsagePanel({
  active,
  onNavigate,
}: {
  active: boolean;
  onNavigate?: (tab: string) => void;
}) {
  const playgroundKey = useSyncExternalStore(
    subscribePlaygroundKey,
    getPlaygroundKey,
    getPlaygroundKeyServerSnapshot
  );

  const query = useQuery({
    queryKey: ['v1-usage', playgroundKey],
    queryFn: () => fetchV1Usage(playgroundKey),
    enabled: active && playgroundKey.length > 0,
    staleTime: 15_000,
  });

  if (playgroundKey.length === 0) {
    return (
      <div className="mx-auto max-w-4xl">
        <EmptyKeyState onNavigate={onNavigate} />
      </div>
    );
  }

  if (query.isLoading) {
    return (
      <div className="mx-auto max-w-4xl space-y-4">
        <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (query.isError || !query.data) {
    return (
      <div className="mx-auto max-w-4xl">
        <Alert variant="destructive">
          <AlertTitle>Could not load usage</AlertTitle>
          <AlertDescription>
            {query.error instanceof Error ? query.error.message : 'Unknown error.'}
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  if (!query.data.ok) {
    return (
      <div className="mx-auto max-w-4xl space-y-4">
        <Alert variant="destructive">
          <XCircle className="size-4" />
          <AlertTitle>
            Request failed with status {query.data.status}
            {query.data.status === 401 ? ' (401 unauthorized)' : ''}
          </AlertTitle>
          <AlertDescription>
            {query.data.status === 401
              ? 'The stored playground key was rejected — it may have been revoked or deleted. Save a fresh key in the Playground tab.'
              : query.data.message}
          </AlertDescription>
        </Alert>
        <Button variant="outline" size="sm" onClick={() => void query.refetch()} className="gap-1.5">
          <RefreshCw className="size-3.5" /> Retry
        </Button>
      </div>
    );
  }

  const { report } = query.data;
  const maxTokens = Math.max(1, ...report.by_model.map((m) => m.total_tokens));

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Key <span className="font-medium text-foreground">{report.api_key.name}</span> · last{' '}
          {report.window_days} days
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
          className="gap-1.5"
        >
          <RefreshCw className={cn('size-3.5', query.isFetching && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-4">
        <StatCard
          icon={Activity}
          label="Requests"
          value={formatInt(report.totals.requests)}
          sub={report.totals.failed > 0 ? `${report.totals.failed} failed` : 'no failures'}
        />
        <StatCard
          icon={ArrowUpRight}
          label="Prompt tokens"
          value={formatInt(report.totals.prompt_tokens)}
        />
        <StatCard
          icon={ArrowDownRight}
          label="Completion tokens"
          value={formatInt(report.totals.completion_tokens)}
        />
        <StatCard
          icon={Coins}
          label="Total tokens"
          value={formatInt(report.totals.total_tokens)}
        />
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Tokens by model</CardTitle>
          <CardDescription>Share of total tokens over the window.</CardDescription>
        </CardHeader>
        <CardContent>
          {report.by_model.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No usage recorded in this window yet.
            </p>
          ) : (
            <div className="space-y-3">
              {report.by_model.map((m, i) => (
                <div key={m.model_id}>
                  <div className="mb-1 flex items-center justify-between text-sm">
                    <span className="font-mono text-xs">{m.model_id}</span>
                    <span className="font-mono text-xs text-muted-foreground">
                      {formatInt(m.total_tokens)} tokens · {formatInt(m.requests)} req
                    </span>
                  </div>
                  <div className="h-2.5 overflow-hidden rounded-full bg-muted">
                    <div
                      className={cn('h-full rounded-full', BAR_TONES[i % BAR_TONES.length])}
                      style={{ width: `${Math.max(2, (m.total_tokens / maxTokens) * 100)}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Recent requests</CardTitle>
          <CardDescription>Latest 50 records for this key.</CardDescription>
        </CardHeader>
        <CardContent>
          {report.recent.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No requests recorded yet — try the Playground tab.
            </p>
          ) : (
            <div className="max-h-96 overflow-y-auto overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Time</TableHead>
                    <TableHead>Model</TableHead>
                    <TableHead className="text-right">Tokens</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {report.recent.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {new Date(r.created).toLocaleString()}
                      </TableCell>
                      <TableCell>
                        <span className="font-mono text-xs">{r.model_id}</span>
                        {r.served_model && r.served_model !== r.model_id ? (
                          <span className="ml-1.5 text-xs text-muted-foreground">
                            ({r.served_model})
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right font-mono text-xs">
                        {formatInt(r.total_tokens)}
                        <span className="ml-1 text-muted-foreground">
                          ({formatInt(r.prompt_tokens)}+{formatInt(r.completion_tokens)})
                        </span>
                      </TableCell>
                      <TableCell>
                        {r.success ? (
                          <span className="inline-flex items-center rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                            OK
                          </span>
                        ) : (
                          <span className="inline-flex items-center rounded-full border border-red-500/20 bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-600 dark:text-red-400">
                            Failed
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}



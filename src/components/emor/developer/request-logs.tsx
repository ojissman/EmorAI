'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw, ScrollText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import { useUsage } from '@/hooks/use-emor-queries';

// ─── Protocol badge ──────────────────────────────────────────────────────────

function ProtocolBadge({ protocol }: { protocol: string | null }) {
  const p = protocol ?? 'dashboard';
  const styles: Record<string, string> = {
    openai: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
    anthropic: 'border-violet-500/20 bg-violet-500/10 text-violet-600 dark:text-violet-400',
    dashboard: 'border-border bg-muted text-muted-foreground',
    internal: 'border-border bg-muted text-muted-foreground',
  };
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold uppercase',
        styles[p] ?? styles.dashboard
      )}
    >
      {p}
    </span>
  );
}

function StatusPill({ status, success }: { status: number | null; success: boolean }) {
  const s = status ?? (success ? 200 : 500);
  const tone =
    s < 300
      ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
      : s < 500
        ? 'border-amber-500/20 bg-amber-500/10 text-amber-600 dark:text-amber-400'
        : 'border-red-500/20 bg-red-500/10 text-red-600 dark:text-red-400';
  return (
    <span className={cn('inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold', tone)}>
      {s}
    </span>
  );
}

// ─── Request logs panel ──────────────────────────────────────────────────────

export function RequestLogs({ active }: { active: boolean }) {
  const [protocolFilter, setProtocolFilter] = useState<'all' | 'openai' | 'anthropic'>('all');
  const { data, isLoading, isFetching, refetch } = useUsage(30, active);

  if (!active) return null;

  const records = (data?.records ?? []).filter(
    (r) => r.source === 'api' && (protocolFilter === 'all' || r.protocol === protocolFilter)
  );
  const byProtocol = data?.byProtocol ?? [];
  const byEndpoint = data?.byEndpoint ?? [];

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <ScrollText className="size-4 text-muted-foreground" />
            <CardTitle className="text-base">Request logs</CardTitle>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex rounded-md border bg-muted/40 p-0.5" role="tablist" aria-label="Protocol filter">
              {(['all', 'openai', 'anthropic'] as const).map((f) => (
                <button
                  key={f}
                  role="tab"
                  aria-selected={protocolFilter === f}
                  onClick={() => setProtocolFilter(f)}
                  className={cn(
                    'rounded px-2.5 py-1 text-xs font-medium transition-colors',
                    protocolFilter === f
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {f === 'all' ? 'All' : f === 'openai' ? 'OpenAI' : 'Anthropic'}
                </button>
              ))}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void refetch()}
              disabled={isFetching}
              className="gap-1.5"
            >
              <RefreshCw className={cn('size-3.5', isFetching && 'animate-spin')} />
              Refresh
            </Button>
          </div>
        </div>
        <CardDescription>
          Every gateway request with its wire protocol, endpoint, status and latency — the last 30
          days.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Protocol + endpoint summary */}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border p-3">
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              By protocol
            </p>
            {byProtocol.length === 0 ? (
              <p className="text-sm text-muted-foreground">No gateway traffic yet.</p>
            ) : (
              <div className="space-y-1.5">
                {byProtocol
                  .filter((p) => p.protocol === 'openai' || p.protocol === 'anthropic')
                  .map((p) => (
                    <div key={p.protocol} className="flex items-center justify-between text-sm">
                      <ProtocolBadge protocol={p.protocol} />
                      <span className="font-mono text-xs text-muted-foreground">
                        {p.requests.toLocaleString()} req · {p.failed} failed ·{' '}
                        {p.totalTokens.toLocaleString()} tok
                      </span>
                    </div>
                  ))}
              </div>
            )}
          </div>
          <div className="rounded-lg border p-3">
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Top endpoints
            </p>
            {byEndpoint.length === 0 ? (
              <p className="text-sm text-muted-foreground">—</p>
            ) : (
              <div className="space-y-1">
                {byEndpoint.slice(0, 5).map((e) => (
                  <div key={e.endpoint} className="flex items-center justify-between gap-2 text-xs">
                    <code className="truncate font-mono">{e.endpoint}</code>
                    <span className="shrink-0 font-mono text-muted-foreground">
                      {e.requests} req · {e.failed} err
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Logs table */}
        {isLoading ? (
          <div className="space-y-2">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : records.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <ScrollText className="size-8 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">
              No gateway requests logged yet — connect an agent or try the Playground.
            </p>
          </div>
        ) : (
          <div className="max-h-96 overflow-y-auto overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Protocol</TableHead>
                  <TableHead>Endpoint</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead className="text-right">Tokens</TableHead>
                  <TableHead className="text-right">Latency</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {records.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {new Date(r.createdAt).toLocaleString()}
                    </TableCell>
                    <TableCell>
                      <ProtocolBadge protocol={r.protocol} />
                    </TableCell>
                    <TableCell className="max-w-52 truncate font-mono text-xs">
                      {r.endpoint ?? '—'}
                    </TableCell>
                    <TableCell>
                      <span className="font-mono text-xs">{r.modelId}</span>
                      {r.servedModel && r.servedModel !== r.modelId ? (
                        <span className="ml-1 text-[10px] text-muted-foreground">
                          ({r.servedModel})
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right font-mono text-xs">
                      {r.totalTokens > 0 ? r.totalTokens.toLocaleString() : '—'}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right font-mono text-xs text-muted-foreground">
                      {r.latencyMs != null ? `${(r.latencyMs / 1000).toFixed(1)}s` : '—'}
                    </TableCell>
                    <TableCell>
                      <StatusPill status={r.statusCode} success={r.success} />
                      {!r.success && r.errorText ? (
                        <p className="mt-0.5 max-w-48 truncate text-[10px] text-muted-foreground" title={r.errorText}>
                          {r.errorText}
                        </p>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

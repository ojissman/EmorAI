"use client";

import { Loader2, TrendingUp } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useUsage } from '@/hooks/use-emor-queries';
import { useEmorStore } from '@/stores/emor-store';

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border p-3.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold tracking-tight">{value}</p>
      {sub && <p className="mt-0.5 text-[11px] text-muted-foreground">{sub}</p>}
    </div>
  );
}

export function UsageDialog() {
  const dialog = useEmorStore((s) => s.dialog);
  const closeDialog = useEmorStore((s) => s.closeDialog);
  const [days, setDays] = useState(30);
  const { data, isLoading } = useUsage(days, dialog === 'usage');

  const chartData = useMemo(() => {
    const map = new Map((data?.byDay ?? []).map((d) => [d.date, d]));
    const out: { date: string; requests: number; totalTokens: number }[] = [];
    for (let i = Math.min(days, 14) - 1; i >= 0; i--) {
      const date = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
      const row = map.get(date) ?? { date, requests: 0, totalTokens: 0 };
      out.push({ date: date.slice(5), requests: row.requests, totalTokens: row.totalTokens });
    }
    return out;
  }, [data, days]);

  const totals = data?.totals;

  return (
    <Dialog open={dialog === 'usage'} onOpenChange={(v) => (!v ? closeDialog() : undefined)}>
      <DialogContent className="max-h-[85vh] overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="border-b px-5 pb-4 pt-5">
          <DialogTitle className="flex items-center gap-2">
            <TrendingUp className="size-4 text-primary" /> Usage
          </DialogTitle>
          <DialogDescription>Requests and token consumption across dashboard chats and the developer API.</DialogDescription>
        </DialogHeader>
        <div className="emor-scroll overflow-y-auto px-5 py-4" style={{ maxHeight: '62vh' }}>
          <Tabs defaultValue="summary" onValueChange={(v) => setDays(v === '7d' ? 7 : v === '90d' ? 90 : 30)}>
            <TabsList className="grid w-full grid-cols-4">
              <TabsTrigger value="summary" className="text-xs">Summary</TabsTrigger>
              <TabsTrigger value="7d" className="text-xs">7 days</TabsTrigger>
              <TabsTrigger value="30d" className="text-xs">30 days</TabsTrigger>
              <TabsTrigger value="90d" className="text-xs">90 days</TabsTrigger>
            </TabsList>

            <TabsContent value="summary" className="mt-4">
              {isLoading && !totals ? (
                <p className="py-10 text-center"><Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" /></p>
              ) : (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                    <StatCard label="Requests" value={(totals?.requests ?? 0).toLocaleString()} sub={`${totals?.failed ?? 0} failed`} />
                    <StatCard label="Total tokens" value={(totals?.totalTokens ?? 0).toLocaleString()} sub="last 30 days" />
                    <StatCard label="Prompt tokens" value={(totals?.promptTokens ?? 0).toLocaleString()} />
                    <StatCard label="Completion tokens" value={(totals?.completionTokens ?? 0).toLocaleString()} />
                  </div>
                  <div className="rounded-xl border p-3">
                    <p className="mb-2 text-xs font-medium text-muted-foreground">Requests per day (14 days)</p>
                    <div className="h-44">
                      <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: -18 }}>
                          <defs>
                            <linearGradient id="usage-fill" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="0%" stopColor="var(--primary)" stopOpacity={0.35} />
                              <stop offset="100%" stopColor="var(--primary)" stopOpacity={0.02} />
                            </linearGradient>
                          </defs>
                          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                          <XAxis dataKey="date" tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }} tickLine={false} axisLine={false} />
                          <YAxis tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }} tickLine={false} axisLine={false} allowDecimals={false} />
                          <ChartTooltip
                            contentStyle={{
                              background: 'var(--popover)',
                              border: '1px solid var(--border)',
                              borderRadius: 10,
                              fontSize: 12,
                              color: 'var(--popover-foreground)',
                            }}
                          />
                          <Area type="monotone" dataKey="requests" stroke="var(--primary)" strokeWidth={2} fill="url(#usage-fill)" />
                        </AreaChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                  {(data?.byModel ?? []).length > 0 && (
                    <div className="rounded-xl border p-3">
                      <p className="mb-2 text-xs font-medium text-muted-foreground">By model</p>
                      <div className="space-y-1.5">
                        {data!.byModel.map((m) => (
                          <div key={m.modelId} className="flex items-center justify-between text-xs">
                            <code className="text-muted-foreground">{m.modelId}</code>
                            <span>
                              {m.requests.toLocaleString()} req · {m.totalTokens.toLocaleString()} tokens
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </TabsContent>

            {['7d', '30d', '90d'].map((tab) => (
              <TabsContent key={tab} value={tab} className="mt-4">
                {isLoading ? (
                  <p className="py-10 text-center"><Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" /></p>
                ) : (data?.records ?? []).length === 0 ? (
                  <p className="py-10 text-center text-sm text-muted-foreground">No usage recorded in this window.</p>
                ) : (
                  <div className="space-y-2">
                    <div className="grid grid-cols-3 gap-2.5">
                      <StatCard label="Requests" value={(totals?.requests ?? 0).toLocaleString()} />
                      <StatCard label="Tokens" value={(totals?.totalTokens ?? 0).toLocaleString()} />
                      <StatCard label="Failed" value={(totals?.failed ?? 0).toLocaleString()} />
                    </div>
                    <div className="rounded-xl border">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="border-b text-left text-muted-foreground">
                            <th className="px-3 py-2 font-medium">When</th>
                            <th className="px-3 py-2 font-medium">Source</th>
                            <th className="px-3 py-2 font-medium">Model</th>
                            <th className="px-3 py-2 text-right font-medium">Tokens</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data!.records.slice(0, 40).map((r) => (
                            <tr key={r.id} className="border-b last:border-0">
                              <td className="px-3 py-1.5 text-muted-foreground">
                                {new Date(r.createdAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
                              </td>
                              <td className="px-3 py-1.5">{r.source === 'api' ? 'API' : 'Dashboard'}</td>
                              <td className="px-3 py-1.5"><code className="text-muted-foreground">{r.modelId}</code></td>
                              <td className="px-3 py-1.5 text-right">{r.totalTokens.toLocaleString()}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </TabsContent>
            ))}
          </Tabs>
        </div>
      </DialogContent>
    </Dialog>
  );
}

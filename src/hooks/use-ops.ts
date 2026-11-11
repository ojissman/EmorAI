"use client";

// Ops panel hooks (Phase 10, Priority 7) — live operational snapshot queries
// for the Settings → Ops tab. All endpoints are admin-gated; 401s flow through
// the API client's session-expiry event so the admin gate handles them.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';

// ─── GET /api/ops/metrics ────────────────────────────────────────────────────

export type OpsConcurrencyKey = {
  inFlight: number;
  queued: number;
  limit: number;
  exhausted: boolean;
};

export type OpsMetrics = {
  concurrency: {
    keys: Record<string, OpsConcurrencyKey>;
    totals: { keys: number; inFlight: number; queued: number; exhausted: number };
  };
  routing: {
    last24h: { total: number; routed: number; failed: number; direct: number };
  };
  accounts: {
    id: string;
    name: string;
    lastStatus: string | null;
    requestCount: number;
  }[];
};

export function useOpsMetrics(enabled = true) {
  return useQuery({
    queryKey: ['ops', 'metrics'],
    queryFn: () => api.get<OpsMetrics>('/api/ops/metrics'),
    refetchInterval: 15_000,
    enabled,
  });
}

// ─── GET /api/ops/budgets ─────────────────────────────────────────────────────

export type OpsBudgetRow = {
  accountId: string;
  name: string;
  budget: string | null;
  spentMicro: string;
  spent: string;
  overBudget: boolean;
  enforced: boolean;
  pricedCount: number;
  unpricedCount: number;
  currency: string | null;
};

export type OpsBudgets = {
  enforce: boolean;
  accounts: OpsBudgetRow[];
  totals: { accounts: number; overBudget: number; pricedCount: number; unpricedCount: number };
  note: string;
};

export function useOpsBudgets(enabled = true) {
  return useQuery({
    queryKey: ['ops', 'budgets'],
    queryFn: () => api.get<OpsBudgets>('/api/ops/budgets'),
    enabled,
  });
}

// ─── GET /api/ops/jobs · POST {job} ───────────────────────────────────────────
// Shape verified against src/app/api/ops/jobs/route.ts (landed in parallel).

export type OpsJobRun = {
  id: string;
  jobName: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  result: unknown;
  errorText: string | null;
};

export type OpsJobs = {
  scheduler: {
    running: boolean;
    jobs: { job: string; cadence: string }[];
  };
  runs: OpsJobRun[];
  aggregate: {
    total24h: number;
    failed24h: number;
    perJob: Record<string, { lastStatus: string | null; lastStartedAt: string | null }>;
  };
};

export function useOpsJobs(enabled = true) {
  return useQuery({
    queryKey: ['ops', 'jobs'],
    queryFn: () => api.get<OpsJobs>('/api/ops/jobs'),
    refetchInterval: 30_000,
    enabled,
  });
}

/** Manual trigger — POST /api/ops/jobs {job} → { run: OpsJobRun }. */
export function useRunOpsJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (job: string) => api.post<{ run: OpsJobRun }>('/api/ops/jobs', { job }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['ops', 'jobs'] }),
  });
}

// ─── GET /api/ops/alerts · POST {id} ──────────────────────────────────────────

export type OpsAlert = {
  id: string;
  level: string;
  category: string;
  message: string;
  meta: unknown;
  acknowledgedAt: string | null;
  createdAt: string;
};

export type OpsAlerts = {
  alerts: OpsAlert[];
  note?: string;
};

export function useOpsAlerts(enabled = true) {
  return useQuery({
    queryKey: ['ops', 'alerts'],
    queryFn: () => api.get<OpsAlerts>('/api/ops/alerts'),
    refetchInterval: 30_000,
    enabled,
  });
}

/** Acknowledge one alert event — POST /api/ops/alerts {id}. */
export function useAckOpsAlert() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<Record<string, unknown>>('/api/ops/alerts', { id }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['ops', 'alerts'] }),
  });
}

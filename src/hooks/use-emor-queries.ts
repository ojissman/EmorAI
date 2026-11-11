"use client";

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import type {
  AppSettings,
  ModelCapabilities,
  ModelInfo,
  SerializedApiKey,
  SerializedConversation,
  SerializedFolder,
  SerializedMessage,
  SerializedUsageRecord,
} from '@/lib/types';

export type UsageReport = {
  windowDays: number;
  totals: { requests: number; failed: number; promptTokens: number; completionTokens: number; totalTokens: number };
  byModel: { modelId: string; requests: number; totalTokens: number }[];
  byProtocol: { protocol: string; requests: number; failed: number; totalTokens: number }[];
  byEndpoint: { endpoint: string; requests: number; failed: number }[];
  byDay: { date: string; requests: number; totalTokens: number }[];
  records: SerializedUsageRecord[];
};

export function useConversations(search: string) {
  return useQuery({
    queryKey: ['conversations', search],
    queryFn: () => api.get<{ conversations: SerializedConversation[] }>(`/api/conversations?q=${encodeURIComponent(search)}`),
  });
}

export function useConversationMessages(conversationId: string | null) {
  return useQuery({
    queryKey: ['messages', conversationId],
    queryFn: () =>
      api.get<{ messages: SerializedMessage[] }>(`/api/conversations/${conversationId}/messages`),
    enabled: !!conversationId,
  });
}

export function useFolders() {
  return useQuery({
    queryKey: ['folders'],
    queryFn: () => api.get<{ folders: SerializedFolder[] }>('/api/folders'),
  });
}

export function useModels() {
  return useQuery({
    queryKey: ['models'],
    queryFn: () => api.get<{ models: ModelInfo[] }>('/api/models'),
    staleTime: 10_000,
  });
}

export function useSettings() {
  return useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<{ settings: AppSettings }>('/api/settings'),
    staleTime: 5_000,
  });
}

export function useApiKeys(enabled = true) {
  return useQuery({
    queryKey: ['keys'],
    queryFn: () => api.get<{ keys: SerializedApiKey[] }>('/api/keys'),
    enabled,
  });
}

export function useUsage(days = 30, enabled = true) {
  return useQuery({
    queryKey: ['usage', days],
    queryFn: () => api.get<UsageReport>(`/api/usage?days=${days}`),
    enabled,
  });
}

export function useSettingsMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<AppSettings>) => api.put<{ settings: AppSettings }>('/api/settings', patch),
    onSuccess: (data) => qc.setQueryData(['settings'], { settings: data.settings }),
  });
}

// ─── Provider accounts & model routing (multi-provider dashboard) ────────────

export type ProviderRouteSummary = {
  id: string;
  publicModelId: string;
  upstreamModelId: string;
  enabled: boolean;
  priority: number;
  healthStatus: string;
};

export type ProviderAccount = {
  id: string;
  name: string;
  providerType: string;
  baseUrl: string | null;
  credentialMode: string;
  /** Masked display hint only — the raw secret never crosses the API boundary. */
  credentialHint: string | null;
  encryptionAvailable: boolean;
  enabled: boolean;
  priority: number;
  maxConcurrency: number;
  monthlyBudget: number | null;
  lastCheckedAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  requestCount: number;
  routeCount: number;
  routes: ProviderRouteSummary[];
};

export type ProvidersResponse = {
  accounts: ProviderAccount[];
  providerTypes: string[];
};

export type CreateProviderInput = {
  name: string;
  providerType: string;
  baseUrl?: string;
  apiKey?: string;
  credentialMode: 'stored' | 'platform';
  enabled: boolean;
  priority: number;
  maxConcurrency: number;
  monthlyBudget?: number | null;
};

export type UpdateProviderInput = {
  name?: string;
  baseUrl?: string | null;
  /** Rotating the credential: new raw key, encrypted at rest server-side. */
  apiKey?: string;
  clearApiKey?: boolean;
  enabled?: boolean;
  priority?: number;
  maxConcurrency?: number;
  monthlyBudget?: number | null;
};

export type ProviderValidationResponse = {
  validation: { ok: boolean; message: string; detail?: string };
  health: { ok: boolean; latencyMs: number; message?: string };
};

export type ModelRouteRow = {
  id: string;
  publicModelId: string;
  providerAccountId: string;
  upstreamModelId: string;
  priority: number;
  enabled: boolean;
  capabilities: ModelCapabilities | null;
  maxConcurrency: number;
  timeoutMs: number;
  weight: number;
  healthStatus: string;
  lastServedAt: string | null;
  lastLatencyMs: number | null;
  lastError: string | null;
  providerAccount: {
    id: string;
    name: string;
    providerType: string;
    enabled: boolean;
    lastStatus: string | null;
  };
};

/** Live eligibility plan returned when a route is created/updated. */
export type RoutePlanPreview = {
  routed: boolean;
  strategy: string;
  candidates: Array<{ routeId: string; upstreamModel: string; providerType: string; account: string; score: number }>;
  rejected: Array<{ routeId: string; upstreamModel: string; reason: string }>;
} | null;

export type CreateRouteInput = {
  publicModelId: string;
  providerAccountId: string;
  upstreamModelId: string;
  priority: number;
  enabled: boolean;
};

export type UpdateRouteInput = {
  upstreamModelId?: string;
  priority?: number;
  enabled?: boolean;
  maxConcurrency?: number;
  timeoutMs?: number;
  weight?: number;
  resetHealth?: boolean;
};

export function useProviders() {
  return useQuery({
    queryKey: ['providers'],
    queryFn: () => api.get<ProvidersResponse>('/api/providers'),
    staleTime: 10_000,
  });
}

export function useCreateProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateProviderInput) => api.post<{ account: { id: string; name: string } }>('/api/providers', body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['providers'] }),
  });
}

export function useUpdateProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: UpdateProviderInput & { id: string }) =>
      api.patch<{ account: { id: string } }>(`/api/providers/${id}`, patch),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['providers'] }),
  });
}

export function useDeleteProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<{ deleted: boolean }>(`/api/providers/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['providers'] }),
  });
}

export function useValidateProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<ProviderValidationResponse>(`/api/providers/${id}/validate`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['providers'] }),
  });
}

export function useRoutes() {
  return useQuery({
    queryKey: ['routes'],
    queryFn: () => api.get<{ routes: ModelRouteRow[] }>('/api/routes'),
    staleTime: 10_000,
  });
}

export function useCreateRoute() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateRouteInput) =>
      api.post<{ route: { id: string }; preview: RoutePlanPreview }>('/api/routes', body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['routes'] });
      // account route counts change when routes are added
      void qc.invalidateQueries({ queryKey: ['providers'] });
    },
  });
}

export function useUpdateRoute() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: UpdateRouteInput & { id: string }) =>
      api.patch<{ route: { id: string }; preview: RoutePlanPreview }>(`/api/routes/${id}`, patch),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['routes'] }),
  });
}

export function useDeleteRoute() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<{ deleted: boolean }>(`/api/routes/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['routes'] }),
  });
}

export function useInvalidateAll() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['conversations'] });
    void qc.invalidateQueries({ queryKey: ['messages'] });
    void qc.invalidateQueries({ queryKey: ['folders'] });
    void qc.invalidateQueries({ queryKey: ['models'] });
    void qc.invalidateQueries({ queryKey: ['keys'] });
    void qc.invalidateQueries({ queryKey: ['usage'] });
    void qc.invalidateQueries({ queryKey: ['providers'] });
    void qc.invalidateQueries({ queryKey: ['routes'] });
    void qc.invalidateQueries({ queryKey: ['settings'] });
  };
}

"use client";

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import type {
  AppSettings,
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

export function useInvalidateAll() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['conversations'] });
    void qc.invalidateQueries({ queryKey: ['messages'] });
    void qc.invalidateQueries({ queryKey: ['folders'] });
    void qc.invalidateQueries({ queryKey: ['models'] });
    void qc.invalidateQueries({ queryKey: ['keys'] });
    void qc.invalidateQueries({ queryKey: ['usage'] });
    void qc.invalidateQueries({ queryKey: ['settings'] });
  };
}

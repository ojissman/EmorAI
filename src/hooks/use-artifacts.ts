"use client";

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type ArtifactListResponse } from '@/lib/api-client';
import type { SerializedArtifact } from '@/lib/types';

export type ArtifactSummary = ArtifactListResponse['artifacts'][number];

export function useArtifacts(kinds?: string[]) {
  const kindsParam = kinds?.length ? kinds.join(',') : '';
  return useQuery({
    queryKey: ['artifacts', kindsParam],
    queryFn: () =>
      api.get<ArtifactListResponse>(`/api/artifacts${kindsParam ? `?kinds=${encodeURIComponent(kindsParam)}` : ''}`),
    select: (data) => data.artifacts,
  });
}

/** Detail query; auto-polls while the artifact is an async job in flight (video). */
export function useArtifact(id: string | null) {
  return useQuery({
    queryKey: ['artifact', id],
    queryFn: () => api.get<{ artifact: SerializedArtifact }>(`/api/artifacts/${id}`),
    enabled: !!id,
    select: (data) => data.artifact,
    refetchInterval: (query) => {
      const status = query.state.data?.artifact.status;
      return status === 'processing' || status === 'pending' ? 4000 : false;
    },
    refetchIntervalInBackground: false,
  });
}

export function useDeleteArtifact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<{ ok: boolean }>(`/api/artifacts/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['artifacts'] });
      void qc.invalidateQueries({ queryKey: ['artifact'] });
    },
  });
}

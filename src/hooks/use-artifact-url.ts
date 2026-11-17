"use client";

// Signed artifact URL resolution for browser-native consumers.
//
// <img>, <video>, <audio>, <iframe> and download anchors cannot attach the
// X-Admin-Session header — and in cross-site embeds (space-z.ai preview
// panel) cookies never arrive either. This hook calls the admin-authenticated
// /api/artifacts/[id]/access endpoint (which CAN send headers) and hands back
// a short-lived signed URL those elements can load directly.
//
// Fallback: if signing fails (route unavailable, transient error), fall back
// to the plain URL — correct wherever cookies DO flow (top-level tab).

import { useQuery } from '@tanstack/react-query';
import { api, artifactUrls, ApiError } from '@/lib/api-client';

export type ArtifactUrlKind = 'file' | 'preview' | 'zip';

export function useArtifactUrl(id: string | null | undefined, kind: ArtifactUrlKind): string | null {
  const plain = id ? artifactUrls[kind](id) : null;
  const { data } = useQuery({
    // short TTL: the signed token lives 5 minutes — a 4-minute staleTime
    // keeps URLs comfortably fresh without hammering the access endpoint.
    queryKey: ['artifact-url', id, kind],
    enabled: Boolean(id),
    staleTime: 4 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    retry: 1,
    queryFn: async (): Promise<string> => {
      if (!id) return plain as string;
      try {
        const res = await api.get<{ url: string }>(`/api/artifacts/${id}/access?kind=${kind}`);
        return res.url;
      } catch (e) {
        if (e instanceof ApiError && (e.status === 404 || e.status === 409)) {
          // Artifact missing / not ready — the plain URL will 404/409 too and
          // the component renders its own not-found state; don't sign.
          return plain as string;
        }
        throw e;
      }
    },
  });
  return data ?? null;
}

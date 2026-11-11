"use client";

// Admin session state for the dashboard gate (Phase 10, Priority 0).
// The session query intentionally swallows 401s into `{ authenticated: false }`
// so the gate renders the login card instead of an error state; every other
// error (network, 5xx) still surfaces as a query error with a retry.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from '@/lib/api-client';

export type AdminSession = {
  authenticated: boolean;
  username?: string;
  expiresAt?: string;
  csrfToken?: string;
};

export const ADMIN_SESSION_QUERY_KEY = ['admin-session'] as const;

export function useAdminSession() {
  return useQuery({
    queryKey: ADMIN_SESSION_QUERY_KEY,
    queryFn: async (): Promise<AdminSession> => {
      try {
        return await api.get<AdminSession>('/api/admin/auth/session');
      } catch (e) {
        // 401 = no/invalid/expired session: a clean logged-out state, not an error.
        if (e instanceof ApiError && e.status === 401) return { authenticated: false };
        throw e;
      }
    },
    staleTime: 15_000,
    retry: false,
  });
}

export function useAdminLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (password: string) =>
      api.post<AdminSession & { authenticated: true }>('/api/admin/auth/login', { password }),
    onSuccess: (data) => {
      qc.setQueryData(ADMIN_SESSION_QUERY_KEY, data);
      // Dashboard queries may hold cache from the logged-out period; a blanket
      // invalidate makes the freshly authenticated mount refetch everything.
      void qc.invalidateQueries();
    },
  });
}

export function useAdminLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ authenticated: false }>('/api/admin/auth/logout'),
    onSuccess: () => {
      // Drop ALL cached dashboard data (it belonged to the revoked session),
      // then park the session query in the logged-out state without a refetch.
      qc.clear();
      qc.setQueryData(ADMIN_SESSION_QUERY_KEY, { authenticated: false });
    },
  });
}

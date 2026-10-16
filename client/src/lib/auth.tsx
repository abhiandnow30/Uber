import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, type ReactNode } from 'react';
import { ApiError, get, post, setUnauthorizedHandler } from './api';

export type Role = 'ADMIN' | 'COORDINATOR' | 'EMPLOYEE' | 'DRIVER';
export type Me = {
  user: { id: string; name: string; email: string; role: Role; status: string; lastLoginAt?: string };
  profile: Record<string, unknown> | null;
  csrfToken: string;
};

type AuthCtx = {
  me: Me | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<unknown>;
};

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const { data, isLoading, refetch } = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await get<Me>('/auth/me');
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 60_000,
    retry: false,
  });

  useEffect(() => {
    setUnauthorizedHandler(() => {
      qc.setQueryData(['me'], null);
    });
  }, [qc]);

  const login = useCallback(
    async (email: string, password: string) => {
      await post('/auth/login', { email, password });
      // Drop the previous user's data, but keep the live "me" query attached so it updates.
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
      await refetch();
    },
    [qc, refetch],
  );

  const logout = useCallback(async () => {
    try {
      await post('/auth/logout');
    } finally {
      // Mark signed-out on the live "me" query first: qc.clear() would detach it, leaving the
      // screen showing the old user (and pages hitting "Authentication required").
      await qc.cancelQueries();
      qc.setQueryData(['me'], null);
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
    }
  }, [qc]);

  return <Ctx.Provider value={{ me: data ?? null, loading: isLoading, login, logout, refresh: refetch }}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}

export const homeFor = (role: Role) => ({ ADMIN: '/admin', COORDINATOR: '/ops', EMPLOYEE: '/employee', DRIVER: '/driver' })[role];

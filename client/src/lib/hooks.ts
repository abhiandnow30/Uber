import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { useToast } from '../components/ui';
import { errorMessage, get, qs, type Paged } from './api';

/** List state for searchable / sortable / filterable / paginated tables. */
export function useListState<F extends Record<string, string>>(initialFilters: F, initialSort = '', pageSize = 20) {
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState(initialSort);
  const [filters, setFilters] = useState<F>(initialFilters);
  const setFilter = useCallback((k: keyof F, v: string) => {
    setFilters((f) => ({ ...f, [k]: v }));
    setPage(1);
  }, []);
  const setSearch = useCallback((v: string) => {
    setQ(v);
    setPage(1);
  }, []);
  const query = qs({ page, pageSize, q, sort, ...filters });
  return { page, setPage, q, setSearch, sort, setSort, filters, setFilter, setFilters, query, pageSize };
}

/** Paginated GET bound to list state. */
export function usePaged<T>(key: QueryKey, path: string, query: string, enabled = true) {
  return useQuery({
    queryKey: [...key, query],
    queryFn: ({ signal }) => get<Paged<T>>(`${path}${query}`, signal),
    placeholderData: keepPreviousData,
    enabled,
  });
}

/**
 * Mutation with toast feedback and cache invalidation. Errors are toasted and
 * re-thrown so forms/dialogs can show them inline as well.
 */
export function useAction<TArgs, TResult = unknown>(
  fn: (args: TArgs) => Promise<TResult>,
  opts: { success?: string | ((r: TResult) => string); invalidate?: QueryKey[]; silentError?: boolean } = {},
) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: fn,
    onSuccess: (r) => {
      if (opts.success) toast.success(typeof opts.success === 'function' ? opts.success(r) : opts.success);
      for (const k of opts.invalidate ?? []) qc.invalidateQueries({ queryKey: k });
    },
    onError: (e) => {
      if (!opts.silentError) toast.error('Action failed', errorMessage(e));
    },
  });
}

/** Field errors from a 422 response, keyed by field name. */
export function fieldErrors(err: unknown): Record<string, string> {
  const details = (err as { details?: { fields?: Record<string, string> } })?.details;
  return details?.fields ?? {};
}

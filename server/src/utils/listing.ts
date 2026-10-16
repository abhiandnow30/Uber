import { z } from 'zod';

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.string().max(40).optional(),
  q: z.string().trim().max(100).optional(),
});

export type Pagination = z.infer<typeof paginationSchema>;

/** Resolve a "field" / "-field" sort param against a whitelist. */
export function resolveSort(sort: string | undefined, allowed: string[], fallback: Record<string, 1 | -1>) {
  if (!sort) return fallback;
  const desc = sort.startsWith('-');
  const field = desc ? sort.slice(1) : sort;
  if (!allowed.includes(field)) return fallback;
  return { [field]: desc ? -1 : 1, _id: 1 } as Record<string, 1 | -1>;
}

export function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function paged<T>(items: T[], total: number, p: Pagination) {
  return { items, total, page: p.page, pageSize: p.pageSize, totalPages: Math.max(1, Math.ceil(total / p.pageSize)) };
}

import { useInfiniteQuery } from '@tanstack/react-query';
import { api, type Page, type Query } from '../api/client';

/** Lista paginada por cursor (seção 23): primeira página e "carregar mais" sem perder a posição. */
export function usePaged<T>(key: unknown[], path: string, query: Query = {}, enabled = true) {
  const q = useInfiniteQuery({
    queryKey: [...key, query],
    enabled,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => api.get<Page<T>>(path, { limit: 200, ...query, cursor: pageParam ?? undefined }, signal),
    getNextPageParam: (last) => last.nextCursor,
  });
  return { ...q, rows: q.data?.pages.flatMap((p) => p.items) ?? [] };
}

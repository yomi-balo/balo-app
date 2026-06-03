'use client';

import { useCallback } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { parseSearchParams, type SearchFilters } from '@/lib/search/filters';

/**
 * The single URL writer for Expert Search. Client controls (rail, sort, view
 * toggle, pagination, chips, sheet) call into this hook to push updated state to
 * the URL; the RSC re-renders with the new `searchParams` → new server fetch.
 *
 * Behaviour:
 * - Filter/sort changes use `router.replace` (not history-noisy) and RESET `page`
 *   to 1 (results change/reorder).
 * - Chrome changes that don't alter results (e.g. the grid/list `layout` toggle)
 *   use `router.replace` but PRESERVE the current `page`.
 * - Pagination uses `router.push` (back button returns to the prior page) and does
 *   NOT reset `page`.
 * - Results-affecting changes scroll back to top.
 */
export interface UseUpdateSearchParams {
  /** Current parsed filters from the URL. */
  getFilters: () => SearchFilters;
  /** Set a single scalar filter/sort param; resets page to 1. */
  setParam: (key: string, value: string | null) => void;
  /** Set a single page-chrome param (e.g. `layout`); PRESERVES the current page. */
  setChromeParam: (key: string, value: string | null) => void;
  /** Replace many params at once from a full filter set (e.g. the sheet "Show"). */
  setParams: (params: URLSearchParams) => void;
  /** Remove one value from a repeated (array) param; resets page to 1. */
  removeValueFromArray: (key: string, value: string) => void;
  /** Append one value to a repeated (array) param if absent; resets page to 1. */
  addValueToArray: (key: string, value: string) => void;
  /** Clear every filter (navigate to the bare pathname). */
  clearAll: () => void;
  /** Pagination: set the page without resetting it; pushes history. */
  setPage: (page: number) => void;
}

const SCROLL_OPTIONS = { scroll: false } as const;

function scrollToTop(): void {
  if (typeof window !== 'undefined') {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

export function useUpdateSearchParams(): UseUpdateSearchParams {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const getFilters = useCallback(() => parseSearchParams(searchParams), [searchParams]);

  /** Replace the URL after a filter change: drop `page`, replace history, scroll up. */
  const commitFilterChange = useCallback(
    (next: URLSearchParams) => {
      next.delete('page');
      const query = next.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, SCROLL_OPTIONS);
      scrollToTop();
    },
    [pathname, router]
  );

  /** Replace the URL after a chrome change: keep `page`, replace history, scroll up. */
  const commitChromeChange = useCallback(
    (next: URLSearchParams) => {
      const query = next.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, SCROLL_OPTIONS);
      scrollToTop();
    },
    [pathname, router]
  );

  const setScalarParam = useCallback((next: URLSearchParams, key: string, value: string | null) => {
    if (value === null || value === '') {
      next.delete(key);
    } else {
      next.set(key, value);
    }
  }, []);

  const setParam = useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(searchParams.toString());
      setScalarParam(next, key, value);
      commitFilterChange(next);
    },
    [searchParams, setScalarParam, commitFilterChange]
  );

  const setChromeParam = useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(searchParams.toString());
      setScalarParam(next, key, value);
      commitChromeChange(next);
    },
    [searchParams, setScalarParam, commitChromeChange]
  );

  const setParams = useCallback(
    (params: URLSearchParams) => {
      const query = params.toString();
      router.push(query ? `${pathname}?${query}` : pathname, SCROLL_OPTIONS);
      scrollToTop();
    },
    [pathname, router]
  );

  const removeValueFromArray = useCallback(
    (key: string, value: string) => {
      const next = new URLSearchParams(searchParams.toString());
      const remaining = next.getAll(key).filter((v) => v !== value);
      next.delete(key);
      for (const v of remaining) next.append(key, v);
      commitFilterChange(next);
    },
    [searchParams, commitFilterChange]
  );

  const addValueToArray = useCallback(
    (key: string, value: string) => {
      const next = new URLSearchParams(searchParams.toString());
      if (!next.getAll(key).includes(value)) {
        next.append(key, value);
      }
      commitFilterChange(next);
    },
    [searchParams, commitFilterChange]
  );

  const clearAll = useCallback(() => {
    router.replace(pathname, SCROLL_OPTIONS);
    scrollToTop();
  }, [pathname, router]);

  const setPage = useCallback(
    (page: number) => {
      const next = new URLSearchParams(searchParams.toString());
      if (page <= 1) {
        next.delete('page');
      } else {
        next.set('page', String(page));
      }
      const query = next.toString();
      router.push(query ? `${pathname}?${query}` : pathname, SCROLL_OPTIONS);
      scrollToTop();
    },
    [searchParams, pathname, router]
  );

  return {
    getFilters,
    setParam,
    setChromeParam,
    setParams,
    removeValueFromArray,
    addValueToArray,
    clearAll,
    setPage,
  };
}

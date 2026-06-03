'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { track, SEARCH_EVENTS } from '@/lib/analytics';
import { parseSearchParams } from '@/lib/search/filters';
import { buildSearchSnapshot, type ComposerNameMaps } from '@/lib/search/composer-analytics';
import { ANY_TIMEFRAME } from './constants';

/** Live-requery debounce window (ms). */
export const REQUERY_DEBOUNCE_MS = 500;

const SCROLL_OPTIONS = { scroll: false } as const;

export type RefineSurface = 'rail' | 'compact_bar';

interface UseFacetRequeryOptions {
  /** When `false` (hero, no results yet), do NOT fire `search_refined`. */
  hasResults: boolean;
  /** Surface reported on `search_refined`. */
  surface: RefineSurface;
  /** id→name maps for the refine snapshot. */
  nameMaps: ComposerNameMaps;
}

export interface FacetRequery {
  /** Toggle one value in a repeated (array) facet param. */
  setArrayValue: (
    key: 'products' | 'supportTypes' | 'languages',
    id: string,
    checked: boolean
  ) => void;
  /** Set the timeframe pill; `ANY_TIMEFRAME` clears it. */
  setTimeframe: (value: string) => void;
  /** Commit the rate range in a single navigation (full span clears both bounds). */
  setRate: (next: { min: number | null; max: number | null }) => void;
}

/**
 * Encapsulates the ~500ms debounced live facet re-query for the desktop rail and
 * compact-bar popovers, plus the debounced `search_refined` analytics. All timer
 * state lives here (one tested unit) so it never scatters across components.
 *
 * Each setter mutates a buffered `URLSearchParams` (seeded from the live URL),
 * schedules a single `router.replace` after the debounce window, and — only when
 * results are present — fires one `search_refined` for the settled state. FTS text
 * is deliberately NOT routed through here (it is always an explicit submit).
 */
export function useFacetRequery({
  hasResults,
  surface,
  nameMaps,
}: UseFacetRequeryOptions): FacetRequery {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<URLSearchParams | null>(null);

  // Keep the latest reactive values in refs so the stable setters always read
  // fresh state without re-creating their identities on every render.
  const liveParams = useRef(searchParams);
  liveParams.current = searchParams;
  const hasResultsRef = useRef(hasResults);
  hasResultsRef.current = hasResults;
  const nameMapsRef = useRef(nameMaps);
  nameMapsRef.current = nameMaps;

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  /** Seed the pending buffer from the live URL on the first edit of a settle window. */
  const ensureBuffer = useCallback((): URLSearchParams => {
    if (pending.current === null) {
      pending.current = new URLSearchParams(liveParams.current.toString());
    }
    return pending.current;
  }, []);

  const scheduleCommit = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const next = pending.current;
      pending.current = null;
      if (next === null) return;
      next.delete('page');
      const query = next.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, SCROLL_OPTIONS);
      if (typeof window !== 'undefined') {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
      if (hasResultsRef.current) {
        const snapshot = buildSearchSnapshot(parseSearchParams(next), nameMapsRef.current);
        track(SEARCH_EVENTS.REFINED, { ...snapshot, surface });
      }
    }, REQUERY_DEBOUNCE_MS);
  }, [router, pathname, surface]);

  const setArrayValue = useCallback(
    (key: 'products' | 'supportTypes' | 'languages', id: string, checked: boolean) => {
      const next = ensureBuffer();
      const remaining = next.getAll(key).filter((v) => v !== id);
      next.delete(key);
      for (const v of remaining) next.append(key, v);
      if (checked) next.append(key, id);
      scheduleCommit();
    },
    [ensureBuffer, scheduleCommit]
  );

  const setTimeframe = useCallback(
    (value: string) => {
      const next = ensureBuffer();
      if (value === ANY_TIMEFRAME) {
        next.delete('timeframe');
      } else {
        next.set('timeframe', value);
      }
      scheduleCommit();
    },
    [ensureBuffer, scheduleCommit]
  );

  const setRate = useCallback(
    ({ min, max }: { min: number | null; max: number | null }) => {
      const next = ensureBuffer();
      if (min === null) next.delete('rateMin');
      else next.set('rateMin', String(min));
      if (max === null) next.delete('rateMax');
      else next.set('rateMax', String(max));
      scheduleCommit();
    },
    [ensureBuffer, scheduleCommit]
  );

  return useMemo(
    () => ({ setArrayValue, setTimeframe, setRate }),
    [setArrayValue, setTimeframe, setRate]
  );
}

'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import type { SearchFilters, TimeframeValue } from '@/lib/search/filters';
import { TIMEFRAME_VALUES } from '@/lib/search/filters';
import type { FacetRequery } from './use-facet-requery';

/** The repeated (array) facet groups this mirror manages. */
export type FacetArrayKey = 'products' | 'supportTypes' | 'languages';

/**
 * The subset of {@link SearchFilters} this hook mirrors — every field a facet
 * control can flip. FTS text (`q`), `sort`, `page`, and `vertical` are deliberately
 * excluded: they are never edited through `FacetControls`/`UnifiedBar` popovers.
 */
export interface FacetSelectionValues {
  products: string[];
  supportTypes: string[];
  languages: string[];
  timeframe: TimeframeValue | null;
  rateMinDollars: number | null;
  rateMaxDollars: number | null;
}

/**
 * The handlers the facet components fan out to. Each one updates the local mirror
 * synchronously (instant paint) and then commits to the active sink.
 */
export interface FacetSelectionApi {
  /** The mirrored selection, painted instantly on toggle. */
  values: FacetSelectionValues;
  /** Toggle one id in a repeated facet group. */
  toggleArray: (key: FacetArrayKey, id: string) => void;
  /** Set the timeframe pill; `value` outside {@link TIMEFRAME_VALUES} clears it. */
  setTimeframe: (value: string) => void;
  /** Commit the rate range (`null` bounds clear that side). */
  setRate: (next: { min: number | null; max: number | null }) => void;
  /** Clear every selected product in one mirror update + one commit. */
  clearProducts: () => void;
}

interface CommittedSink {
  mode: 'committed';
  /** The debounced URL-writing sink. */
  requery: FacetRequery;
}

interface PendingSink {
  mode: 'pending';
  /** The full committed filters (the base every pending update spreads onto). */
  filters: SearchFilters;
  /** Lifts the next full filters to the sheet. */
  onPendingChange: (next: SearchFilters) => void;
}

type FacetSelectionSink = CommittedSink | PendingSink;

interface UseFacetSelectionOptions {
  /** The committed (URL-derived) filters — the reconcile source of truth. */
  filters: SearchFilters;
  /** Where committed edits go (URL debounce vs. sheet pending state). */
  sink: FacetSelectionSink;
}

/** Extract just the mirrored facet fields from a full filters object. */
function pickFacetValues(filters: SearchFilters): FacetSelectionValues {
  return {
    products: filters.products,
    supportTypes: filters.supportTypes,
    languages: filters.languages,
    timeframe: filters.timeframe,
    rateMinDollars: filters.rateMinDollars,
    rateMaxDollars: filters.rateMaxDollars,
  };
}

/**
 * A stable, value-based key for the mirrored facets. `parseSearchParams` returns a
 * fresh object on every RSC render, so identity comparison is useless — we compare
 * this serialized key instead. Array order is preserved (it is meaningful: our
 * appends keep the committed order), so a pure reorder is treated as a new value,
 * which is correct and harmless (the mirror simply re-adopts the URL truth).
 */
function facetKey(values: FacetSelectionValues): string {
  return JSON.stringify([
    values.products,
    values.supportTypes,
    values.languages,
    values.timeframe,
    values.rateMinDollars,
    values.rateMaxDollars,
  ]);
}

/**
 * Local mirror of the facet selection, consumed by BOTH the committed surfaces
 * (desktop rail + unified-bar popovers) and the pending sheet so their selection
 * logic cannot drift.
 *
 * ## Why a mirror?
 * On committed surfaces, a toggle only buffers a `URLSearchParams` and arms the
 * 500ms `useFacetRequery` debounce → `router.replace` → RSC refetch → new `filters`
 * prop. Painting selection from `filters` alone therefore lags behind the click by
 * the debounce + a server round-trip. The mirror paints instantly; the URL stays
 * the single source of truth and reconciles back over the mirror when it settles.
 *
 * ## Reconcile-to-URL (correctness)
 * We remember the last committed value we adopted (by VALUE, via {@link facetKey},
 * because `parseSearchParams` hands us a fresh object each render). When a NEW
 * committed value arrives — detected during render, the React 19 setState-in-render
 * idiom — we adopt it as the new mirror base. This is self-healing toward the URL
 * truth: `useFacetRequery` re-seeds its buffer from the LIVE URL each settle window,
 * so the committed `filters` are normally a superset of prior committed edits and the
 * mirror converges on the URL. The ref-guard makes adoption a no-op when the value is
 * unchanged, so it cannot loop.
 */
export function useFacetSelection({ filters, sink }: UseFacetSelectionOptions): FacetSelectionApi {
  const [mirror, setMirror] = useState<FacetSelectionValues>(() => pickFacetValues(filters));

  // The committed value we last adopted as the mirror base, by VALUE not identity.
  const committed = useMemo(() => pickFacetValues(filters), [filters]);
  const committedKey = facetKey(committed);
  const adoptedKeyRef = useRef(committedKey);

  // React 19 setState-during-render: when the committed value changes from the one
  // we adopted, re-base the mirror to it. Guarded by the ref so an unchanged value
  // (new object identity, same data) is a no-op and never loops.
  if (adoptedKeyRef.current !== committedKey) {
    adoptedKeyRef.current = committedKey;
    setMirror(committed);
  }

  // Mirror the latest selection + sink in refs so the stable handlers read fresh
  // state synchronously (the committed-checked decision must use the LIVE mirror,
  // not the possibly-stale committed `filters`) without re-creating identities.
  const mirrorRef = useRef(mirror);
  mirrorRef.current = mirror;
  const sinkRef = useRef(sink);
  sinkRef.current = sink;

  const toggleArray = useCallback((key: FacetArrayKey, id: string) => {
    const active = sinkRef.current;
    // Decide add vs. remove from the LIVE mirror so rapid toggles stay coherent.
    const checked = !mirrorRef.current[key].includes(id);
    setMirror((prev) => {
      const current = prev[key];
      // Idempotent against `prev`: appending on add (matches
      // `useFacetRequery.setArrayValue`) keeps the committed order so the selected
      // tokens never reorder/jump, while the membership guards keep the invariant
      // "mirror == URL at settle" even if two same-id toggles ever coalesce into one
      // batch (no duplicate id, no spurious removal).
      let next: string[];
      if (checked) {
        next = current.includes(id) ? current : [...current, id];
      } else {
        next = current.filter((v) => v !== id);
      }
      return next === current ? prev : { ...prev, [key]: next };
    });
    if (active.mode === 'committed') {
      active.requery.setArrayValue(key, id, checked);
    } else {
      const base = active.filters[key];
      const next = checked ? [...base, id] : base.filter((v) => v !== id);
      active.onPendingChange({ ...active.filters, [key]: next });
    }
  }, []);

  const setTimeframe = useCallback((value: string) => {
    const active = sinkRef.current;
    const next: TimeframeValue | null = (TIMEFRAME_VALUES as readonly string[]).includes(value)
      ? (value as TimeframeValue)
      : null;
    setMirror((prev) => ({ ...prev, timeframe: next }));
    if (active.mode === 'committed') {
      active.requery.setTimeframe(value);
    } else {
      active.onPendingChange({ ...active.filters, timeframe: next });
    }
  }, []);

  const setRate = useCallback((nextRate: { min: number | null; max: number | null }) => {
    const active = sinkRef.current;
    setMirror((prev) => ({ ...prev, rateMinDollars: nextRate.min, rateMaxDollars: nextRate.max }));
    if (active.mode === 'committed') {
      active.requery.setRate(nextRate);
    } else {
      active.onPendingChange({
        ...active.filters,
        rateMinDollars: nextRate.min,
        rateMaxDollars: nextRate.max,
      });
    }
  }, []);

  const clearProducts = useCallback(() => {
    const active = sinkRef.current;
    const toRemove = mirrorRef.current.products;
    setMirror((prev) => ({ ...prev, products: [] }));
    if (active.mode === 'committed') {
      // Single navigation: the buffered `useFacetRequery` setters mutate one
      // `URLSearchParams` and collapse into one debounced `router.replace`. Removing
      // an id absent from the live URL buffer is a harmless no-op.
      for (const id of toRemove) active.requery.setArrayValue('products', id, false);
    } else {
      active.onPendingChange({ ...active.filters, products: [] });
    }
  }, []);

  return { values: mirror, toggleArray, setTimeframe, setRate, clearProducts };
}

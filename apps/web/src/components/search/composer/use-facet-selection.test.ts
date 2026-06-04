import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { EMPTY_FILTERS, type SearchFilters } from '@/lib/search/filters';

const { mockReplace, mockUseSearchParams } = vi.hoisted(() => ({
  mockReplace: vi.fn(),
  mockUseSearchParams: vi.fn(() => new URLSearchParams()),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace, push: vi.fn() }),
  usePathname: () => '/experts',
  useSearchParams: () => mockUseSearchParams(),
}));

import { useFacetRequery, REQUERY_DEBOUNCE_MS } from './use-facet-requery';
import { useFacetSelection } from './use-facet-selection';
import type { ComposerNameMaps } from '@/lib/search/composer-analytics';

const nameMaps: ComposerNameMaps = { products: {}, supportTypes: {}, languages: {} };

function filters(overrides: Partial<SearchFilters> = {}): SearchFilters {
  return { ...EMPTY_FILTERS, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  mockUseSearchParams.mockReturnValue(new URLSearchParams());
  window.scrollTo = vi.fn();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe('useFacetSelection — committed mode', () => {
  it('updates values SYNCHRONOUSLY on toggle, BEFORE any debounce / navigation', () => {
    const { result } = renderHook(() => {
      const requery = useFacetRequery({ hasResults: true, surface: 'rail', nameMaps });
      return useFacetSelection({ filters: filters(), sink: { mode: 'committed', requery } });
    });

    act(() => {
      result.current.toggleArray('products', 'p1');
    });

    // Painted instantly…
    expect(result.current.values.products).toEqual(['p1']);
    // …while the URL commit is still gated behind the 500ms debounce.
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('reflects rapid toggles immediately and still calls the requery sink per toggle', () => {
    const setArrayValue = vi.fn();
    const requery = { setArrayValue, setTimeframe: vi.fn(), setRate: vi.fn() };
    const { result } = renderHook(() =>
      useFacetSelection({ filters: filters(), sink: { mode: 'committed', requery } })
    );

    act(() => {
      result.current.toggleArray('products', 'p1');
      result.current.toggleArray('products', 'p2');
      result.current.toggleArray('supportTypes', 's1');
    });

    expect(result.current.values.products).toEqual(['p1', 'p2']);
    expect(result.current.values.supportTypes).toEqual(['s1']);
    // Each toggle reaches the underlying sink (which debounces into one commit).
    expect(setArrayValue).toHaveBeenCalledTimes(3);
    expect(setArrayValue).toHaveBeenNthCalledWith(1, 'products', 'p1', true);
    expect(setArrayValue).toHaveBeenNthCalledWith(2, 'products', 'p2', true);
    expect(setArrayValue).toHaveBeenNthCalledWith(3, 'supportTypes', 's1', true);
  });

  it('toggling an already-selected id removes it (mirror) and fires unchecked to the sink', () => {
    const setArrayValue = vi.fn();
    const requery = { setArrayValue, setTimeframe: vi.fn(), setRate: vi.fn() };
    const { result } = renderHook(() =>
      useFacetSelection({
        filters: filters({ products: ['p1'] }),
        sink: { mode: 'committed', requery },
      })
    );

    act(() => {
      result.current.toggleArray('products', 'p1');
    });

    expect(result.current.values.products).toEqual([]);
    expect(setArrayValue).toHaveBeenCalledWith('products', 'p1', false);
  });

  it('appends an added product id at the END (order matches committed) — no flicker', () => {
    const setArrayValue = vi.fn();
    const requery = { setArrayValue, setTimeframe: vi.fn(), setRate: vi.fn() };
    const { result } = renderHook(() =>
      useFacetSelection({
        filters: filters({ products: ['p1', 'p2'] }),
        sink: { mode: 'committed', requery },
      })
    );

    act(() => {
      result.current.toggleArray('products', 'p3');
    });

    // Appended, not prepended — same order `useFacetRequery.setArrayValue` produces.
    expect(result.current.values.products).toEqual(['p1', 'p2', 'p3']);
  });

  it('stays idempotent if two same-id toggles coalesce into one batch (no duplicate id)', () => {
    const setArrayValue = vi.fn();
    const requery = { setArrayValue, setTimeframe: vi.fn(), setRate: vi.fn() };
    const { result } = renderHook(() =>
      useFacetSelection({ filters: filters(), sink: { mode: 'committed', requery } })
    );

    // Both calls run in one act() with no render between them, so each reads the same
    // stale mirror snapshot — the worst case the membership guard must absorb.
    act(() => {
      result.current.toggleArray('products', 'p1');
      result.current.toggleArray('products', 'p1');
    });

    // Mirror holds exactly one 'p1' — no `['p1','p1']` key collision in the token tray.
    expect(result.current.values.products).toEqual(['p1']);
  });

  it('setTimeframe + setRate paint instantly and reach the sink', () => {
    const requery = { setArrayValue: vi.fn(), setTimeframe: vi.fn(), setRate: vi.fn() };
    const { result } = renderHook(() =>
      useFacetSelection({ filters: filters(), sink: { mode: 'committed', requery } })
    );

    act(() => {
      result.current.setTimeframe('week');
    });
    expect(result.current.values.timeframe).toBe('week');
    expect(requery.setTimeframe).toHaveBeenCalledWith('week');

    act(() => {
      result.current.setTimeframe('any');
    });
    // The "any" sentinel clears the timeframe in the mirror.
    expect(result.current.values.timeframe).toBeNull();

    act(() => {
      result.current.setRate({ min: 2, max: 8 });
    });
    expect(result.current.values.rateMinDollars).toBe(2);
    expect(result.current.values.rateMaxDollars).toBe(8);
    expect(requery.setRate).toHaveBeenCalledWith({ min: 2, max: 8 });
  });

  it('clearProducts empties products in one mirror update and fires unchecked per id', () => {
    const setArrayValue = vi.fn();
    const requery = { setArrayValue, setTimeframe: vi.fn(), setRate: vi.fn() };
    const { result } = renderHook(() =>
      useFacetSelection({
        filters: filters({ products: ['p1', 'p2'] }),
        sink: { mode: 'committed', requery },
      })
    );

    act(() => {
      result.current.clearProducts();
    });

    expect(result.current.values.products).toEqual([]);
    expect(setArrayValue).toHaveBeenCalledTimes(2);
    expect(setArrayValue).toHaveBeenCalledWith('products', 'p1', false);
    expect(setArrayValue).toHaveBeenCalledWith('products', 'p2', false);
  });
});

describe('useFacetSelection — reconcile to committed filters', () => {
  it('adopts a NEW committed value on rerender', () => {
    const requery = { setArrayValue: vi.fn(), setTimeframe: vi.fn(), setRate: vi.fn() };
    const { result, rerender } = renderHook(
      ({ f }: { f: SearchFilters }) =>
        useFacetSelection({ filters: f, sink: { mode: 'committed', requery } }),
      { initialProps: { f: filters() } }
    );

    expect(result.current.values.products).toEqual([]);

    rerender({ f: filters({ products: ['p9'] }) });
    expect(result.current.values.products).toEqual(['p9']);
  });

  it('does NOT reset the mirror when an EQUAL committed value (new identity) arrives', () => {
    const requery = { setArrayValue: vi.fn(), setTimeframe: vi.fn(), setRate: vi.fn() };
    const { result, rerender } = renderHook(
      ({ f }: { f: SearchFilters }) =>
        useFacetSelection({ filters: f, sink: { mode: 'committed', requery } }),
      { initialProps: { f: filters({ products: ['p1'] }) } }
    );

    // Optimistically add p2 (not yet in committed filters).
    act(() => {
      result.current.toggleArray('products', 'p2');
    });
    expect(result.current.values.products).toEqual(['p1', 'p2']);

    // Parent re-renders with the SAME committed data but a fresh object identity
    // (parseSearchParams returns a new object each RSC render).
    rerender({ f: filters({ products: ['p1'] }) });

    // The in-flight optimistic p2 survives — no spurious reset, no loop.
    expect(result.current.values.products).toEqual(['p1', 'p2']);
  });

  it('adopts the committed superset when the in-flight edit lands (A then A+B)', () => {
    const requery = { setArrayValue: vi.fn(), setTimeframe: vi.fn(), setRate: vi.fn() };
    const { result, rerender } = renderHook(
      ({ f }: { f: SearchFilters }) =>
        useFacetSelection({ filters: f, sink: { mode: 'committed', requery } }),
      { initialProps: { f: filters({ products: ['A'] }) } }
    );

    expect(result.current.values.products).toEqual(['A']);

    // The debounced commit settles: the URL now carries A + B.
    rerender({ f: filters({ products: ['A', 'B'] }) });
    expect(result.current.values.products).toEqual(['A', 'B']);
  });
});

describe('useFacetSelection — pending mode', () => {
  it('toggle calls onPendingChange with the next filters and never touches requery', () => {
    const onPendingChange = vi.fn();
    const base = filters();
    const { result } = renderHook(() =>
      useFacetSelection({
        filters: base,
        sink: { mode: 'pending', filters: base, onPendingChange },
      })
    );

    act(() => {
      result.current.toggleArray('supportTypes', 's1');
    });

    expect(result.current.values.supportTypes).toEqual(['s1']);
    expect(onPendingChange).toHaveBeenCalledWith(expect.objectContaining({ supportTypes: ['s1'] }));
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('clearProducts in pending mode lifts an empty products array (no per-id loop)', () => {
    const onPendingChange = vi.fn();
    const base = filters({ products: ['p1', 'p2'] });
    const { result } = renderHook(() =>
      useFacetSelection({
        filters: base,
        sink: { mode: 'pending', filters: base, onPendingChange },
      })
    );

    act(() => {
      result.current.clearProducts();
    });

    expect(result.current.values.products).toEqual([]);
    expect(onPendingChange).toHaveBeenCalledTimes(1);
    expect(onPendingChange).toHaveBeenCalledWith(expect.objectContaining({ products: [] }));
  });

  it('setTimeframe maps the "any" sentinel to null via onPendingChange', () => {
    const onPendingChange = vi.fn();
    const base = filters({ timeframe: 'week' });
    const { result } = renderHook(() =>
      useFacetSelection({
        filters: base,
        sink: { mode: 'pending', filters: base, onPendingChange },
      })
    );

    act(() => {
      result.current.setTimeframe('any');
    });

    expect(result.current.values.timeframe).toBeNull();
    expect(onPendingChange).toHaveBeenCalledWith(expect.objectContaining({ timeframe: null }));
  });
});

describe('useFacetSelection — real requery sink integration', () => {
  it('a single toggle eventually commits ONE navigation after the debounce', () => {
    const { result } = renderHook(() => {
      const requery = useFacetRequery({ hasResults: true, surface: 'rail', nameMaps });
      return useFacetSelection({ filters: filters(), sink: { mode: 'committed', requery } });
    });

    act(() => {
      result.current.toggleArray('products', 'p1');
    });
    expect(mockReplace).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(REQUERY_DEBOUNCE_MS);
    });

    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace.mock.calls[0]![0]).toContain('products=p1');
  });
});

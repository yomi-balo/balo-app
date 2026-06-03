import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { SEARCH_EVENTS } from '@balo/analytics/events';
import { track } from '@/lib/analytics';
import type { ComposerNameMaps } from '@/lib/search/composer-analytics';

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

const mockTrack = vi.mocked(track);

const nameMaps: ComposerNameMaps = {
  products: { p1: 'Agentforce', p2: 'Sales Cloud' },
  supportTypes: {},
  languages: {},
};

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

describe('useFacetRequery', () => {
  it('debounces N rapid toggles into ONE URL commit after the settle window', () => {
    const { result } = renderHook(() =>
      useFacetRequery({ hasResults: true, surface: 'rail', nameMaps })
    );

    act(() => {
      result.current.setArrayValue('products', 'p1', true);
      result.current.setArrayValue('products', 'p2', true);
      result.current.setArrayValue('supportTypes', 's1', true);
    });

    expect(mockReplace).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(REQUERY_DEBOUNCE_MS);
    });

    expect(mockReplace).toHaveBeenCalledTimes(1);
    const [url] = mockReplace.mock.calls[0]!;
    expect(url).toContain('products=p1');
    expect(url).toContain('products=p2');
    expect(url).toContain('supportTypes=s1');
  });

  it('fires exactly one search_refined for the settled state when results are present', () => {
    const { result } = renderHook(() =>
      useFacetRequery({ hasResults: true, surface: 'rail', nameMaps })
    );

    act(() => {
      result.current.setArrayValue('products', 'p1', true);
      result.current.setArrayValue('products', 'p2', true);
    });
    act(() => {
      vi.advanceTimersByTime(REQUERY_DEBOUNCE_MS);
    });

    const refined = mockTrack.mock.calls.filter(([event]) => event === SEARCH_EVENTS.REFINED);
    expect(refined).toHaveLength(1);
    expect(refined[0]![1]).toMatchObject({
      surface: 'rail',
      products: ['Agentforce', 'Sales Cloud'],
      product_count: 2,
    });
  });

  it('does NOT fire search_refined when results are absent (hero state) but still commits the URL', () => {
    const { result } = renderHook(() =>
      useFacetRequery({ hasResults: false, surface: 'rail', nameMaps })
    );

    act(() => {
      result.current.setArrayValue('products', 'p1', true);
    });
    act(() => {
      vi.advanceTimersByTime(REQUERY_DEBOUNCE_MS);
    });

    expect(mockReplace).toHaveBeenCalledTimes(1);
    const refined = mockTrack.mock.calls.filter(([event]) => event === SEARCH_EVENTS.REFINED);
    expect(refined).toHaveLength(0);
  });

  it('clears the timeframe param for the "any" sentinel and commits once', () => {
    mockUseSearchParams.mockReturnValue(new URLSearchParams('timeframe=week'));
    const { result } = renderHook(() =>
      useFacetRequery({ hasResults: true, surface: 'rail', nameMaps })
    );

    act(() => {
      result.current.setTimeframe('any');
    });
    act(() => {
      vi.advanceTimersByTime(REQUERY_DEBOUNCE_MS);
    });

    const [url] = mockReplace.mock.calls[0]!;
    expect(url).toBe('/experts');
  });

  it('commits both rate bounds in a single navigation', () => {
    const { result } = renderHook(() =>
      useFacetRequery({ hasResults: true, surface: 'rail', nameMaps })
    );

    act(() => {
      result.current.setRate({ min: 2, max: 8 });
    });
    act(() => {
      vi.advanceTimersByTime(REQUERY_DEBOUNCE_MS);
    });

    expect(mockReplace).toHaveBeenCalledTimes(1);
    const [url] = mockReplace.mock.calls[0]!;
    expect(url).toContain('rateMin=2');
    expect(url).toContain('rateMax=8');
  });

  it('removes a deselected array value from the URL', () => {
    mockUseSearchParams.mockReturnValue(new URLSearchParams('products=p1&products=p2'));
    const { result } = renderHook(() =>
      useFacetRequery({ hasResults: true, surface: 'rail', nameMaps })
    );

    act(() => {
      result.current.setArrayValue('products', 'p1', false);
    });
    act(() => {
      vi.advanceTimersByTime(REQUERY_DEBOUNCE_MS);
    });

    const [url] = mockReplace.mock.calls[0]!;
    expect(url).toContain('products=p2');
    expect(url).not.toContain('products=p1');
  });
});

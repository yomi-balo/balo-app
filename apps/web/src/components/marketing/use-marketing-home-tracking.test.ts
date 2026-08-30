import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { track, MARKETING_HOME_EVENTS } from '@/lib/analytics';
import { useMarketingHomeTracking } from './use-marketing-home-tracking';

/**
 * BAL-493 — `@/lib/analytics` is globally mocked in `src/test/setup.ts` (which re-exports the
 * REAL constants), so these assertions pin the actual event VALUES, not a stub's.
 */
const trackMock = vi.mocked(track);

beforeEach(() => {
  vi.clearAllMocks();
});

function renderTracking() {
  return renderHook(() => useMarketingHomeTracking()).result.current;
}

describe('useMarketingHomeTracking', () => {
  it('exposes exactly the seven named verbs — one per event, no more', () => {
    expect(Object.keys(renderTracking()).sort()).toEqual([
      'ctaClicked',
      'heroFacetOpened',
      'heroProductToggled',
      'heroSearchSubmitted',
      'productTileClicked',
      'sectionViewed',
      'spotlightExpertClicked',
    ]);
  });

  it('is referentially stable across re-renders (useMemo with no deps)', () => {
    const { result, rerender } = renderHook(() => useMarketingHomeTracking());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});

describe('useMarketingHomeTracking — heroSearchSubmitted', () => {
  it('emits query_length, product_count and the product names', () => {
    renderTracking().heroSearchSubmitted('sales cloud help', ['Sales Cloud', 'Service Cloud']);
    expect(trackMock).toHaveBeenCalledWith(MARKETING_HOME_EVENTS.HERO_SEARCH_SUBMITTED, {
      query_length: 16,
      product_count: 2,
      products: ['Sales Cloud', 'Service Cloud'],
    });
  });

  /** ⚠ PRIVACY: the query TEXT must never leave the browser. */
  it('never emits the query text itself', () => {
    renderTracking().heroSearchSubmitted('acme corp migration', []);
    const [, props] = trackMock.mock.calls[0] ?? [];
    expect(JSON.stringify(props)).not.toContain('acme');
    expect(props).toEqual({ query_length: 19, product_count: 0, products: [] });
  });

  it('handles an empty query and no products', () => {
    renderTracking().heroSearchSubmitted('', []);
    expect(trackMock).toHaveBeenCalledWith(MARKETING_HOME_EVENTS.HERO_SEARCH_SUBMITTED, {
      query_length: 0,
      product_count: 0,
      products: [],
    });
  });
});

describe('useMarketingHomeTracking — the remaining six verbs', () => {
  it('heroFacetOpened emits an empty property bag', () => {
    renderTracking().heroFacetOpened();
    expect(trackMock).toHaveBeenCalledWith(MARKETING_HOME_EVENTS.HERO_FACET_OPENED, {});
  });

  it('heroProductToggled distinguishes add from remove via `selected`', () => {
    const tracking = renderTracking();
    tracking.heroProductToggled('Sales Cloud', 'facet', true);
    expect(trackMock).toHaveBeenLastCalledWith(MARKETING_HOME_EVENTS.HERO_PRODUCT_TOGGLED, {
      product: 'Sales Cloud',
      source: 'facet',
      selected: true,
    });

    tracking.heroProductToggled('Sales Cloud', 'chip', false);
    expect(trackMock).toHaveBeenLastCalledWith(MARKETING_HOME_EVENTS.HERO_PRODUCT_TOGGLED, {
      product: 'Sales Cloud',
      source: 'chip',
      selected: false,
    });
  });

  it('productTileClicked renames countShown to the snake_case `count_shown`', () => {
    renderTracking().productTileClicked('Service Cloud', 'b', 4, true);
    expect(trackMock).toHaveBeenCalledWith(MARKETING_HOME_EVENTS.PRODUCT_TILE_CLICKED, {
      product: 'Service Cloud',
      row: 'b',
      position: 4,
      count_shown: true,
    });
  });

  it('spotlightExpertClicked renames expertId to the snake_case `expert_id`', () => {
    renderTracking().spotlightExpertClicked('expert-1', 'book', 2);
    expect(trackMock).toHaveBeenCalledWith(MARKETING_HOME_EVENTS.SPOTLIGHT_EXPERT_CLICKED, {
      expert_id: 'expert-1',
      action: 'book',
      position: 2,
    });
  });

  it('ctaClicked emits the placement and the button label', () => {
    renderTracking().ctaClicked('final', 'Find an expert');
    expect(trackMock).toHaveBeenCalledWith(MARKETING_HOME_EVENTS.CTA_CLICKED, {
      placement: 'final',
      label: 'Find an expert',
    });
  });

  it('sectionViewed emits `section`, the name the ticket called `section_id`', () => {
    renderTracking().sectionViewed('how-it-works');
    expect(trackMock).toHaveBeenCalledWith(MARKETING_HOME_EVENTS.SECTION_VIEWED, {
      section: 'how-it-works',
    });
  });

  it('fires exactly one event per verb call', () => {
    const tracking = renderTracking();
    tracking.heroFacetOpened();
    tracking.ctaClicked('ways', 'Browse experts');
    tracking.sectionViewed('hero');
    expect(trackMock).toHaveBeenCalledTimes(3);
  });
});

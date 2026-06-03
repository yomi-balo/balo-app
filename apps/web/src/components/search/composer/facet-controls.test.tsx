import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { SEARCH_EVENTS } from '@balo/analytics/events';
import { track } from '@/lib/analytics';
import { EMPTY_FILTERS, type SearchFilters } from '@/lib/search/filters';
import type { FacetCountDTO } from '@/lib/search/search-data';
import type { ProductTaxonomy } from '@/lib/search/taxonomy';

const { mockReplace, mockUseSearchParams } = vi.hoisted(() => ({
  mockReplace: vi.fn(),
  mockUseSearchParams: vi.fn(() => new URLSearchParams()),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace, push: vi.fn() }),
  usePathname: () => '/experts',
  useSearchParams: () => mockUseSearchParams(),
}));

vi.mock('motion/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('motion/react')>();
  return { ...actual, useReducedMotion: vi.fn(() => true) };
});

import { FacetControls } from './facet-controls';

const mockTrack = vi.mocked(track);

const facetCounts: {
  products: FacetCountDTO[];
  supportTypes: FacetCountDTO[];
  languages: FacetCountDTO[];
} = {
  products: [{ id: 'p1', name: 'Agentforce', count: 18 }],
  supportTypes: [{ id: 's1', name: 'Technical fix', count: 22 }],
  languages: [{ id: 'l1', name: 'English', count: 52 }],
};

const taxonomy: ProductTaxonomy = {
  groups: [{ id: 'g1', name: 'AI', items: [{ id: 'p1', name: 'Agentforce' }] }],
};

// A dense group (> DENSE_CAP=4 items) so the "+N more" button renders and the
// `product_group_expanded` analytics path can be exercised end to end.
const denseTaxonomy: ProductTaxonomy = {
  groups: [
    {
      id: 'g-platform',
      name: 'Platform',
      items: [
        { id: 'pl1', name: 'AppExchange' },
        { id: 'pl2', name: 'Heroku' },
        { id: 'pl3', name: 'Hyperforce' },
        { id: 'pl4', name: 'Salesforce Platform' },
        { id: 'pl5', name: 'Security' },
        { id: 'pl6', name: 'Shield' },
      ],
    },
  ],
};

const denseNameMap = {
  pl1: 'AppExchange',
  pl2: 'Heroku',
  pl3: 'Hyperforce',
  pl4: 'Salesforce Platform',
  pl5: 'Security',
  pl6: 'Shield',
};

function renderCommitted(overrides: Partial<SearchFilters> = {}, hasResults = true) {
  return render(
    <FacetControls
      mode="committed"
      taxonomy={taxonomy}
      facetCounts={facetCounts}
      productNameMap={{ p1: 'Agentforce' }}
      filters={{ ...EMPTY_FILTERS, ...overrides }}
      hasResults={hasResults}
      refineSurface="rail"
      productSurface="rail"
    />
  );
}

function renderPending(onPendingChange: (next: SearchFilters) => void) {
  return render(
    <FacetControls
      mode="pending"
      taxonomy={taxonomy}
      facetCounts={facetCounts}
      productNameMap={{ p1: 'Agentforce' }}
      filters={EMPTY_FILTERS}
      onPendingChange={onPendingChange}
      productSurface="sheet"
      inSheet
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  mockUseSearchParams.mockReturnValue(new URLSearchParams());
  window.scrollTo = vi.fn();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe('FacetControls — committed mode', () => {
  it('writes a support-type toggle to the URL (debounced)', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderCommitted();
    await user.click(screen.getByRole('button', { name: 'Technical fix' }));
    vi.advanceTimersByTime(500);
    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace.mock.calls[0]![0]).toContain('supportTypes=s1');
  });

  it('maps the "Any time" pill to a cleared timeframe param', async () => {
    mockUseSearchParams.mockReturnValue(new URLSearchParams('timeframe=week'));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderCommitted({ timeframe: 'week' });
    await user.click(screen.getByRole('button', { name: 'Any time' }));
    vi.advanceTimersByTime(500);
    expect(mockReplace).toHaveBeenCalledWith('/experts', { scroll: false });
  });

  it('renders the rate range slider with two thumbs', () => {
    renderCommitted();
    expect(screen.getAllByRole('slider')).toHaveLength(2);
  });

  it('clears all selected products in a SINGLE debounced navigation', async () => {
    mockUseSearchParams.mockReturnValue(new URLSearchParams('products=pl1&products=pl2'));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <FacetControls
        mode="committed"
        taxonomy={denseTaxonomy}
        facetCounts={facetCounts}
        productNameMap={denseNameMap}
        filters={{ ...EMPTY_FILTERS, products: ['pl1', 'pl2'] }}
        hasResults
        refineSurface="rail"
        productSurface="rail"
      />
    );
    await user.click(screen.getByRole('button', { name: /Products/ }));
    await user.click(screen.getByRole('button', { name: 'Clear all' }));
    vi.advanceTimersByTime(500);
    // Two products removed, but only ONE router.replace (buffered single commit).
    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace.mock.calls[0]![0]).not.toContain('products=');
    expect(mockTrack).toHaveBeenCalledWith(SEARCH_EVENTS.COMPOSER_CLEARED, { surface: 'rail' });
  });
});

describe('FacetControls — pending mode', () => {
  it('reports a support toggle via onPendingChange and never writes the URL', async () => {
    const onPendingChange = vi.fn();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPending(onPendingChange);
    await user.click(screen.getByRole('button', { name: 'Technical fix' }));
    expect(onPendingChange).toHaveBeenCalledWith(expect.objectContaining({ supportTypes: ['s1'] }));
    vi.advanceTimersByTime(500);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('reports a timeframe pill via onPendingChange (Any time → null)', async () => {
    const onPendingChange = vi.fn();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPending(onPendingChange);
    await user.click(screen.getByRole('button', { name: 'This week' }));
    expect(onPendingChange).toHaveBeenCalledWith(expect.objectContaining({ timeframe: 'week' }));
  });
});

describe('FacetControls — ProductSelector analytics wiring', () => {
  function renderDenseCommitted() {
    return render(
      <FacetControls
        mode="committed"
        taxonomy={denseTaxonomy}
        facetCounts={facetCounts}
        productNameMap={denseNameMap}
        filters={EMPTY_FILTERS}
        hasResults
        refineSurface="rail"
        productSurface="rail"
      />
    );
  }

  it('fires search_product_selector_opened (surface rail) when the rail selector expands', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderDenseCommitted();
    await user.click(screen.getByRole('button', { name: /Products/ }));
    expect(mockTrack).toHaveBeenCalledWith(SEARCH_EVENTS.PRODUCT_SELECTOR_OPENED, {
      surface: 'rail',
    });
  });

  it('fires search_product_selector_searched (debounced) when the browse box receives input', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderDenseCommitted();
    await user.click(screen.getByRole('button', { name: /Products/ }));
    await user.type(screen.getByRole('textbox', { name: /Search products/i }), 'sec');
    vi.advanceTimersByTime(400);
    expect(mockTrack).toHaveBeenCalledWith(SEARCH_EVENTS.PRODUCT_SELECTOR_SEARCHED, {
      had_results: true,
    });
  });

  it('fires search_product_group_expanded with the group name on "+N more"', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderDenseCommitted();
    await user.click(screen.getByRole('button', { name: /Products/ }));
    await user.click(screen.getByRole('button', { name: /2 more/ }));
    expect(mockTrack).toHaveBeenCalledWith(SEARCH_EVENTS.PRODUCT_GROUP_EXPANDED, {
      group: 'Platform',
    });
  });

  it('fires search_composer_cleared with surface sheet on the in-sheet (pending) clear-all', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <FacetControls
        mode="pending"
        taxonomy={denseTaxonomy}
        facetCounts={facetCounts}
        productNameMap={denseNameMap}
        filters={{ ...EMPTY_FILTERS, products: ['pl1'] }}
        onPendingChange={vi.fn()}
        productSurface="sheet"
        inSheet
      />
    );
    // Tokens tray "Clear all" is visible because a product is selected.
    await user.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(mockTrack).toHaveBeenCalledWith(SEARCH_EVENTS.COMPOSER_CLEARED, { surface: 'sheet' });
  });
});

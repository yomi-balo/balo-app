import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { SEARCH_EVENTS } from '@balo/analytics/events';
import { track } from '@/lib/analytics';
import { EMPTY_FILTERS, type SearchFilters } from '@/lib/search/filters';
import type { FacetCountDTO } from '@/lib/search/search-data';
import type { ProductTaxonomy } from '@/lib/search/taxonomy';

const { mockPush, mockUseSearchParams } = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockUseSearchParams: vi.fn(() => new URLSearchParams()),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: mockPush }),
  usePathname: () => '/experts',
  useSearchParams: () => mockUseSearchParams(),
}));

vi.mock('motion/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('motion/react')>();
  return { ...actual, useReducedMotion: vi.fn(() => true) };
});

import { FilterSheet } from './filter-sheet';

const mockTrack = vi.mocked(track);

const facetCounts: {
  products: FacetCountDTO[];
  supportTypes: FacetCountDTO[];
  languages: FacetCountDTO[];
} = {
  products: [
    { id: 'p1', name: 'Agentforce', count: 18 },
    { id: 'p2', name: 'Sales Cloud', count: 31 },
  ],
  supportTypes: [{ id: 's1', name: 'Technical', count: 22 }],
  languages: [{ id: 'l1', name: 'English', count: 52 }],
};

const taxonomy: ProductTaxonomy = {
  groups: [
    {
      id: 'g1',
      name: 'Sales Cloud',
      items: [
        { id: 'p1', name: 'Agentforce' },
        { id: 'p2', name: 'Sales Cloud' },
      ],
    },
  ],
};

const productNameMap = { p1: 'Agentforce', p2: 'Sales Cloud' };

function renderSheet(props: Partial<React.ComponentProps<typeof FilterSheet>> = {}) {
  return render(
    <FilterSheet
      open
      onOpenChange={vi.fn()}
      facetCounts={facetCounts}
      filters={EMPTY_FILTERS}
      total={50}
      taxonomy={taxonomy}
      productNameMap={productNameMap}
      {...props}
    />
  );
}

function make(overrides: Partial<SearchFilters> = {}): SearchFilters {
  return { ...EMPTY_FILTERS, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUseSearchParams.mockReturnValue(new URLSearchParams());
  window.scrollTo = vi.fn();
});

describe('FilterSheet', () => {
  it('emits search_filters_opened when opened', () => {
    renderSheet();
    expect(mockTrack).toHaveBeenCalledWith(SEARCH_EVENTS.FILTERS_OPENED, {});
  });

  it('fires search_filters_opened exactly once per open transition', () => {
    const { rerender } = renderSheet();
    // A parent re-render with a NEW filters object identity (while still open)
    // must not re-fire the analytics event.
    rerender(
      <FilterSheet
        open
        onOpenChange={vi.fn()}
        facetCounts={facetCounts}
        filters={make()}
        total={50}
        taxonomy={taxonomy}
        productNameMap={productNameMap}
      />
    );
    const openedCalls = mockTrack.mock.calls.filter(
      ([event]) => event === SEARCH_EVENTS.FILTERS_OPENED
    );
    expect(openedCalls).toHaveLength(1);
  });

  it('renders a free-text search field at the top of the sheet', () => {
    renderSheet();
    expect(
      screen.getByRole('textbox', { name: /Search experts by product, skill, or name/i })
    ).toBeInTheDocument();
  });

  it('does not re-seed (clobber) pending edits when filters identity changes while open', async () => {
    const user = userEvent.setup();
    const { rerender } = renderSheet({ total: 100 });
    // User selects a pending facet (held in local state, not yet committed).
    await user.click(screen.getByRole('button', { name: /Products/ }));
    await user.click(screen.getByRole('button', { name: 'Agentforce' }));
    expect(screen.getByRole('button', { name: /Show 18 experts/ })).toBeInTheDocument();
    // Parent re-renders with a fresh (still-empty) filters identity while open.
    rerender(
      <FilterSheet
        open
        onOpenChange={vi.fn()}
        facetCounts={facetCounts}
        filters={make()}
        total={100}
        taxonomy={taxonomy}
        productNameMap={productNameMap}
      />
    );
    // Pending edit survives — not reset back to the 100 baseline.
    expect(screen.getByRole('button', { name: /Show 18 experts/ })).toBeInTheDocument();
  });

  it('seeds pending from the latest committed filters on open', () => {
    // Sheet starts closed, then opens after filters already carry a selection.
    const { rerender } = renderSheet({ open: false, total: 100 });
    rerender(
      <FilterSheet
        open
        onOpenChange={vi.fn()}
        facetCounts={facetCounts}
        filters={make({ products: ['p1'] })}
        total={100}
        taxonomy={taxonomy}
        productNameMap={productNameMap}
      />
    );
    // Seeded from current filters (p1 = 18), not the stale closed-state snapshot.
    expect(screen.getByRole('button', { name: /Show 18 experts/ })).toBeInTheDocument();
  });

  it('shows the total in the footer when no facets are pending', () => {
    renderSheet();
    expect(screen.getByRole('button', { name: /Show 50 experts/ })).toBeInTheDocument();
  });

  it('updates the "Show N" estimate as pending facets change', async () => {
    const user = userEvent.setup();
    renderSheet({ total: 100 });
    await user.click(screen.getByRole('button', { name: /Products/ }));
    await user.click(screen.getByRole('button', { name: 'Agentforce' }));
    // products sum for p1 = 18
    expect(screen.getByRole('button', { name: /Show 18 experts/ })).toBeInTheDocument();
  });

  it('commits pending filters to the URL and fires search_submitted with surface mobile_sheet on Show', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderSheet({ onOpenChange, total: 100 });
    await user.click(screen.getByRole('button', { name: /Products/ }));
    await user.click(screen.getByRole('button', { name: 'Sales Cloud' }));
    await user.click(screen.getByRole('button', { name: /Show/ }));
    expect(mockPush).toHaveBeenCalledWith('/experts?products=p2', { scroll: false });
    expect(mockTrack).toHaveBeenCalledWith(
      SEARCH_EVENTS.SUBMITTED,
      expect.objectContaining({
        surface: 'mobile_sheet',
        path: 'facets_only',
        products: ['Sales Cloud'],
        product_count: 1,
      })
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('does not write the URL before Show is pressed (pending only)', async () => {
    const user = userEvent.setup();
    renderSheet({ total: 100 });
    await user.click(screen.getByRole('button', { name: /Products/ }));
    await user.click(screen.getByRole('button', { name: 'Agentforce' }));
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('renders an accessible Search & filter dialog', () => {
    renderSheet();
    expect(screen.getByRole('dialog', { name: 'Search & filter' })).toBeInTheDocument();
  });
});

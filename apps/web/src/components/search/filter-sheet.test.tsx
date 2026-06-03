import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { SEARCH_EVENTS } from '@balo/analytics/events';
import { track } from '@/lib/analytics';
import { EMPTY_FILTERS, type SearchFilters } from '@/lib/search/filters';
import type { FacetCountDTO } from '@/lib/search/search-data';

const { mockPush, mockUseSearchParams } = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockUseSearchParams: vi.fn(() => new URLSearchParams()),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: mockPush }),
  usePathname: () => '/experts',
  useSearchParams: () => mockUseSearchParams(),
}));

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
    render(
      <FilterSheet
        open
        onOpenChange={vi.fn()}
        facetCounts={facetCounts}
        filters={make()}
        total={50}
      />
    );
    expect(mockTrack).toHaveBeenCalledWith(SEARCH_EVENTS.FILTERS_OPENED, {});
  });

  it('fires search_filters_opened exactly once per open transition', () => {
    const { rerender } = render(
      <FilterSheet
        open
        onOpenChange={vi.fn()}
        facetCounts={facetCounts}
        filters={make()}
        total={50}
      />
    );
    // A parent re-render with a NEW filters object identity (while still open)
    // must not re-fire the analytics event.
    rerender(
      <FilterSheet
        open
        onOpenChange={vi.fn()}
        facetCounts={facetCounts}
        filters={make()}
        total={50}
      />
    );
    expect(mockTrack).toHaveBeenCalledTimes(1);
  });

  it('does not re-seed (clobber) pending edits when filters identity changes while open', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <FilterSheet
        open
        onOpenChange={vi.fn()}
        facetCounts={facetCounts}
        filters={make()}
        total={100}
      />
    );
    // User selects a pending facet (held in local state, not yet committed).
    await user.click(screen.getByRole('checkbox', { name: /Agentforce/ }));
    expect(screen.getByRole('button', { name: /Show 18 experts/ })).toBeInTheDocument();
    // Parent re-renders with a fresh (still-empty) filters identity while open.
    rerender(
      <FilterSheet
        open
        onOpenChange={vi.fn()}
        facetCounts={facetCounts}
        filters={make()}
        total={100}
      />
    );
    // Pending edit survives — not reset back to the 100 baseline.
    expect(screen.getByRole('button', { name: /Show 18 experts/ })).toBeInTheDocument();
  });

  it('seeds pending from the latest committed filters on open', () => {
    // Sheet starts closed, then opens after filters already carry a selection.
    const { rerender } = render(
      <FilterSheet
        open={false}
        onOpenChange={vi.fn()}
        facetCounts={facetCounts}
        filters={make()}
        total={100}
      />
    );
    rerender(
      <FilterSheet
        open
        onOpenChange={vi.fn()}
        facetCounts={facetCounts}
        filters={make({ products: ['p1'] })}
        total={100}
      />
    );
    // Seeded from current filters (p1 = 18), not the stale closed-state snapshot.
    expect(screen.getByRole('button', { name: /Show 18 experts/ })).toBeInTheDocument();
  });

  it('shows the total in the footer when no facets are pending', () => {
    render(
      <FilterSheet
        open
        onOpenChange={vi.fn()}
        facetCounts={facetCounts}
        filters={make()}
        total={50}
      />
    );
    expect(screen.getByRole('button', { name: /Show 50 experts/ })).toBeInTheDocument();
  });

  it('updates the "Show N" estimate as pending facets change', async () => {
    const user = userEvent.setup();
    render(
      <FilterSheet
        open
        onOpenChange={vi.fn()}
        facetCounts={facetCounts}
        filters={make()}
        total={100}
      />
    );
    await user.click(screen.getByRole('checkbox', { name: /Agentforce/ }));
    // products sum for p1 = 18
    expect(screen.getByRole('button', { name: /Show 18 experts/ })).toBeInTheDocument();
  });

  it('commits pending filters to the URL and closes on Show', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <FilterSheet
        open
        onOpenChange={onOpenChange}
        facetCounts={facetCounts}
        filters={make()}
        total={100}
      />
    );
    await user.click(screen.getByRole('checkbox', { name: /Sales Cloud/ }));
    await user.click(screen.getByRole('button', { name: /Show/ }));
    expect(mockPush).toHaveBeenCalledWith('/experts?products=p2', { scroll: false });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('does not write the URL before Show is pressed (pending only)', async () => {
    const user = userEvent.setup();
    render(
      <FilterSheet
        open
        onOpenChange={vi.fn()}
        facetCounts={facetCounts}
        filters={make()}
        total={100}
      />
    );
    await user.click(screen.getByRole('checkbox', { name: /Agentforce/ }));
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('renders an accessible Filters dialog title', () => {
    render(
      <FilterSheet
        open
        onOpenChange={vi.fn()}
        facetCounts={facetCounts}
        filters={make()}
        total={50}
      />
    );
    expect(screen.getByRole('dialog', { name: 'Filters' })).toBeInTheDocument();
  });
});

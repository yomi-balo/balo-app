import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { EMPTY_FILTERS, type SearchFilters } from '@/lib/search/filters';
import type { FacetCountDTO } from '@/lib/search/search-data';

const { mockReplace, mockUseSearchParams } = vi.hoisted(() => ({
  mockReplace: vi.fn(),
  mockUseSearchParams: vi.fn(() => new URLSearchParams()),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace, push: vi.fn() }),
  usePathname: () => '/experts',
  useSearchParams: () => mockUseSearchParams(),
}));

import { PlaceholderFilterRail } from './placeholder-filter-rail';

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

describe('PlaceholderFilterRail (committed mode → writes URL)', () => {
  it('checking a skill appends it to the URL', async () => {
    const user = userEvent.setup();
    render(<PlaceholderFilterRail facetCounts={facetCounts} filters={make()} />);
    await user.click(screen.getByRole('checkbox', { name: /Agentforce/ }));
    expect(mockReplace).toHaveBeenCalledWith('/experts?products=p1', { scroll: false });
  });

  it('unchecking a selected skill removes it from the URL', async () => {
    const user = userEvent.setup();
    mockUseSearchParams.mockReturnValue(new URLSearchParams('products=p1'));
    render(
      <PlaceholderFilterRail facetCounts={facetCounts} filters={make({ products: ['p1'] })} />
    );
    await user.click(screen.getByRole('checkbox', { name: /Agentforce/ }));
    expect(mockReplace).toHaveBeenCalledWith('/experts', { scroll: false });
  });

  it('reflects current selections as checked', () => {
    render(
      <PlaceholderFilterRail facetCounts={facetCounts} filters={make({ products: ['p2'] })} />
    );
    expect(screen.getByRole('checkbox', { name: /Sales Cloud/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Agentforce/ })).not.toBeChecked();
  });

  it('typing a rate min writes rateMin to the URL', async () => {
    const user = userEvent.setup();
    render(<PlaceholderFilterRail facetCounts={facetCounts} filters={make()} />);
    await user.type(screen.getByLabelText(/Minimum rate/), '3');
    expect(mockReplace).toHaveBeenLastCalledWith('/experts?rateMin=3', { scroll: false });
  });

  it('selecting a timeframe writes it to the URL', async () => {
    const user = userEvent.setup();
    render(<PlaceholderFilterRail facetCounts={facetCounts} filters={make()} />);
    await user.selectOptions(screen.getByLabelText('Availability'), 'week');
    expect(mockReplace).toHaveBeenCalledWith('/experts?timeframe=week', { scroll: false });
  });
});

describe('PlaceholderFilterRail (pending mode → lifts state, no URL write)', () => {
  it('reports changes via onPendingChange instead of writing the URL', async () => {
    const user = userEvent.setup();
    const onPendingChange = vi.fn();
    render(
      <PlaceholderFilterRail
        facetCounts={facetCounts}
        filters={make()}
        onPendingChange={onPendingChange}
      />
    );
    await user.click(screen.getByRole('checkbox', { name: /Agentforce/ }));
    expect(onPendingChange).toHaveBeenCalledWith(expect.objectContaining({ products: ['p1'] }));
    expect(mockReplace).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
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

import { ActiveFilterChips, type FacetLabelMaps } from './active-filter-chips';

const labels: FacetLabelMaps = {
  products: { p1: 'Agentforce', p2: 'Sales Cloud' },
  supportTypes: { s1: 'Technical' },
  languages: { l1: 'English' },
};

function make(overrides: Partial<SearchFilters> = {}): SearchFilters {
  return { ...EMPTY_FILTERS, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.scrollTo = vi.fn();
});

describe('ActiveFilterChips', () => {
  it('renders nothing when there are no active filters', () => {
    mockUseSearchParams.mockReturnValue(new URLSearchParams());
    const { container } = render(<ActiveFilterChips filters={make()} labels={labels} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a chip per active filter using facet labels', () => {
    mockUseSearchParams.mockReturnValue(
      new URLSearchParams('products=p1&products=p2&timeframe=today')
    );
    render(
      <ActiveFilterChips
        filters={make({ products: ['p1', 'p2'], timeframe: 'today' })}
        labels={labels}
      />
    );
    expect(screen.getByText('Agentforce')).toBeInTheDocument();
    expect(screen.getByText('Sales Cloud')).toBeInTheDocument();
    expect(screen.getByText('Available today')).toBeInTheDocument();
  });

  it('drops unknown (stale) facet ids from the chip display', () => {
    mockUseSearchParams.mockReturnValue(new URLSearchParams('products=p1&products=zzz'));
    render(<ActiveFilterChips filters={make({ products: ['p1', 'zzz'] })} labels={labels} />);
    expect(screen.getByText('Agentforce')).toBeInTheDocument();
    expect(screen.queryByText('zzz')).not.toBeInTheDocument();
  });

  it('removing one chip rewrites the URL minus that value', async () => {
    const user = userEvent.setup();
    mockUseSearchParams.mockReturnValue(new URLSearchParams('products=p1&products=p2'));
    render(<ActiveFilterChips filters={make({ products: ['p1', 'p2'] })} labels={labels} />);
    await user.click(screen.getByRole('button', { name: 'Remove filter Agentforce' }));
    expect(mockReplace).toHaveBeenCalledWith('/experts?products=p2', { scroll: false });
  });

  it('removing a timeframe chip clears the timeframe param', async () => {
    const user = userEvent.setup();
    mockUseSearchParams.mockReturnValue(new URLSearchParams('timeframe=today'));
    render(<ActiveFilterChips filters={make({ timeframe: 'today' })} labels={labels} />);
    await user.click(screen.getByRole('button', { name: 'Remove filter Available today' }));
    expect(mockReplace).toHaveBeenCalledWith('/experts', { scroll: false });
  });

  it('Clear all navigates to the bare pathname', async () => {
    const user = userEvent.setup();
    mockUseSearchParams.mockReturnValue(new URLSearchParams('products=p1'));
    render(<ActiveFilterChips filters={make({ products: ['p1'] })} labels={labels} />);
    await user.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(mockReplace).toHaveBeenCalledWith('/experts', { scroll: false });
  });

  it('renders rate-bound and query chips', () => {
    mockUseSearchParams.mockReturnValue(new URLSearchParams('rateMin=2&q=flows'));
    render(
      <ActiveFilterChips
        filters={make({ rateMinDollars: 2, rateMaxDollars: 8, q: 'flows' })}
        labels={labels}
      />
    );
    expect(screen.getByText('Min A$2/min')).toBeInTheDocument();
    expect(screen.getByText('Max A$8/min')).toBeInTheDocument();
    expect(screen.getByText('"flows"')).toBeInTheDocument();
  });

  it('icon-only remove buttons have accessible names', () => {
    mockUseSearchParams.mockReturnValue(new URLSearchParams('products=p1'));
    render(<ActiveFilterChips filters={make({ products: ['p1'] })} labels={labels} />);
    expect(screen.getByRole('button', { name: 'Remove filter Agentforce' })).toBeInTheDocument();
  });
});

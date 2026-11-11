import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import { SEARCH_EVENTS } from '@balo/analytics/events';
import { track } from '@/lib/analytics';
import { SearchEmptyState } from './search-empty-state';
import { ResultsGridSkeleton } from './results-grid-skeleton';

const mockTrack = vi.mocked(track);

beforeEach(() => vi.clearAllMocks());

describe('SearchEmptyState', () => {
  it('renders the not-found copy and a clear-all link when not gated', () => {
    render(<SearchEmptyState wasAvailabilityGated={false} filters={{ products: ['p1'] }} />);
    expect(screen.getByText('No experts match those filters')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Clear all filters' })).toHaveAttribute(
      'href',
      '/experts'
    );
  });

  it('renders the availability copy when gated', () => {
    render(<SearchEmptyState wasAvailabilityGated filters={{ timeframe: 'today' }} />);
    expect(screen.getByText('No experts available in that window')).toBeInTheDocument();
  });

  it('fires search_zero_results_viewed once with was_availability_gated', () => {
    render(<SearchEmptyState wasAvailabilityGated filters={{ q: 'x' }} />);
    expect(mockTrack).toHaveBeenCalledTimes(1);
    expect(mockTrack).toHaveBeenCalledWith(SEARCH_EVENTS.ZERO_RESULTS_VIEWED, {
      filters: { q: 'x' },
      was_availability_gated: true,
    });
  });
});

describe('ResultsGridSkeleton', () => {
  it('renders the requested number of loading cards', () => {
    render(<ResultsGridSkeleton count={4} layout="grid" />);
    expect(screen.getAllByLabelText('Loading expert card')).toHaveLength(4);
  });

  it('defaults to 6 skeleton cards', () => {
    render(<ResultsGridSkeleton layout="grid" />);
    expect(screen.getAllByLabelText('Loading expert card')).toHaveLength(6);
  });

  it('renders no list wrapper for the grid layout', () => {
    const { container } = render(<ResultsGridSkeleton count={3} layout="grid" />);
    expect(container.querySelector('.md\\:hidden')).toBeNull();
    expect(container.querySelector('.hidden.md\\:block')).toBeNull();
  });

  it('renders grid skeletons below md and list skeletons from md for the list layout', () => {
    const { container } = render(<ResultsGridSkeleton count={3} layout="list" />);
    const mobile = container.querySelector('.md\\:hidden');
    const desktop = container.querySelector('.hidden.md\\:block');
    expect(mobile?.querySelectorAll('[aria-label="Loading expert card"]')).toHaveLength(3);
    expect(desktop?.querySelectorAll('[aria-label="Loading expert card"]')).toHaveLength(3);
    expect(desktop?.querySelector('.grid-cols-1')).not.toBeNull();
  });
});

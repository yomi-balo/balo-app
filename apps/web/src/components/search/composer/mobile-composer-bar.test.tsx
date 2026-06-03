import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { EMPTY_FILTERS, type SearchFilters } from '@/lib/search/filters';
import type { FacetCountDTO } from '@/lib/search/search-data';
import type { ProductTaxonomy } from '@/lib/search/taxonomy';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => '/experts',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('motion/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('motion/react')>();
  return { ...actual, useReducedMotion: vi.fn(() => true) };
});

import { MobileComposerBar } from './mobile-composer-bar';

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

function renderBar(overrides: Partial<SearchFilters> = {}) {
  return render(
    <MobileComposerBar
      filters={{ ...EMPTY_FILTERS, ...overrides }}
      taxonomy={taxonomy}
      facetCounts={facetCounts}
      productNameMap={{ p1: 'Agentforce' }}
      total={7}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  window.scrollTo = vi.fn();
});

describe('MobileComposerBar', () => {
  it('shows the empty placeholder when no filters are active', () => {
    renderBar();
    expect(screen.getByText('Search or filter experts')).toBeInTheDocument();
  });

  it('renders a product-name summary and an active-count badge', () => {
    renderBar({ products: ['p1'], supportTypes: ['s1'] });
    expect(screen.getByText('Agentforce · Technical fix')).toBeInTheDocument();
    // 1 product + 1 support type = 2 active.
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('opens the filter sheet when tapped', async () => {
    const user = userEvent.setup();
    renderBar();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Search and filter experts/i }));
    expect(screen.getByRole('dialog', { name: 'Search & filter' })).toBeInTheDocument();
  });
});

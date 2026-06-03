import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
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

import { SearchComposer } from './search-composer';

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

function renderComposer(variant: 'hero' | 'compact', overrides: Partial<SearchFilters> = {}) {
  return render(
    <SearchComposer
      variant={variant}
      filters={{ ...EMPTY_FILTERS, ...overrides }}
      taxonomy={taxonomy}
      facetCounts={facetCounts}
      productNameMap={{ p1: 'Agentforce' }}
      total={variant === 'compact' ? 12 : 0}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  window.scrollTo = vi.fn();
});

describe('SearchComposer', () => {
  it('renders the hero heading in the hero variant', () => {
    renderComposer('hero');
    expect(
      screen.getAllByRole('heading', { name: /Find a Salesforce expert/i }).length
    ).toBeGreaterThan(0);
  });

  it('does not render the hero heading in the compact variant', () => {
    renderComposer('compact');
    expect(
      screen.queryByRole('heading', { name: /Find a Salesforce expert/i })
    ).not.toBeInTheDocument();
  });

  it('renders the desktop search bar (search landmark) and the mobile trigger', () => {
    renderComposer('compact');
    expect(screen.getByRole('search')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Search and filter experts/i })).toBeInTheDocument();
  });

  it('reflects an active query in the bar input', () => {
    renderComposer('compact', { q: 'cpq migration' });
    expect(screen.getByRole('textbox', { name: /Search experts/i })).toHaveValue('cpq migration');
  });
});

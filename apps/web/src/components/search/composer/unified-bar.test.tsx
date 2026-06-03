import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { SEARCH_EVENTS } from '@balo/analytics/events';
import { track } from '@/lib/analytics';
import { EMPTY_FILTERS, type SearchFilters } from '@/lib/search/filters';
import type { FacetCountDTO } from '@/lib/search/search-data';
import type { ProductTaxonomy } from '@/lib/search/taxonomy';
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

vi.mock('motion/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('motion/react')>();
  return { ...actual, useReducedMotion: vi.fn(() => true) };
});

import { UnifiedBar } from './unified-bar';

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

// A dense group (> DENSE_CAP=4) so the popover renders "+N more" and the
// product-group-expanded analytics path can be driven end to end.
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

const nameMaps: ComposerNameMaps = {
  products: { p1: 'Agentforce' },
  supportTypes: { s1: 'Technical fix' },
  languages: { l1: 'English' },
};

function renderBar(
  variant: 'hero' | 'compact',
  overrides: Partial<SearchFilters> = {},
  hasResults = true
) {
  return render(
    <UnifiedBar
      variant={variant}
      filters={{ ...EMPTY_FILTERS, ...overrides }}
      taxonomy={taxonomy}
      facetCounts={facetCounts}
      productNameMap={{ p1: 'Agentforce' }}
      nameMaps={nameMaps}
      hasResults={hasResults}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUseSearchParams.mockReturnValue(new URLSearchParams());
  window.scrollTo = vi.fn();
});

describe('UnifiedBar', () => {
  it('writes q and fires search_submitted with path=query_only on Enter', async () => {
    const user = userEvent.setup();
    renderBar('hero');
    await user.type(
      screen.getByRole('textbox', { name: /Search experts/i }),
      'agentforce rollout{Enter}'
    );
    expect(mockReplace).toHaveBeenCalledWith('/experts?q=agentforce+rollout', { scroll: false });
    expect(mockTrack).toHaveBeenCalledWith(
      SEARCH_EVENTS.SUBMITTED,
      expect.objectContaining({ path: 'query_only', surface: 'hero_bar', query_length: 18 })
    );
  });

  it('fires search_submitted on the Search button click', async () => {
    const user = userEvent.setup();
    renderBar('hero');
    await user.type(screen.getByRole('textbox', { name: /Search experts/i }), 'cpq');
    await user.click(screen.getByRole('button', { name: /^Search$/ }));
    expect(mockTrack).toHaveBeenCalledWith(
      SEARCH_EVENTS.SUBMITTED,
      expect.objectContaining({ surface: 'hero_bar', path: 'query_only' })
    );
  });

  it('derives path=both when a facet is already active and a query is submitted', async () => {
    const user = userEvent.setup();
    renderBar('compact', { products: ['p1'] });
    await user.type(screen.getByRole('textbox', { name: /Search experts/i }), 'flows{Enter}');
    expect(mockTrack).toHaveBeenCalledWith(
      SEARCH_EVENTS.SUBMITTED,
      expect.objectContaining({ path: 'both', surface: 'compact_bar' })
    );
  });

  it('opens the Product segment popover and toggles a product', async () => {
    const user = userEvent.setup();
    renderBar('compact');
    await user.click(screen.getByRole('button', { name: /Product/ }));
    // The selector chip appears inside the popover.
    await user.click(await screen.findByRole('button', { name: 'Agentforce' }));
    // Committed via the debounced requery → a replace eventually fires.
    await vi.waitFor(() => expect(mockReplace).toHaveBeenCalled());
  });

  it('renders the "Search" label in hero variant and hides it (icon-only) in compact', () => {
    const { rerender } = renderBar('hero');
    expect(screen.getByRole('button', { name: /^Search$/ })).toHaveTextContent('Search');
    rerender(
      <UnifiedBar
        variant="compact"
        filters={EMPTY_FILTERS}
        taxonomy={taxonomy}
        facetCounts={facetCounts}
        productNameMap={{ p1: 'Agentforce' }}
        nameMaps={nameMaps}
        hasResults
      />
    );
    // Still accessible by name (sr-only) but no visible "Search" text node.
    const button = screen.getByRole('button', { name: /Search/ });
    expect(button.querySelector('.sr-only')).not.toBeNull();
  });

  it('exposes a search landmark role', () => {
    renderBar('hero');
    expect(screen.getByRole('search')).toBeInTheDocument();
  });
});

describe('UnifiedBar — ProductSelector analytics wiring', () => {
  function renderDenseBar() {
    return render(
      <UnifiedBar
        variant="compact"
        filters={EMPTY_FILTERS}
        taxonomy={denseTaxonomy}
        facetCounts={facetCounts}
        productNameMap={{ pl1: 'AppExchange' }}
        nameMaps={nameMaps}
        hasResults
      />
    );
  }

  it('fires search_product_selector_opened (surface popover) when the Product segment opens', async () => {
    const user = userEvent.setup();
    renderDenseBar();
    await user.click(screen.getByRole('button', { name: /Product/ }));
    expect(mockTrack).toHaveBeenCalledWith(SEARCH_EVENTS.PRODUCT_SELECTOR_OPENED, {
      surface: 'popover',
    });
  });

  it('fires search_product_selector_searched (debounced) from the popover browse box', async () => {
    const user = userEvent.setup();
    renderDenseBar();
    await user.click(screen.getByRole('button', { name: /Product/ }));
    await user.type(await screen.findByRole('textbox', { name: /Search products/i }), 'sec');
    await vi.waitFor(() =>
      expect(mockTrack).toHaveBeenCalledWith(SEARCH_EVENTS.PRODUCT_SELECTOR_SEARCHED, {
        had_results: true,
      })
    );
  });

  it('fires search_product_group_expanded with the group name on "+N more"', async () => {
    const user = userEvent.setup();
    renderDenseBar();
    await user.click(screen.getByRole('button', { name: /Product/ }));
    await user.click(await screen.findByRole('button', { name: /2 more/ }));
    expect(mockTrack).toHaveBeenCalledWith(SEARCH_EVENTS.PRODUCT_GROUP_EXPANDED, {
      group: 'Platform',
    });
  });
});

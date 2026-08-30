import { StrictMode } from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import type { ProductTaxonomy } from '@/lib/search/taxonomy';
import { buildProductNameMap } from '@/lib/search/taxonomy';
import type { PopularChip } from '@/lib/marketing/popular-chips';
import { track, MARKETING_HOME_EVENTS } from '@/lib/analytics';
import { HeroSearch } from './hero-search';
import { HeroSection } from './hero-section';

const { mockPush } = vi.hoisted(() => ({ mockPush: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mockPush }) }));

const mockTrack = vi.mocked(track);

/**
 * BAL-493 §5 — the hero search contract. A single taxonomy with two products, one of which
 * ("Agentforce") is ALSO a "Popular:" chip, so a single fixture can drive the shared-state
 * assertion in both directions (chip -> facet AND facet -> chip) against a real, un-mocked
 * `ProductSelector` (§5.2 — not a hand-rolled facet).
 */
const taxonomy: ProductTaxonomy = {
  groups: [
    {
      id: 'g-ai',
      name: 'AI',
      items: [
        { id: 'agentforce-id', name: 'Agentforce' },
        { id: 'data-cloud-id', name: 'Data Cloud' },
      ],
    },
  ],
};
const productNameMap = buildProductNameMap(taxonomy);
const chips: readonly PopularChip[] = [{ id: 'agentforce-id', name: 'Agentforce' }];

function renderHeroSearch() {
  return render(
    <HeroSearch
      taxonomy={taxonomy}
      productNameMap={productNameMap}
      chips={chips}
      phrases={['fix a broken Flow before lunch']}
      verticalName="Salesforce"
    />
  );
}

beforeEach(() => {
  mockPush.mockClear();
  mockTrack.mockClear();
});

describe('HeroSearch — the real ProductSelector is mounted (§5.2)', () => {
  it('renders ProductSelector by role/label when the facet popover opens, not a hand-rolled facet', async () => {
    const user = userEvent.setup();
    renderHeroSearch();

    await user.click(screen.getByRole('button', { name: /Product/ }));
    const dialog = await screen.findByRole('dialog');

    // `ProductSelector`'s own sr-only search label — proves the REAL composer part is mounted,
    // not a stand-in facet (plan §5.1's rejected `ProductFacet`).
    expect(within(dialog).getByLabelText('Search products and skills')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Agentforce' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Data Cloud' })).toBeInTheDocument();
  });
});

describe('HeroSearch — chips and the facet popover share ONE state (§5.4)', () => {
  it('a chip toggle updates the facet badge, and the facet popover reflects the same selection', async () => {
    const user = userEvent.setup();
    renderHeroSearch();

    const chip = screen.getByRole('button', { name: 'Agentforce' });
    expect(chip).toHaveAttribute('aria-pressed', 'false');

    await user.click(chip);
    expect(chip).toHaveAttribute('aria-pressed', 'true');

    const facetButton = screen.getByRole('button', { name: /Product/ });
    expect(within(facetButton).getByText('1')).toBeInTheDocument();

    await user.click(facetButton);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Agentforce' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );

    // Facet -> chip: toggle a DIFFERENT product inside the popover, close it, and confirm the
    // outer "Popular:" row reflects it too — proving there is one shared state, not two.
    await user.click(within(dialog).getByRole('button', { name: 'Data Cloud' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    expect(
      within(screen.getByRole('button', { name: /Product/ })).getByText('2')
    ).toBeInTheDocument();
  });
});

describe('HeroSearch — submit navigates to /experts with q + repeated product UUIDs (§5.3)', () => {
  it('submits via clicking "Find experts"', async () => {
    const user = userEvent.setup();
    renderHeroSearch();

    await user.type(
      screen.getByRole('textbox', { name: /Describe what you need help with/i }),
      'fix a broken Flow'
    );
    await user.click(screen.getByRole('button', { name: 'Agentforce' }));
    await user.click(screen.getByRole('button', { name: /Find experts/i }));

    expect(mockPush).toHaveBeenCalledTimes(1);
    const [url] = mockPush.mock.calls[0] as [string];
    expect(url.startsWith('/experts?')).toBe(true);
    const params = new URLSearchParams(url.split('?')[1]);
    expect(params.get('q')).toBe('fix a broken Flow');
    expect(params.getAll('products')).toEqual(['agentforce-id']);
  });

  it('submits identically via pressing Enter in the search field (a `type="button"` submit can never do this)', async () => {
    const user = userEvent.setup();
    renderHeroSearch();

    await user.click(screen.getByRole('button', { name: 'Agentforce' }));
    await user.type(
      screen.getByRole('textbox', { name: /Describe what you need help with/i }),
      'fix a broken Flow{Enter}'
    );

    expect(mockPush).toHaveBeenCalledTimes(1);
    const [url] = mockPush.mock.calls[0] as [string];
    const params = new URLSearchParams(url.split('?')[1]);
    expect(params.get('q')).toBe('fix a broken Flow');
    expect(params.getAll('products')).toEqual(['agentforce-id']);
  });

  it('an empty submit still navigates to bare /experts (browse everything)', async () => {
    const user = userEvent.setup();
    renderHeroSearch();

    await user.click(screen.getByRole('button', { name: /Find experts/i }));
    expect(mockPush).toHaveBeenCalledWith('/experts?');
  });
});

/**
 * BAL-493 fix round 2 (review MAJOR 6) — this island asserted NOTHING about `track` at all,
 * which is exactly why the StrictMode double-fire bug (fix round 1's B4, MAJOR 4) reached
 * review undetected. Mirrors `bench-rows.test.tsx`'s emitter-testing approach: exact bags,
 * exactly-once counts, and — for the toggle — a real `<StrictMode>` render, because the B4 bug
 * only manifests when React actually double-invokes the `setSelectedIds` updater function; a
 * plain (non-Strict) render would pass identically whether or not the fix regresses.
 */
describe('HeroSearch — analytics emitters (AC-6)', () => {
  it('opening the facet popover fires exactly one hero_facet_opened with an empty bag', async () => {
    const user = userEvent.setup();
    renderHeroSearch();

    await user.click(screen.getByRole('button', { name: /Product/ }));
    await screen.findByRole('dialog');

    expect(mockTrack).toHaveBeenCalledTimes(1);
    expect(mockTrack).toHaveBeenCalledWith(MARKETING_HOME_EVENTS.HERO_FACET_OPENED, {});

    // Closing the popover must not emit a second event.
    await user.keyboard('{Escape}');
    expect(mockTrack).toHaveBeenCalledTimes(1);
  });

  /**
   * ⚠⚠ REGRESSION GUARD for fix round 1's B4 (review MAJOR 4). `hero-search.tsx`'s
   * `handleToggle` docblock explains why the `track` call must sit OUTSIDE the `setSelectedIds`
   * updater: React's StrictMode double-invokes a state updater FUNCTION (the callback form) in
   * development to surface impurities. The current fix passes `setSelectedIds` an already-
   * computed VALUE and calls `tracking.heroProductToggled` directly in the (never
   * double-invoked) click handler body, so it is immune. Moving the `track` call back inside a
   * functional `setSelectedIds((prev) => { ...; tracking.heroProductToggled(...); return next })`
   * would double-fire here, under a REAL `<StrictMode>` render — a plain render would not catch
   * it, which is why this test deliberately wraps in one. Mutation-verified: temporarily
   * reverting `handleToggle` to the functional-updater form failed this exact assertion with
   * `toHaveBeenCalledTimes(2)`.
   */
  it('a chip toggle fires exactly one hero_product_toggled under StrictMode', async () => {
    const user = userEvent.setup();
    render(
      <StrictMode>
        <HeroSearch
          taxonomy={taxonomy}
          productNameMap={productNameMap}
          chips={chips}
          phrases={['fix a broken Flow before lunch']}
          verticalName="Salesforce"
        />
      </StrictMode>
    );

    await user.click(screen.getByRole('button', { name: 'Agentforce' }));

    expect(mockTrack).toHaveBeenCalledTimes(1);
    expect(mockTrack).toHaveBeenCalledWith(MARKETING_HOME_EVENTS.HERO_PRODUCT_TOGGLED, {
      product: 'Agentforce',
      source: 'chip',
      selected: true,
    });
  });

  it('a facet toggle inside the popover also fires exactly one hero_product_toggled, source "facet"', async () => {
    const user = userEvent.setup();
    renderHeroSearch();

    await user.click(screen.getByRole('button', { name: /Product/ }));
    const dialog = await screen.findByRole('dialog');
    mockTrack.mockClear(); // drop the hero_facet_opened emission from opening the popover

    await user.click(within(dialog).getByRole('button', { name: 'Data Cloud' }));

    expect(mockTrack).toHaveBeenCalledTimes(1);
    expect(mockTrack).toHaveBeenCalledWith(MARKETING_HOME_EVENTS.HERO_PRODUCT_TOGGLED, {
      product: 'Data Cloud',
      source: 'facet',
      selected: true,
    });
  });

  it('toggling the same chip off fires exactly one hero_product_toggled with selected:false', async () => {
    const user = userEvent.setup();
    renderHeroSearch();

    const chip = screen.getByRole('button', { name: 'Agentforce' });
    await user.click(chip); // select
    mockTrack.mockClear();
    await user.click(chip); // deselect

    expect(mockTrack).toHaveBeenCalledTimes(1);
    expect(mockTrack).toHaveBeenCalledWith(MARKETING_HOME_EVENTS.HERO_PRODUCT_TOGGLED, {
      product: 'Agentforce',
      source: 'chip',
      selected: false,
    });
  });

  it('submit fires exactly one hero_search_submitted, with query_length and the selected product names', async () => {
    const user = userEvent.setup();
    renderHeroSearch();

    await user.type(
      screen.getByRole('textbox', { name: /Describe what you need help with/i }),
      'fix a broken Flow'
    );
    await user.click(screen.getByRole('button', { name: 'Agentforce' }));
    mockTrack.mockClear();

    await user.click(screen.getByRole('button', { name: /Find experts/i }));

    expect(mockTrack).toHaveBeenCalledTimes(1);
    expect(mockTrack).toHaveBeenCalledWith(MARKETING_HOME_EVENTS.HERO_SEARCH_SUBMITTED, {
      query_length: 'fix a broken Flow'.length,
      product_count: 1,
      products: ['Agentforce'],
    });
  });

  it('an empty submit still fires hero_search_submitted, with query_length 0 and no products', async () => {
    const user = userEvent.setup();
    renderHeroSearch();

    await user.click(screen.getByRole('button', { name: /Find experts/i }));

    expect(mockTrack).toHaveBeenCalledTimes(1);
    expect(mockTrack).toHaveBeenCalledWith(MARKETING_HOME_EVENTS.HERO_SEARCH_SUBMITTED, {
      query_length: 0,
      product_count: 0,
      products: [],
    });
  });
});

describe('HeroSearch — the no-JS fallback', () => {
  it('carries a real <form action="/experts" method="get"> and one hidden input per selected product', async () => {
    const user = userEvent.setup();
    const { container } = renderHeroSearch();

    const form = screen.getByRole('search');
    expect(form.tagName).toBe('FORM');
    expect(form).toHaveAttribute('action', '/experts');
    expect(form).toHaveAttribute('method', 'get');
    expect(container.querySelectorAll('input[type="hidden"][name="products"]')).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Agentforce' }));
    const hiddenInputs = container.querySelectorAll<HTMLInputElement>(
      'input[type="hidden"][name="products"]'
    );
    expect(hiddenInputs).toHaveLength(1);
    const [hidden] = hiddenInputs;
    if (!hidden) throw new Error('expected one hidden products input');
    expect(hidden.value).toBe('agentforce-id');
  });
});

describe('HeroSearch — accessibility', () => {
  it('has no accessibility violations', async () => {
    const { container } = renderHeroSearch();
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('HeroSection ⊃ HeroSearch — exactly one <h1> at the composition boundary (AC-3)', () => {
  it('HeroSearch itself owns no heading; HeroSection renders exactly one h1', () => {
    const { container: searchOnly } = renderHeroSearch();
    expect(searchOnly.querySelectorAll('h1')).toHaveLength(0);

    render(
      <HeroSection
        expertTotal={null}
        wasAvailabilityGated={false}
        taxonomy={taxonomy}
        productNameMap={productNameMap}
        chips={chips}
        benchTiles={[]}
      />
    );
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });
});

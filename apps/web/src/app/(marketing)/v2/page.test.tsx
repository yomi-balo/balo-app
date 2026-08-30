import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@/test/utils';
import { log } from '@/lib/logging';
import { EMPTY_TAXONOMY, type ProductTaxonomy } from '@/lib/search/taxonomy';

// ── Mocks ───────────────────────────────────────────────────────

// `vi.mock` factories are hoisted above every top-level statement, so the spy must be
// created inside `vi.hoisted()` — a plain `const` above the factory is still in its TDZ
// when the factory runs (ReferenceError: cannot access before initialization).
const { mockLoadSearchTaxonomy } = vi.hoisted(() => ({ mockLoadSearchTaxonomy: vi.fn() }));
vi.mock('@/lib/search/load-taxonomy', () => ({
  loadSearchTaxonomy: mockLoadSearchTaxonomy,
}));

// The rendered tree reaches Hero, which calls useRouter() unconditionally.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

// jsdom has no `matchMedia` — the rendered tree reaches usePrefersReduced() via
// MarketingHomeV2 (see hero.test.tsx for the same local-stub convention).
function stubPrefersReducedMotion(matches: boolean): void {
  globalThis.matchMedia = vi.fn().mockReturnValue({
    matches,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }) as unknown as typeof globalThis.matchMedia;
}

const originalMatchMedia = globalThis.matchMedia;

// `vi.mock` calls above are hoisted by Vitest regardless of source position — this import
// resolves against the mocked modules.
import MarketingHomeV2Page, { metadata } from './page';

const LIVE_TAXONOMY: ProductTaxonomy = {
  groups: [
    {
      id: 'cat-sales',
      name: 'Sales',
      items: [{ id: 'prod-live-1', name: 'Live Product Alpha' }],
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  stubPrefersReducedMotion(false);
});

afterEach(() => {
  globalThis.matchMedia = originalMatchMedia;
});

describe('MarketingHomeV2Page — metadata', () => {
  it('sets robots: noindex, nofollow (AC 3)', () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });
});

describe('MarketingHomeV2Page — taxonomy happy path', () => {
  it('renders the page and the hero facet shows a live product name', async () => {
    mockLoadSearchTaxonomy.mockResolvedValue(LIVE_TAXONOMY);
    const element = await MarketingHomeV2Page();
    render(element);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /product/i }));

    expect(screen.getByRole('button', { name: 'Live Product Alpha' })).toBeInTheDocument();
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe('MarketingHomeV2Page — degradation: empty taxonomy (O1)', () => {
  it('still renders, marks the facet unavailable, and logs a warning — never a throw', async () => {
    mockLoadSearchTaxonomy.mockResolvedValue(EMPTY_TAXONOMY);
    const element = await MarketingHomeV2Page();
    render(element);

    // The page renders — a DB hiccup must never 500 a preview.
    expect(screen.getByRole('search')).toBeInTheDocument();

    // …but the product filter is inert and labelled, not fake-selectable. No fallback item
    // carries a real id, so a selection could never reach `/experts`.
    const trigger = screen.getByRole('button', { name: /product/i });
    expect(trigger).toHaveAttribute('aria-disabled', 'true');
    expect(trigger).toHaveTextContent('Unavailable');

    const user = userEvent.setup();
    await user.click(trigger);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    expect(log.warn).toHaveBeenCalledWith(
      '/v2 preview product taxonomy unavailable; the hero product facet is disabled and submit emits q only'
    );
  });
});

describe('MarketingHomeV2Page — degradation: loadSearchTaxonomy rejects (defensive belt-and-braces)', () => {
  it('still renders and logs the caught error, and still degrades to the fallback taxonomy', async () => {
    mockLoadSearchTaxonomy.mockRejectedValue(new Error('taxonomy load exploded'));
    const element = await MarketingHomeV2Page();
    render(element);

    expect(screen.getByRole('search')).toBeInTheDocument();
    expect(log.error).toHaveBeenCalledWith(
      '/v2 preview product taxonomy load threw unexpectedly',
      expect.objectContaining({ error: 'taxonomy load exploded' })
    );
    // EMPTY_TAXONOMY (the post-catch default) degrades to the fallback branch too.
    expect(log.warn).toHaveBeenCalledWith(
      '/v2 preview product taxonomy unavailable; the hero product facet is disabled and submit emits q only'
    );
  });
});

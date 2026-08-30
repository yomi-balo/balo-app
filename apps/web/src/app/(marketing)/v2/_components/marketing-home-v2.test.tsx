import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@/test/utils';
import { EXPERTS, WAYS } from '../_lib/content';
import type { V2Taxonomy } from '../_lib/product-facet-model';
import { MarketingHomeV2 } from './marketing-home-v2';

// ── Mocks ───────────────────────────────────────────────────────

// Hero (rendered unmocked, as the client boundary's first section) calls useRouter()
// unconditionally — no real Next.js app-router context exists under Vitest.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

// jsdom has no `matchMedia` (see hero.test.tsx for the same local-stub convention).
function stubPrefersReducedMotion(matches: boolean): void {
  globalThis.matchMedia = vi.fn().mockReturnValue({
    matches,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }) as unknown as typeof globalThis.matchMedia;
}

const originalMatchMedia = globalThis.matchMedia;

beforeEach(() => {
  stubPrefersReducedMotion(false);
});

afterEach(() => {
  globalThis.matchMedia = originalMatchMedia;
});

const TAXONOMY: V2Taxonomy = {
  source: 'live',
  groups: [{ group: 'Sales', items: [{ id: 'prod-1', name: 'Sales Cloud' }] }],
};

// The documented in-page anchor allowlist (AC 4) — everything else must start with "/".
// Q3 resolved to keep Footer Privacy/Terms as bare "#" (no /privacy or /terms route exists).
const HASH_ALLOWLIST = new Set(['#top', '#experts', '#how', '#pricing', '#for-experts', '#']);

describe('MarketingHomeV2 — structure (AC 2)', () => {
  it('root carries mk2-page and NOT reduced when the visitor has no reduced-motion preference', () => {
    stubPrefersReducedMotion(false);
    const { container } = render(<MarketingHomeV2 taxonomy={TAXONOMY} />);

    const root = container.querySelector('.mk2-page');
    expect(root).not.toBeNull();
    expect(root).not.toHaveClass('reduced');
  });

  it('root gains "reduced" when matchMedia matches prefers-reduced-motion', () => {
    stubPrefersReducedMotion(true);
    const { container } = render(<MarketingHomeV2 taxonomy={TAXONOMY} />);

    expect(container.querySelector('.mk2-page.reduced')).not.toBeNull();
  });

  it('exactly one <main>; no ref <Nav> (.mk2-nav absent); the ref footer is present', () => {
    const { container } = render(<MarketingHomeV2 taxonomy={TAXONOMY} />);

    expect(container.querySelectorAll('main')).toHaveLength(1);
    expect(container.querySelector('.mk2-nav')).toBeNull();
    expect(container.querySelector('footer.mk2-footer')).not.toBeNull();
  });
});

describe('MarketingHomeV2 — colour rhythm (AC 1, ticket table)', () => {
  const rows: Array<{ name: string; assert: (container: HTMLElement) => void }> = [
    {
      name: 'Hero — aurora with three .mk2-aur layers and the white .mk2-hero-fade',
      assert: (container) => {
        const aurora = container.querySelector('.mk2-aurora');
        expect(aurora).not.toBeNull();
        expect(aurora?.querySelectorAll('.mk2-aur')).toHaveLength(3);
        expect(aurora?.querySelector('.mk2-hero-fade')).not.toBeNull();
      },
    },
    {
      name: 'Contrast — mk2-tint-blue background',
      assert: (container) => {
        // Pinned to the SECTION, not "present anywhere": a bare querySelector passes just as
        // happily if the tint migrates from Contrast to Steps, which is precisely the
        // colour-rhythm regression AC 1 exists to catch.
        expect(container.querySelector('#difference')).toHaveClass('mk2-tint-blue');
      },
    },
    {
      name: 'Ways — hairline rows, one per engagement type',
      assert: (container) => {
        expect(container.querySelector('.mk2-ways')).not.toBeNull();
        expect(container.querySelectorAll('.mk2-way')).toHaveLength(WAYS.length);
      },
    },
    {
      name: 'Steps — mk2-tint-violet background',
      assert: (container) => {
        expect(container.querySelector('#how')).toHaveClass('mk2-tint-violet');
      },
    },
    {
      name: 'Spotlight — white .mk2-xc expert cards',
      assert: (container) => {
        expect(container.querySelectorAll('.mk2-xc')).toHaveLength(EXPERTS.length);
      },
    },
    {
      name: 'Pricing — glow bloom behind the floating receipt',
      assert: (container) => {
        expect(container.querySelector('.mk2-price-glow')).not.toBeNull();
        expect(container.querySelector('.mk2-receipt')).not.toBeNull();
      },
    },
    {
      name: 'Quote — gradient tint background',
      assert: (container) => {
        expect(container.querySelector('.mk2-tint-grad')).not.toBeNull();
      },
    },
    {
      name: 'For experts — dark band with two radial glows',
      assert: (container) => {
        expect(container.querySelector('#for-experts')).toHaveClass('mk2-band');
        expect(container.querySelector('.mk2-band-glow-a')).not.toBeNull();
        expect(container.querySelector('.mk2-band-glow-b')).not.toBeNull();
      },
    },
    {
      name: 'Final CTA — the gradient card carries the colour, not the section',
      assert: (container) => {
        expect(container.querySelector('.mk2-final-card')).not.toBeNull();
      },
    },
    {
      name: 'Footer — hairline top',
      assert: (container) => {
        expect(container.querySelector('.mk2-footer')).not.toBeNull();
      },
    },
  ];

  // The ticket names ORDER alongside sections and copy as a faithfulness requirement, and
  // nothing above pins it — every row above would pass with the sections shuffled.
  it('renders the ref sections in order (AC 1 — order is part of faithfulness)', () => {
    const { container } = render(<MarketingHomeV2 taxonomy={TAXONOMY} />);
    // Quote and Final carry no id in the ref either, so they read as '' — kept in the list
    // rather than filtered out, because their POSITION is exactly what this pins.
    const ids = [...container.querySelectorAll('main > *')].map((n) => n.id);
    expect(ids).toEqual([
      'top',
      'difference',
      'ways',
      'how',
      'experts',
      'pricing',
      '', // Quote
      'for-experts',
      '', // Final CTA
    ]);
  });

  it.each(rows)('$name', ({ assert }) => {
    const { container } = render(<MarketingHomeV2 taxonomy={TAXONOMY} />);
    assert(container);
  });
});

describe('MarketingHomeV2 — link sweep (AC 4)', () => {
  it('every href starts with "/" or "#", and the # set is exactly the documented allowlist', () => {
    const { container } = render(<MarketingHomeV2 taxonomy={TAXONOMY} />);

    const hrefs = Array.from(container.querySelectorAll('a[href]')).map(
      (a) => a.getAttribute('href') ?? ''
    );
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      expect(href.startsWith('/') || href.startsWith('#')).toBe(true);
    }

    const hashHrefs = new Set(hrefs.filter((h) => h.startsWith('#')));
    expect(hashHrefs).toEqual(HASH_ALLOWLIST);
  });
});

describe('MarketingHomeV2 — AC 10 sweep', () => {
  it('no element carries data-slot="button", and every .mk2-btn element is mk2-*-only', () => {
    const { container } = render(<MarketingHomeV2 taxonomy={TAXONOMY} />);

    expect(container.querySelectorAll('[data-slot="button"]')).toHaveLength(0);

    const buttons = Array.from(container.querySelectorAll('.mk2-btn'));
    expect(buttons.length).toBeGreaterThan(0);
    for (const el of buttons) {
      for (const cls of Array.from(el.classList)) {
        expect(cls.startsWith('mk2-')).toBe(true);
      }
    }
  });
});

describe('MarketingHomeV2 — no fee/margin/earnings language (AC 6)', () => {
  it('contains "Service fee included" and none of the banned terms', () => {
    const { container } = render(<MarketingHomeV2 taxonomy={TAXONOMY} />);

    const text = (container.textContent ?? '').toLowerCase();
    expect(text).toContain('service fee included');
    for (const banned of ['margin', 'earnings', 'payout', 'commission', 'take rate']) {
      expect(text).not.toContain(banned);
    }
  });
});

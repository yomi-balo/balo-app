import { describe, expect, it, vi } from 'vitest';
import { render } from '@/test/utils';
import { MARKETING_HOME_SECTIONS } from '@/lib/analytics';
import { EMPTY_TAXONOMY } from '@/lib/search/taxonomy';
import { HeroSection } from './hero-section';
import { ProofBand } from './proof-band';
import { WaysSection } from './ways-section';
import { HowItWorksSection } from './how-it-works-section';
import { ExpertsSection } from './experts-section';
import { PricingSection } from './pricing-section';
import { ExpertBandSection } from './expert-band-section';
import { TestimonialsSection } from './testimonials-section';
import { FinalCtaSection } from './final-cta-section';
import { MarketingFooter } from './marketing-footer';
import { METRICS } from './copy';

// `HeroSection` always mounts `<HeroSearch>`, which calls `useRouter()` unconditionally.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

/**
 * BAL-493 §2.5 — table-driven rhythm verification. ONE fixture drives both the per-row class
 * assertions AND a meta-check that the fixture's id set matches `MARKETING_HOME_SECTIONS`
 * exactly (plus the footer, which carries no id/analytics entry) — so a section added to the
 * page without a matching row here fails loudly rather than silently under-covering the port.
 *
 * Mirrors the established `container.querySelector('.expert-hero')` pattern
 * (`experts/[username]/route-states.test.tsx:14`) — plain DOM class/id assertions, no snapshot.
 */
interface RhythmCase {
  readonly name: string;
  /** `null` for the footer — it carries no `id` and is not in `MARKETING_HOME_SECTIONS`. */
  readonly id: string | null;
  readonly render: () => React.ReactElement;
  readonly assert: (root: Element) => void;
}

const RHYTHM: readonly RhythmCase[] = [
  {
    name: 'Hero',
    id: 'hero',
    render: () => (
      <HeroSection
        expertTotal={null}
        wasAvailabilityGated={false}
        taxonomy={EMPTY_TAXONOMY}
        productNameMap={{}}
        chips={[]}
        benchTiles={[]}
      />
    ),
    assert: (root) => {
      expect(root.classList.contains('mk-hero')).toBe(true);
      expect(root.querySelector('.mk-blob-a')).not.toBeNull();
      expect(root.querySelector('.mk-blob-b')).not.toBeNull();
      expect(root.querySelector('.mk-blob-c')).not.toBeNull();
      expect(root.querySelector('.mk-grid')).not.toBeNull();
      expect(root.querySelector('.mk-hero-fade')).not.toBeNull();
    },
  },
  {
    name: 'Proof',
    id: 'proof',
    render: () => <ProofBand metrics={METRICS} />,
    assert: (root) => {
      expect(root.classList.contains('mk-proof')).toBe(true);
    },
  },
  {
    name: 'Ways',
    id: 'ways',
    render: () => <WaysSection />,
    assert: (root) => {
      expect(root.classList.contains('mk-section')).toBe(true);
      expect(root.classList.contains('mk-mist')).toBe(true);
    },
  },
  {
    name: 'How it works',
    id: 'how-it-works',
    render: () => <HowItWorksSection />,
    assert: (root) => {
      expect(root.classList.contains('mk-section')).toBe(true);
      expect(root.classList.contains('mk-mist')).toBe(false);
    },
  },
  {
    name: 'Experts',
    id: 'experts',
    render: () => <ExpertsSection experts={[]} expertTotal={null} />,
    assert: (root) => {
      expect(root.classList.contains('mk-section')).toBe(true);
      expect(root.classList.contains('mk-mist')).toBe(true);
    },
  },
  {
    name: 'Pricing',
    id: 'pricing',
    render: () => <PricingSection />,
    assert: (root) => {
      expect(root.classList.contains('mk-section')).toBe(true);
      expect(root.classList.contains('mk-mist')).toBe(false);
      expect(root.querySelector('.mk-receipt-glow')).not.toBeNull();
    },
  },
  {
    name: 'For experts',
    id: 'for-experts',
    render: () => <ExpertBandSection />,
    assert: (root) => {
      expect(root.classList.contains('mk-xband')).toBe(true);
      expect(root.querySelectorAll('.mk-xband-glow')).toHaveLength(2);
      expect(root.querySelectorAll('.mk-xband-grid')).toHaveLength(1);
    },
  },
  {
    name: 'Testimonials',
    id: 'testimonials',
    render: () => <TestimonialsSection />,
    assert: (root) => {
      expect(root.classList.contains('mk-section')).toBe(true);
      expect(root.classList.contains('mk-mist')).toBe(true);
    },
  },
  {
    name: 'Final',
    id: 'final',
    render: () => <FinalCtaSection />,
    assert: (root) => {
      expect(root.classList.contains('mk-final')).toBe(true);
      expect(root.querySelectorAll('.mk-final-card')).toHaveLength(1);
      expect(root.querySelectorAll('.mk-final-grid')).toHaveLength(1);
    },
  },
  {
    name: 'Footer',
    id: null,
    render: () => <MarketingFooter />,
    assert: (root) => {
      expect(root.tagName).toBe('FOOTER');
      expect(root.classList.contains('mk-footer')).toBe(true);
    },
  },
];

describe.each(RHYTHM)('marketing home rhythm — $name (BAL-493 §2.5)', (testCase) => {
  it('carries its rhythm class(es) and id', () => {
    const { container } = render(testCase.render());
    const root = testCase.id
      ? container.querySelector(`#${testCase.id}`)
      : container.firstElementChild;
    if (!root) {
      throw new Error(`rhythm fixture "${testCase.name}" produced no root element to assert on`);
    }
    if (testCase.id) {
      expect(root.getAttribute('id')).toBe(testCase.id);
    }
    testCase.assert(root);
  });
});

describe('marketing home rhythm — fixture coverage guard', () => {
  it('covers exactly the canonical section id set, plus the footer — a section added to the page without a rhythm entry fails here', () => {
    const ids = RHYTHM.map((c) => c.id).filter((id): id is string => id !== null);
    expect(ids).toEqual([...MARKETING_HOME_SECTIONS]);
    expect(RHYTHM.length).toBe(MARKETING_HOME_SECTIONS.length + 1);
  });
});

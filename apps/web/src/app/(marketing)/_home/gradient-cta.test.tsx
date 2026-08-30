import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import { resolveRouteDir } from '@/invariants/_source-scan';
import { HeroSearch } from './hero-search';
import { ExpertsSection } from './experts-section';
import { FinalCtaSection } from './final-cta-section';
import { WaysSection } from './ways-section';
import { HowItWorksSection } from './how-it-works-section';
import { PricingSection } from './pricing-section';
import { ExpertBandSection } from './expert-band-section';
import { TestimonialsSection } from './testimonials-section';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

/**
 * BAL-493 AC-2 amendment — "every CTA with the blue→violet gradient background renders WHITE
 * text." This is a component-level ENUMERATION of every gradient surface actually shipped on
 * the page, cross-checked against a source scan of `marketing-home.css`.
 *
 * ⚠ Ground truth, verified against the shipped components (not the plan's early test-strategy
 * shorthand, which undercounts by one): `.mk-btn-grad` is used in exactly TWO places —
 * `hero-search.tsx`'s submit button AND `experts-section.tsx`'s 0-card "Browse every vetted
 * expert" invitation CTA (plan §8.4 explicitly calls that one "gradient CTA" too). The
 * spotlight "Book a call" button is a SEPARATE gradient surface — the canonical, UNMODIFIED
 * `ExpertCard` (plan §8.3 forbids a marketing-only variant) renders it with its own Tailwind
 * gradient utility classes, never `.mk-btn-grad` — verified below via a source scan of
 * `expert-card.tsx` rather than a full `ExpertCard` render (which needs a much larger mock
 * surface unrelated to this file's concern). The final CTA band's gradient is the
 * `.mk-final-card` PANEL itself (`background: var(--grad)`), not either of its two buttons —
 * `final-cta-section.tsx`'s own docblock states this: a gradient button on a gradient card
 * would be invisible, so those two buttons are `mk-btn-white` / `mk-btn-outline-light`.
 */
const HOME_DIR = resolveRouteDir([
  'src/app/(marketing)/_home',
  'apps/web/src/app/(marketing)/_home',
]);
const marketingHomeCss =
  HOME_DIR === '' ? '' : readFileSync(`${HOME_DIR}/marketing-home.css`, 'utf8');

const EXPERT_CARD_CANDIDATES = [
  'src/components/expert/expert-card.tsx',
  'apps/web/src/components/expert/expert-card.tsx',
];
const expertCardPath = EXPERT_CARD_CANDIDATES.map((c) => resolveRouteDir([c])).find(
  (p) => p !== ''
);
const expertCardSource = expertCardPath ? readFileSync(expertCardPath, 'utf8') : '';

/** The body of the block whose selector text is exactly `${selector} {`, up to its own `}` —
 * every rule this file looks up is a single-level (non-nested) declaration block. */
function ruleBody(source: string, selector: string): string {
  const marker = `${selector} {`;
  const start = source.indexOf(marker);
  if (start === -1) return '';
  const end = source.indexOf('}', start + marker.length);
  return end === -1 ? '' : source.slice(start + marker.length, end);
}

describe('gradient-cta — source files were found (guard)', () => {
  it('resolved marketing-home.css and expert-card.tsx with non-trivial content', () => {
    expect(marketingHomeCss.length).toBeGreaterThan(1000);
    expect(expertCardSource.length).toBeGreaterThan(1000);
  });
});

describe('gradient-cta — the hero search submit (surface 1 of 3)', () => {
  it('carries .mk-btn-grad', () => {
    render(
      <HeroSearch
        taxonomy={{ groups: [] }}
        productNameMap={{}}
        chips={[]}
        phrases={['fix a broken Flow before lunch']}
        verticalName="Salesforce"
      />
    );
    const submit = screen.getByRole('button', { name: /Find experts/i });
    expect(submit.className).toContain('mk-btn-grad');
  });
});

describe('gradient-cta — the experts-section 0-card invitation CTA (surface 2 of 3)', () => {
  it('carries .mk-btn-grad, and the sibling "Browse all experts" head-link does not', () => {
    render(<ExpertsSection experts={[]} expertTotal={null} />);
    const invite = screen.getByRole('link', { name: 'Browse every vetted expert' });
    expect(invite.className).toContain('mk-btn-grad');

    const headLink = screen.getByRole('link', { name: 'Browse all experts' });
    expect(headLink.className).not.toContain('mk-btn-grad');
  });
});

describe('gradient-cta — the spotlight "Book a call" button (surface 3 of 3, a DIFFERENT mechanism)', () => {
  it("expert-card.tsx's BookCallButton uses its own gradient utility classes, not .mk-btn-grad", () => {
    const marker = 'function BookCallButton(';
    const start = expertCardSource.indexOf(marker);
    expect(start).toBeGreaterThan(-1);
    const end = expertCardSource.indexOf('\n}\n', start);
    const body = end === -1 ? expertCardSource.slice(start) : expertCardSource.slice(start, end);

    expect(body).toContain('Book a call');
    expect(body).toContain('bg-gradient-to-r');
    expect(body).toContain('text-white');
    expect(body).not.toContain('mk-btn-grad');
  });
});

describe('gradient-cta — the final CTA band is the gradient PANEL, and its two buttons are not', () => {
  it('renders mk-btn-white / mk-btn-outline-light on the buttons, and .mk-final-card wraps them', () => {
    const { container } = render(<FinalCtaSection />);
    const findAnExpert = screen.getByRole('link', { name: 'Find an expert' });
    const createAccount = screen.getByRole('link', { name: 'Create a free account' });

    expect(findAnExpert.className).not.toContain('mk-btn-grad');
    expect(createAccount.className).not.toContain('mk-btn-grad');
    expect(findAnExpert.className).toContain('mk-btn-white');
    expect(createAccount.className).toContain('mk-btn-outline-light');

    const card = container.querySelector('.mk-final-card');
    expect(card).not.toBeNull();
    expect(card?.contains(findAnExpert)).toBe(true);
  });

  /**
   * BAL-493 fix round 1 (review MAJOR 5) — plan §19 deviation #12 shipped IN REVERSE. D3
   * removed "Get started" from the signed-out header on the condition that the page keeps a
   * prominent client-signup path; as first built, the final band offered a THIRD expert CTA
   * and the footer held the only client-signup link on the page. This pins the direction.
   */
  it('the secondary CTA is the CLIENT signup path (/signup), not a third expert-funnel link', () => {
    render(<FinalCtaSection />);

    const createAccount = screen.getByRole('link', { name: 'Create a free account' });
    expect(createAccount).toHaveAttribute('href', '/signup');
    expect(screen.queryByRole('link', { name: 'Become an expert' })).toBeNull();
  });

  it('CSS: .mk-final-card carries the gradient background AND white foreground text (AC-2 amendment)', () => {
    const body = ruleBody(marketingHomeCss, '.mk-final-card');
    expect(body).toContain('background: var(--grad)');
    expect(body).toContain('color: var(--primary-foreground)');
  });
});

describe('gradient-cta — no OTHER section on the page uses the gradient budget', () => {
  it('Ways / How-it-works / Pricing / For-experts / Testimonials render zero .mk-btn-grad elements', () => {
    for (const Section of [
      WaysSection,
      HowItWorksSection,
      PricingSection,
      ExpertBandSection,
      TestimonialsSection,
    ]) {
      const { container, unmount } = render(<Section />);
      expect(container.querySelectorAll('.mk-btn-grad')).toHaveLength(0);
      unmount();
    }
  });
});

describe('gradient-cta — CSS: .mk-btn-grad declares white text once, and it is not overridden', () => {
  it('.mk-btn-grad sets color: var(--primary-foreground); neither :hover nor ::before redeclare color', () => {
    const base = ruleBody(marketingHomeCss, '.mk-btn-grad');
    expect(base).toContain('color: var(--primary-foreground)');

    const hover = ruleBody(marketingHomeCss, '.mk-btn-grad:hover');
    const before = ruleBody(marketingHomeCss, '.mk-btn-grad::before');
    expect(hover).not.toContain('color:');
    expect(before).not.toContain('color:');
  });
});

import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import { InlineRating, RatingAccessibleName, ratingAccessibleName } from './rating-display';

/**
 * BAL-422 fix round. The aggregate ships on SIX surfaces, and before this component each
 * hand-rolled the same three nodes — so each was independently free to dim the count below
 * the WCAG AA floor (all six did) and to leave a screen reader announcing "4.8 12" (all six
 * did). These tests pin the two properties that must hold identically everywhere; the
 * per-surface tests then only assert that each surface uses it.
 */
describe('ratingAccessibleName', () => {
  /**
   * ⚠⚠ THE NOUN IS "ENGAGEMENTS", NOT "REVIEWS", AND THIS IS THE LOAD-BEARING ASSERTION IN
   * THE FILE. `expert_profiles.rating_count` counts ENGAGEMENTS REVIEWED — a five-person
   * company reviewing one engagement contributes 1, not 5. "12 reviews" would state a number
   * the product does not have, to the audience least able to check it against the visual.
   */
  it('names the count as engagements, never as reviews', () => {
    const name = ratingAccessibleName(4.8, 12);
    expect(name).toBe('Rated 4.8 out of 5 across 12 engagements');
    expect(name).not.toMatch(/review/i);
  });

  it('singularises a lone engagement', () => {
    expect(ratingAccessibleName(5, 1)).toBe('Rated 5.0 out of 5 across 1 engagement');
  });

  /** ⚠ ONE DECIMAL ALWAYS — the sentence must not disagree with the digits beside it. */
  it('always states one decimal place, matching the visual', () => {
    expect(ratingAccessibleName(5, 3)).toContain('Rated 5.0 out of 5');
    expect(ratingAccessibleName(4.25, 3)).toContain('Rated 4.3 out of 5');
  });

  /** ⚠ THE SCALE IS STATED. "4.8" alone is meaningless out of context to a screen reader. */
  it('states the scale', () => {
    expect(ratingAccessibleName(4.8, 12)).toContain('out of 5');
  });
});

describe('RatingAccessibleName', () => {
  it('renders the sentence in an sr-only span', () => {
    const { container } = render(<RatingAccessibleName average={4.8} count={12} />);
    const span = container.querySelector('span');
    expect(span).toHaveClass('sr-only');
    expect(span).toHaveTextContent('Rated 4.8 out of 5 across 12 engagements');
  });
});

describe('InlineRating', () => {
  it('renders the average to one decimal and the count in parentheses', () => {
    render(<InlineRating average={4.8} count={12} />);
    expect(screen.getByText('4.8')).toBeInTheDocument();
    expect(screen.getByText('(12)')).toBeInTheDocument();
  });

  it('formats a whole number to one decimal', () => {
    render(<InlineRating average={5} count={1} />);
    expect(screen.getByText('5.0')).toBeInTheDocument();
  });

  it('carries the accessible name', () => {
    render(<InlineRating average={4.8} count={12} />);
    expect(screen.getByText('Rated 4.8 out of 5 across 12 engagements')).toBeInTheDocument();
  });

  /**
   * ⚠ THE VISUAL NODES ARE HIDDEN FROM ASSISTIVE TECH so the value is not announced twice —
   * once as the sentence and again as loose numerals. The star was already `aria-hidden`;
   * the two text nodes were not.
   */
  it('hides the visual digits from assistive tech', () => {
    render(<InlineRating average={4.8} count={12} />);
    expect(screen.getByText('4.8')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText('(12)')).toHaveAttribute('aria-hidden', 'true');
  });

  /**
   * ⚠⚠ WCAG AA — THE REGRESSION THIS COMPONENT EXISTS TO PREVENT. All six surfaces shipped
   * the count at `text-muted-foreground/60` on 11–12px text: roughly 2.4:1 in light mode,
   * under the 4.5:1 floor. That made the DENOMINATOR the faintest thing on the row while the
   * average sat at full weight — exactly the "5.0 (1)" ≈ "5.0 (50)" misreading the count was
   * added to prevent. Pinned as an absence of any opacity modifier, because the failure mode
   * is someone re-dimming it for visual balance.
   */
  it('never dims the count with an opacity modifier', () => {
    render(<InlineRating average={4.8} count={12} />);
    const countNode = screen.getByText('(12)');
    expect(countNode).toHaveClass('text-muted-foreground');
    expect(countNode.className).not.toMatch(/text-muted-foreground\/\d/);
    expect(countNode.className).not.toMatch(/\bopacity-/);
  });

  /** Each surface keeps its own scale; only the star box is overridable, never the colour. */
  it('accepts per-surface class overrides without losing the shared treatment', () => {
    const { container } = render(
      <InlineRating
        average={4.8}
        count={12}
        starClassName="h-2.5 w-2.5"
        valueClassName="font-bold"
        countClassName="text-[11px]"
      />
    );
    const star = container.querySelector('svg');
    expect(star).toHaveClass('h-2.5', 'w-2.5', 'text-warning');
    expect(screen.getByText('4.8')).toHaveClass('font-bold');
    expect(screen.getByText('(12)')).toHaveClass('text-[11px]', 'text-muted-foreground');
  });

  /** It emits no wrapper — each caller supplies its own layout container. */
  it('renders as a bare fragment', () => {
    const { container } = render(<InlineRating average={4.8} count={12} />);
    // sr-only span, star svg, value span, count span — and no wrapping element around them.
    expect(container.firstElementChild).toHaveClass('sr-only');
    expect(container.childElementCount).toBe(4);
  });
});

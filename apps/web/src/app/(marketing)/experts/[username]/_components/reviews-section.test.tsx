import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import { ReviewsSection } from './reviews-section';

/**
 * BAL-422 made this section AGGREGATE-AWARE, and the reason is the contradiction it prevents:
 * wiring the hero rating stat alone would put "4.8 (12)" directly above a section reading
 * "No reviews yet". Both states are pinned here so they cannot drift apart again.
 *
 * ⚠ REVIEW BODIES STAY OUT OF SCOPE. `reviewsRepository.listPublicByExpert` is still
 * unmounted, so the rated state states the AGGREGATE ONLY — no quoted text, no per-review
 * stars, no reviewer names.
 */
describe('ReviewsSection — the expert has ratings', () => {
  it('states the average to one decimal with its engagement count', () => {
    render(<ReviewsSection firstName="Priya" ratingAverage={4.8} ratingCount={12} />);

    expect(screen.getByText('4.8')).toBeInTheDocument();
    expect(screen.getByText('average across 12 engagements')).toBeInTheDocument();
  });

  /**
   * ⚠ THE COUNT SAYS "ENGAGEMENTS", NOT "REVIEWS", AND THAT IS LOAD-BEARING. `ratingCount`
   * counts ENGAGEMENTS reviewed — a 5-person company reviewing one engagement contributes 1
   * — so "12 reviews" would misstate what the number is.
   */
  it('describes the count as engagements, never as reviews', () => {
    const { container } = render(
      <ReviewsSection firstName="Priya" ratingAverage={4.8} ratingCount={12} />
    );
    expect(container.textContent ?? '').not.toMatch(/12 reviews/i);
  });

  it('singularises a lone engagement', () => {
    render(<ReviewsSection firstName="Priya" ratingAverage={5} ratingCount={1} />);
    expect(screen.getByText('average across 1 engagement')).toBeInTheDocument();
  });

  it('always shows one decimal place', () => {
    render(<ReviewsSection firstName="Priya" ratingAverage={5} ratingCount={1} />);
    expect(screen.getByText('5.0')).toBeInTheDocument();
  });

  /** ⚠ NO BODIES, NO FABRICATED SOCIAL PROOF — the aggregate is the whole claim. */
  it('renders no review bodies and no invitation copy in the rated state', () => {
    const { container } = render(
      <ReviewsSection firstName="Priya" ratingAverage={4.8} ratingCount={12} />
    );
    expect(screen.queryByText(/Be the first to work with/)).not.toBeInTheDocument();
    expect(container.textContent ?? '').not.toContain('"');
  });

  /**
   * ⚠⚠ IT MUST NOT PROMISE A SURFACE NOBODY OWNS. `listPublicByExpert` is unmounted and no
   * ticket owns mounting it, while BAL-390 captures review bodies today — so a line saying
   * written reviews "will appear here" was a commitment that would age into a lie without
   * anyone editing this file. Pinned as an absence because the failure mode is someone
   * re-adding a friendly future-tense sentence.
   */
  it('promises no future surface — no "will appear", no "coming soon"', () => {
    const { container } = render(
      <ReviewsSection firstName="Priya" ratingAverage={4.8} ratingCount={12} />
    );
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/will appear/i);
    expect(text).not.toMatch(/coming soon/i);
  });
});

describe('ReviewsSection — the expert has no ratings', () => {
  /**
   * ⚠ BAL-422 DID CHANGE THE HEADING, and an earlier version of this comment wrongly said
   * the empty state was untouched. It was "No reviews yet" — the absence framing CLAUDE.md
   * forbids — and is now a statement of where ratings come from, leaving the sub-line to do
   * the inviting. The two must not be the same sentence twice: an earlier fix made the
   * heading "Be the first to review" directly above "Be the first to work with Priya".
   *
   * The section is NOT hidden either — a visitor can act from here.
   */
  it('invites rather than reporting absence, and does not repeat itself', () => {
    const { container } = render(
      <ReviewsSection firstName="Priya" ratingAverage={null} ratingCount={0} />
    );

    expect(
      screen.getByText('Be the first to work with Priya and share how it went.')
    ).toBeInTheDocument();
    expect(screen.queryByText(/no reviews yet/i)).not.toBeInTheDocument();
    // "Be the first" appears exactly once — in the sub-line, not also in the heading.
    expect((container.textContent ?? '').match(/Be the first/g)).toHaveLength(1);
  });

  /**
   * ⚠⚠ NEVER 0.0. The scale starts at 1, so a zero is a FABRICATED bad score for an expert
   * who simply has not been reviewed — the one value this whole feature must never render.
   */
  it('renders no numeric rating at all, and never 0.0', () => {
    const { container } = render(
      <ReviewsSection firstName="Priya" ratingAverage={null} ratingCount={0} />
    );
    const text = container.textContent ?? '';
    expect(text).not.toContain('0.0');
    expect(text).not.toContain('average across');
  });
});

import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import type { ExpertProfileView } from '@/components/expert/profile';
import { HeroStatsStrip } from './hero-stats-strip';

/**
 * The strip's ONE rule is OMIT-DON'T-FABRICATE: a stat with no data behind it does not
 * render, and the strip itself disappears when nothing is backable. BAL-422 added the rating
 * stat under that same rule, which is the branch this file exists to hold — an unrated expert
 * must show NO rating stat, never `0.0`.
 */
function makeView(overrides: Partial<ExpertProfileView> = {}): ExpertProfileView {
  return {
    expertId: 'expert-1',
    agencyId: null,
    name: 'Priya Sharma',
    firstName: 'Priya',
    initials: 'PS',
    headline: null,
    bio: null,
    avatarKey: null,
    countryCode: null,
    country: null,
    rate: null,
    yearsExperience: null,
    consultationCount: 0,
    certCount: 0,
    availableForWork: true,
    baloVerified: true,
    topRated: false,
    ratingAverage: null,
    ratingCount: 0,
    competencies: [],
    certifications: [],
    languages: [],
    languagesLabel: '',
    agency: null,
    workHistory: [],
    ...overrides,
  };
}

describe('HeroStatsStrip — the rating stat', () => {
  /** ⚠ THE AVERAGE NEVER SHIPS WITHOUT ITS DENOMINATOR (BAL-422 AC). */
  it('renders the average to one decimal with its count', () => {
    render(<HeroStatsStrip view={makeView({ ratingAverage: 4.8, ratingCount: 12 })} />);

    expect(screen.getByText('4.8')).toBeInTheDocument();
    expect(screen.getByText('(12)')).toBeInTheDocument();
    expect(screen.getByText('Rating')).toBeInTheDocument();
  });

  it('always shows one decimal place', () => {
    render(<HeroStatsStrip view={makeView({ ratingAverage: 5, ratingCount: 3 })} />);
    expect(screen.getByText('5.0')).toBeInTheDocument();
  });

  /**
   * ⚠⚠ THE ONLY STAT HERE THAT NEEDS AN ACCESSIBLE NAME, AND IT IS THE ONE THAT SHIPPED
   * WITHOUT ONE. Every other stat self-describes when read in order — "124+" then
   * "Consultations". The rating announced as "4.8 (12) Rating": neither number carries a
   * scale, the parenthesised one has no noun, and the visible "Rating" label sits in a
   * SEPARATE `<p>` with no programmatic tie to the value it qualifies.
   */
  it('gives the rating stat an accessible name, and hides the loose digits', () => {
    render(<HeroStatsStrip view={makeView({ ratingAverage: 4.8, ratingCount: 12 })} />);

    expect(screen.getByText('Rated 4.8 out of 5 across 12 engagements')).toBeInTheDocument();
    // The visual block — value, sub and the "Rating" label — is hidden, so the sentence is
    // not read and then immediately repeated as numerals.
    expect(screen.getByText('4.8').closest('[aria-hidden="true"]')).not.toBeNull();
    expect(screen.getByText('Rating').closest('[aria-hidden="true"]')).not.toBeNull();
  });

  /** ⚠ STATS WITHOUT AN `srLabel` MUST BE UNTOUCHED — no blanket aria-hiding of the strip. */
  it('leaves the self-describing stats exposed to assistive tech', () => {
    render(<HeroStatsStrip view={makeView({ consultationCount: 124, certCount: 2 })} />);

    expect(screen.getByText('124+').closest('[aria-hidden="true"]')).toBeNull();
    expect(screen.getByText('Consultations').closest('[aria-hidden="true"]')).toBeNull();
  });

  /**
   * ⚠⚠ OMITTED ENTIRELY AT ZERO REVIEWS — not "0.0", not "—", not a greyed placeholder. The
   * scale starts at 1, so a zero would fabricate a bad score for an unreviewed expert.
   */
  it('omits the rating stat completely when the expert has no reviews', () => {
    const { container } = render(
      <HeroStatsStrip view={makeView({ ratingAverage: null, ratingCount: 0, certCount: 2 })} />
    );

    expect(screen.queryByText('Rating')).not.toBeInTheDocument();
    expect(container.textContent ?? '').not.toContain('0.0');
    expect(container.textContent ?? '').not.toContain('(0)');
    // The other stats are unaffected — omission is per-stat, not all-or-nothing.
    expect(screen.getByText('Certs')).toBeInTheDocument();
  });
});

describe('HeroStatsStrip — the pre-existing omit-dont-fabricate rule still holds', () => {
  it('renders nothing at all when no stat is backable', () => {
    const { container } = render(<HeroStatsStrip view={makeView()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the backable stats and omits the rest', () => {
    render(
      <HeroStatsStrip
        view={makeView({ consultationCount: 124, yearsExperience: 9, certCount: 0 })}
      />
    );

    expect(screen.getByText('124+')).toBeInTheDocument();
    expect(screen.getByText('9')).toBeInTheDocument();
    expect(screen.queryByText('Certs')).not.toBeInTheDocument();
  });
});

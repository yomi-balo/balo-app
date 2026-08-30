import { describe, it, expect } from 'vitest';
import type { ExpertSearchRow } from '@balo/db';
import { mapRowToExpertSearchResult } from './mapper.js';

const NOW = new Date('2026-06-02T00:00:00.000Z');

function buildRow(overrides: Partial<ExpertSearchRow> = {}): ExpertSearchRow {
  return {
    id: 'expert-1',
    username: 'jdoe',
    firstName: 'Jane',
    lastName: 'Doe',
    avatarUrl: 'https://cdn.example.com/a.png',
    countryCode: 'AU',
    headline: 'Salesforce architect',
    bio: 'Ten years of platform work.',
    rateCents: 250,
    earliestAvailableAt: new Date('2026-06-03T09:30:00.000Z'),
    isSalesforceMvp: true,
    isSalesforceCta: false,
    isCertifiedTrainer: true,
    yearStartedSalesforce: 2016,
    agencyName: 'Acme Consulting',
    agencyLogoUrl: 'https://cdn.example.com/logo.png',
    consultationCount: 7,
    ratingAverage: 4.3,
    ratingCount: 2,
    languages: [
      { name: 'English', flagEmoji: '🇬🇧' },
      { name: 'French', flagEmoji: null },
    ],
    competencies: [
      {
        productId: 'sales-cloud',
        productName: 'Sales Cloud',
        supportTypeSlug: 'technical-fix-support',
        proficiency: 5,
      },
    ],
    ...overrides,
  };
}

describe('mapRowToExpertSearchResult', () => {
  it('assembles the full name from first + last', () => {
    expect(mapRowToExpertSearchResult(buildRow(), NOW).name).toBe('Jane Doe');
  });

  it('falls back to username when names are missing', () => {
    const row = buildRow({ firstName: null, lastName: null, username: 'jdoe' });
    expect(mapRowToExpertSearchResult(row, NOW).name).toBe('jdoe');
  });

  it('uses only the present name part', () => {
    const row = buildRow({ firstName: 'Jane', lastName: null });
    expect(mapRowToExpertSearchResult(row, NOW).name).toBe('Jane');
  });

  it('falls back to empty string when no name and no username', () => {
    const row = buildRow({ firstName: null, lastName: null, username: null });
    expect(mapRowToExpertSearchResult(row, NOW).name).toBe('');
  });

  it('converts rate cents to the CLIENT ALL-IN dollars rate (fee included)', () => {
    // BAL-493 / D1 — applyBaloFee(250, 2500) = round(312.5) = 313 → 3.13.
    // Was `2.5` (the un-marked-up consultant rate) before the D1 serializer fix.
    expect(mapRowToExpertSearchResult(buildRow({ rateCents: 250 }), NOW).rate).toBe(3.13);
  });

  it('maps null rate to null', () => {
    expect(mapRowToExpertSearchResult(buildRow({ rateCents: null }), NOW).rate).toBeNull();
  });

  it('keeps a zero rate as 0 (not null)', () => {
    // applyBaloFee(0, ·) = 0 — the markup does not fabricate a rate.
    expect(mapRowToExpertSearchResult(buildRow({ rateCents: 0 }), NOW).rate).toBe(0);
  });

  it('serializes nextAvailableAt to ISO', () => {
    const result = mapRowToExpertSearchResult(buildRow(), NOW);
    expect(result.nextAvailableAt).toBe('2026-06-03T09:30:00.000Z');
  });

  it('maps null availability to null', () => {
    const result = mapRowToExpertSearchResult(buildRow({ earliestAvailableAt: null }), NOW);
    expect(result.nextAvailableAt).toBeNull();
  });

  it('maps languages with flag emoji passthrough (incl. null)', () => {
    const result = mapRowToExpertSearchResult(buildRow(), NOW);
    expect(result.languages).toEqual([
      { name: 'English', flagEmoji: '🇬🇧' },
      { name: 'French', flagEmoji: null },
    ]);
  });

  it('maps an agency with a logo', () => {
    const result = mapRowToExpertSearchResult(buildRow(), NOW);
    expect(result.agency).toEqual({
      name: 'Acme Consulting',
      logoUrl: 'https://cdn.example.com/logo.png',
    });
  });

  it('maps an agency with a null logo', () => {
    const result = mapRowToExpertSearchResult(buildRow({ agencyLogoUrl: null }), NOW);
    expect(result.agency).toEqual({ name: 'Acme Consulting', logoUrl: null });
  });

  it('maps no agency to null', () => {
    const result = mapRowToExpertSearchResult(
      buildRow({ agencyName: null, agencyLogoUrl: null }),
      NOW
    );
    expect(result.agency).toBeNull();
  });

  it('builds the distinctions object', () => {
    const result = mapRowToExpertSearchResult(buildRow(), NOW);
    expect(result.distinctions).toEqual({
      isSalesforceMvp: true,
      isSalesforceCta: false,
      isCertifiedTrainer: true,
    });
  });

  // BAL-422 — this used to pin `rating` as ALWAYS null (the aggregate did not exist). It now
  // pins PASS-THROUGH of the denormalised columns in both directions.
  it('passes the rating aggregate through unchanged', () => {
    const result = mapRowToExpertSearchResult(buildRow(), NOW);
    expect(result.rating).toBe(4.3);
    expect(result.ratingCount).toBe(2);
  });

  it('keeps rating null (never 0) for an expert with no reviews', () => {
    const result = mapRowToExpertSearchResult(
      buildRow({ ratingAverage: null, ratingCount: 0 }),
      NOW
    );
    expect(result.rating).toBeNull();
    expect(result.ratingCount).toBe(0);
  });

  it('passes through countryCode', () => {
    expect(mapRowToExpertSearchResult(buildRow({ countryCode: 'FR' }), NOW).countryCode).toBe('FR');
  });

  it('computes yearsExperience from year started', () => {
    const result = mapRowToExpertSearchResult(buildRow({ yearStartedSalesforce: 2016 }), NOW);
    expect(result.yearsExperience).toBe(10);
  });

  it('maps unset year started to null yearsExperience', () => {
    const result = mapRowToExpertSearchResult(buildRow({ yearStartedSalesforce: null }), NOW);
    expect(result.yearsExperience).toBeNull();
  });

  it('passes through consultationCount', () => {
    expect(
      mapRowToExpertSearchResult(buildRow({ consultationCount: 7 }), NOW).consultationCount
    ).toBe(7);
  });

  it('passes through competencies (productId, productName, supportTypeSlug, proficiency)', () => {
    const result = mapRowToExpertSearchResult(buildRow(), NOW);
    expect(result.competencies).toEqual([
      {
        productId: 'sales-cloud',
        productName: 'Sales Cloud',
        supportTypeSlug: 'technical-fix-support',
        proficiency: 5,
      },
    ]);
  });

  it('maps an expert with no competencies to an empty array', () => {
    expect(mapRowToExpertSearchResult(buildRow({ competencies: [] }), NOW).competencies).toEqual(
      []
    );
  });

  it('passes through id, username, avatarUrl, headline and bio', () => {
    const result = mapRowToExpertSearchResult(buildRow(), NOW);
    expect(result.id).toBe('expert-1');
    expect(result.username).toBe('jdoe');
    expect(result.avatarUrl).toBe('https://cdn.example.com/a.png');
    expect(result.headline).toBe('Salesforce architect');
    expect(result.bio).toBe('Ten years of platform work.');
  });
});

/**
 * BAL-493 AC-5 / D1 — the PUBLIC SERIALIZER BOUNDARY invariant.
 *
 * Two things are pinned here, and they are why this is a describe and not a comment:
 *
 * (a) the emitted `rate` is the CLIENT ALL-IN rate (Balo fee applied at the DEFAULT bps).
 *     The un-marked-up consultant rate lives on the DB row and stays there —
 *     `packages/db/src/repositories/experts.integration.test.ts` pins `rateCents` as
 *     un-marked-up and MUST keep passing unchanged. If it ever fails, the markup was put in
 *     the wrong layer: move the markup, never that assertion.
 *
 * (b) NO margin, fee-bps or expert-earnings field is present in the public payload AT ALL.
 *     The key-set assertion is EXHAUSTIVE on purpose, so that widening the public DTO becomes
 *     a reviewed act (the same discipline the DB projection test applies) rather than
 *     something that rides along with an unrelated field.
 */
describe('public serializer boundary (BAL-493 AC-5)', () => {
  it('emits the marked-up client rate, not the consultant rate', () => {
    // applyBaloFee(250, 2500) = round(250 × 12500 / 10000) = round(312.5) = 313 → 3.13
    const dto = mapRowToExpertSearchResult(buildRow({ rateCents: 250 }), NOW);
    expect(dto.rate).toBe(3.13);
    // The un-marked-up consultant rate must NOT be what ships.
    expect(dto.rate).not.toBe(2.5);
  });

  it('emits EXACTLY these keys — widening the public DTO must be a reviewed act', () => {
    const dto = mapRowToExpertSearchResult(buildRow(), NOW);
    expect(Object.keys(dto).sort()).toEqual([
      'agency',
      'avatarUrl',
      'bio',
      'competencies',
      'consultationCount',
      'countryCode',
      'distinctions',
      'headline',
      'id',
      'languages',
      'name',
      'nextAvailableAt',
      'rate',
      'rating',
      'ratingCount',
      'username',
      'yearsExperience',
    ]);
  });

  it('leaks no margin, fee-bps or expert-earnings field', () => {
    const dto = mapRowToExpertSearchResult(buildRow(), NOW);
    expect(dto).not.toHaveProperty('rateCents');
    expect(dto).not.toHaveProperty('baloFeeBps');
    expect(dto).not.toHaveProperty('feeBps');
    expect(dto).not.toHaveProperty('margin');
    expect(dto).not.toHaveProperty('expertEarnings');
    expect(dto).not.toHaveProperty('payout');
  });

  it('keeps the null and zero rate edges intact under the markup', () => {
    expect(mapRowToExpertSearchResult(buildRow({ rateCents: null }), NOW).rate).toBeNull();
    expect(mapRowToExpertSearchResult(buildRow({ rateCents: 0 }), NOW).rate).toBe(0);
  });
});

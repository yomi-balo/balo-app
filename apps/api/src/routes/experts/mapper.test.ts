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

  it('converts rate cents to dollars', () => {
    expect(mapRowToExpertSearchResult(buildRow({ rateCents: 250 }), NOW).rate).toBe(2.5);
  });

  it('maps null rate to null', () => {
    expect(mapRowToExpertSearchResult(buildRow({ rateCents: null }), NOW).rate).toBeNull();
  });

  it('keeps a zero rate as 0 (not null)', () => {
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

  it('always sets rating to null', () => {
    expect(mapRowToExpertSearchResult(buildRow(), NOW).rating).toBeNull();
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

import { describe, it, expect } from 'vitest';
import { deriveInitials, mapSearchResultToCardData } from './expert-card-mapper';
import type { ExpertSearchResultDTO } from './search-data';

describe('deriveInitials', () => {
  it('takes first + last token initials for multi-word names', () => {
    expect(deriveInitials('Anil Pilania')).toBe('AP');
    expect(deriveInitials('Maria de la Cruz')).toBe('MC');
  });

  it('takes the first char for a single token', () => {
    expect(deriveInitials('Cher')).toBe('C');
  });

  it('returns ? for empty/whitespace', () => {
    expect(deriveInitials('')).toBe('?');
    expect(deriveInitials('   ')).toBe('?');
  });

  it('collapses extra whitespace', () => {
    expect(deriveInitials('  Jane   Doe  ')).toBe('JD');
  });

  it('uppercases lowercase names', () => {
    expect(deriveInitials('jane doe')).toBe('JD');
  });

  it('handles unicode first characters', () => {
    expect(deriveInitials('Élodie Çelik')).toBe('ÉÇ');
  });
});

const baseDto: ExpertSearchResultDTO = {
  id: 'expert-1',
  username: 'anil',
  name: 'Anil Pilania',
  avatarUrl: 'https://cdn/avatar.png',
  headline: 'Salesforce Architect',
  bio: 'Bio here',
  countryCode: 'CA',
  rate: 3.13,
  nextAvailableAt: '2026-06-03T09:00:00Z',
  languages: [{ name: 'English', flagEmoji: '🇬🇧' }],
  agency: { name: 'MIDCAI', logoUrl: null },
  distinctions: { isSalesforceMvp: true, isSalesforceCta: false, isCertifiedTrainer: false },
  rating: 4.3,
  ratingCount: 2,
  yearsExperience: 9,
  consultationCount: 124,
  competencies: [
    {
      productId: 'sales-cloud',
      productName: 'Sales Cloud',
      supportTypeSlug: 'technical-fix-support',
      proficiency: 5,
    },
    {
      productId: 'sales-cloud',
      productName: 'Sales Cloud',
      supportTypeSlug: 'architecture-integrations',
      proficiency: 4,
    },
    {
      productId: 'service-cloud',
      productName: 'Service Cloud',
      supportTypeSlug: 'platform-training',
      proficiency: 3,
    },
  ],
};

describe('mapSearchResultToCardData', () => {
  // BAL-422 — this used to pin the v1 hardcode (`ratingCount: 0`, `rating: null`), which
  // dead-ended the already-mounted RatingBadge. It now pins PASS-THROUGH in both directions.
  it('passes the rating aggregate through from the DTO', () => {
    const card = mapSearchResultToCardData(baseDto);
    expect(card.rating).toBe(4.3);
    expect(card.ratingCount).toBe(2);
  });

  it('keeps rating null (never 0) for an expert with no reviews', () => {
    const card = mapSearchResultToCardData({ ...baseDto, rating: null, ratingCount: 0 });
    expect(card.rating).toBeNull();
    expect(card.ratingCount).toBe(0);
  });

  it('builds expertise from the DTO competencies (product grouping + slug → SkillType)', () => {
    const card = mapSearchResultToCardData(baseDto);
    expect(card.expertise).toEqual([
      { product: 'Sales Cloud', skills: ['technical', 'architecture'] },
      { product: 'Service Cloud', skills: ['admin'] },
    ]);
  });

  it('skips competencies with proficiency <= 0 when building expertise', () => {
    const card = mapSearchResultToCardData({
      ...baseDto,
      competencies: [
        {
          productId: 'sales-cloud',
          productName: 'Sales Cloud',
          supportTypeSlug: 'technical-fix-support',
          proficiency: 0,
        },
        {
          productId: 'service-cloud',
          productName: 'Service Cloud',
          supportTypeSlug: 'platform-training',
          proficiency: 3,
        },
      ],
    });
    expect(card.expertise).toEqual([{ product: 'Service Cloud', skills: ['admin'] }]);
  });

  it('maps an expert with no competencies to an empty expertise array', () => {
    const card = mapSearchResultToCardData({ ...baseDto, competencies: [] });
    expect(card.expertise).toEqual([]);
  });

  it('derives initials from the name', () => {
    expect(mapSearchResultToCardData(baseDto).initials).toBe('AP');
  });

  it('passes through rate, agency, distinctions, languages, and identity fields', () => {
    const card = mapSearchResultToCardData(baseDto);
    expect(card).toMatchObject({
      id: 'expert-1',
      username: 'anil',
      name: 'Anil Pilania',
      avatarUrl: 'https://cdn/avatar.png',
      headline: 'Salesforce Architect',
      bio: 'Bio here',
      countryCode: 'CA',
      rate: 3.13,
      nextAvailableAt: '2026-06-03T09:00:00Z',
      languages: [{ name: 'English', flagEmoji: '🇬🇧' }],
      agency: { name: 'MIDCAI', logoUrl: null },
      distinctions: { isSalesforceMvp: true, isSalesforceCta: false, isCertifiedTrainer: false },
      yearsExperience: 9,
      consultationCount: 124,
    });
  });

  it('preserves null rate and null avatar/agency', () => {
    const card = mapSearchResultToCardData({
      ...baseDto,
      rate: null,
      avatarUrl: null,
      agency: null,
      username: null,
    });
    expect(card.rate).toBeNull();
    expect(card.avatarUrl).toBeNull();
    expect(card.agency).toBeNull();
    expect(card.username).toBeNull();
  });
});

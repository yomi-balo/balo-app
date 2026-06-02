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
  rating: null,
  yearsExperience: 9,
  consultationCount: 124,
};

describe('mapSearchResultToCardData', () => {
  it('sets v1 defaults reviewCount:0, expertise:[], rating:null', () => {
    const card = mapSearchResultToCardData(baseDto);
    expect(card.reviewCount).toBe(0);
    expect(card.expertise).toEqual([]);
    expect(card.rating).toBeNull();
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

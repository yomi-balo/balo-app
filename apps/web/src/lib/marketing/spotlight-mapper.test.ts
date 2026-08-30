import { describe, it, expect } from 'vitest';
import type { PublicExpertProfile } from '@balo/db';
import type { ExpertProfileView } from '@/components/expert/profile/types';
import { mapPublicProfileToCardData } from './spotlight-mapper';

const VIEW: ExpertProfileView = {
  expertId: 'expert-1',
  agencyId: 'agency-1',
  name: 'Dana Okafor',
  firstName: 'Dana',
  initials: 'DO',
  headline: 'Senior Salesforce Architect',
  bio: 'Ships Data Cloud programmes end to end.',
  avatarKey: 'avatars/dana.jpg',
  countryCode: 'AU',
  country: 'Australia',
  // ⚠ already D1-marked-up by `mapProfileToView` — the mapper must pass this through verbatim.
  rate: 11.88,
  yearsExperience: 9,
  consultationCount: 42,
  certCount: 3,
  availableForWork: true,
  baloVerified: true,
  topRated: false,
  ratingAverage: 4.8,
  ratingCount: 21,
  competencies: [],
  certifications: [],
  languages: [{ name: 'English', flagEmoji: '🇬🇧' }],
  languagesLabel: 'English',
  agency: {
    name: 'CloudPeak',
    slug: 'cloudpeak',
    logoUrl: 'https://cdn/cloudpeak.png',
    initials: 'CP',
  },
  workHistory: [],
};

// Only `competencies` is read by the mapper — cast rather than enumerate every
// `PublicExpertProfile` column the fixture doesn't exercise.
const ROW = {
  competencies: [
    {
      productId: 'p-1',
      proficiency: 8,
      product: { name: 'Data Cloud' },
      supportType: { slug: 'architecture-integrations' },
    },
    {
      productId: 'p-1',
      proficiency: 3,
      product: { name: 'Data Cloud' },
      supportType: { slug: 'technical-fix-support' },
    },
    {
      productId: 'p-2',
      proficiency: 0,
      product: { name: 'Slack' },
      supportType: { slug: 'platform-training' },
    },
  ],
} as unknown as PublicExpertProfile;

describe('mapPublicProfileToCardData', () => {
  it('maps every field from the view, direct pass-through where the plan says direct', () => {
    const card = mapPublicProfileToCardData(ROW, VIEW, 'dana', 'https://cdn/dana-thumb.jpg');

    expect(card).toEqual({
      id: 'expert-1',
      username: 'dana',
      name: 'Dana Okafor',
      initials: 'DO',
      avatarUrl: 'https://cdn/dana-thumb.jpg',
      headline: 'Senior Salesforce Architect',
      bio: 'Ships Data Cloud programmes end to end.',
      countryCode: 'AU',
      rate: 11.88,
      nextAvailableAt: null,
      languages: [{ name: 'English', flagEmoji: '🇬🇧' }],
      agency: {
        name: 'CloudPeak',
        slug: 'cloudpeak',
        logoUrl: 'https://cdn/cloudpeak.png',
        initials: 'CP',
      },
      distinctions: { isSalesforceMvp: false, isSalesforceCta: false, isCertifiedTrainer: false },
      rating: 4.8,
      ratingCount: 21,
      yearsExperience: 9,
      consultationCount: 42,
      expertise: [{ product: 'Data Cloud', skills: ['architecture', 'technical'] }],
    });
  });

  it('never re-applies the Balo fee — rate is a bare pass-through of view.rate (AC-5 boundary)', () => {
    const card = mapPublicProfileToCardData(ROW, { ...VIEW, rate: 3.13 }, 'dana', null);
    expect(card.rate).toBe(3.13);
  });

  /**
   * BAL-493 fix round 2 (review MAJOR 10) — plan §7.5's THIRD fee-concealment boundary. The
   * named-key denial block already exists at `apps/api/src/routes/experts/mapper.test.ts` and
   * `profile-view.test.ts` ("Three boundaries, one invariant") but was missing here, the one
   * boundary that feeds the new public spotlight. `spotlight-mapper.ts:58` is a bare `rate:
   * view.rate` pass-through with no re-application of the fee — this pins it explicitly, so a
   * future field addition here is a REVIEWED act, not a silent widening.
   */
  it('leaks no margin, fee-bps or expert-earnings field to the spotlight card (AC-5 boundary)', () => {
    const card = mapPublicProfileToCardData(ROW, { ...VIEW, rate: 11.88 }, 'dana', null);
    expect(card).not.toHaveProperty('rateCents');
    expect(card).not.toHaveProperty('baloFeeBps');
    expect(card).not.toHaveProperty('feeBps');
    expect(card).not.toHaveProperty('margin');
    expect(card).not.toHaveProperty('expertEarnings');
    expect(card).not.toHaveProperty('payout');
    // The marked-up rate passes through UNCHANGED — the mapper must never re-apply D1's markup.
    expect(card.rate).toBe(11.88);
  });

  it('passes through a null rate unchanged (no rate set)', () => {
    const card = mapPublicProfileToCardData(ROW, { ...VIEW, rate: null }, 'dana', null);
    expect(card.rate).toBeNull();
  });

  it('makes no live-calendar promise — nextAvailableAt is always null', () => {
    const card = mapPublicProfileToCardData(ROW, { ...VIEW, availableForWork: true }, 'dana', null);
    expect(card.nextAvailableAt).toBeNull();
  });

  it('never fabricates distinctions — always the all-false object', () => {
    const card = mapPublicProfileToCardData(ROW, VIEW, 'dana', null);
    expect(card.distinctions).toEqual({
      isSalesforceMvp: false,
      isSalesforceCta: false,
      isCertifiedTrainer: false,
    });
  });

  it('passes through a null rating as NO REVIEWS, never fabricating 0', () => {
    const card = mapPublicProfileToCardData(
      ROW,
      { ...VIEW, ratingAverage: null, ratingCount: 0 },
      'dana',
      null
    );
    expect(card.rating).toBeNull();
    expect(card.ratingCount).toBe(0);
  });

  it('drops zero-proficiency competencies via buildExpertise, deduping skills per product', () => {
    const card = mapPublicProfileToCardData(ROW, VIEW, 'dana', null);
    expect(card.expertise).toEqual([
      { product: 'Data Cloud', skills: ['architecture', 'technical'] },
    ]);
  });

  it('carries the lookup-key username through unchanged', () => {
    const card = mapPublicProfileToCardData(ROW, VIEW, 'priya-k', null);
    expect(card.username).toBe('priya-k');
  });
});

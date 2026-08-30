import type { PublicExpertProfile } from '@balo/db';
import type { ExpertCardData, ExpertCardDistinctions } from '@/components/expert/expert-card.types';
import { buildExpertise } from '@/components/expert/expert-card.utils';
import type { ExpertProfileView } from '@/components/expert/profile/types';

/**
 * BAL-493 §8.2 — the ONLY thing standing between a curated `FEATURED_EXPERT_USERNAMES` read
 * and the canonical `<ExpertCard variant="grid">`. Thin, and deliberately so.
 *
 * Not in the public read's column allow-list, and the public profile page shows them
 * nowhere either — the spotlight stays consistent with the destination rather than widening
 * `findPublicProfileByUsername`'s allow-list for a badge nobody derives yet.
 */
const NO_DISTINCTIONS: ExpertCardDistinctions = {
  isSalesforceMvp: false,
  isSalesforceCta: false,
  isCertifiedTrainer: false,
};

/**
 * Map one curated, publicly-visible profile → `ExpertCardData`.
 *
 * Takes BOTH the raw repository row (`row`) and its mapped view (`view`) — `expertise`
 * needs the row's raw `competencies` shape (`{productId, proficiency, product:{name},
 * supportType:{slug}}`, structurally compatible with `buildExpertise`'s input), while every
 * other field is sourced from the already-mapped, already-D1-marked-up view.
 *
 * ⚠ `rate` is `view.rate` — ALREADY marked up by D1 (`publicDisplayRatePerMinute`, applied at
 * `profile-view.ts`'s `mapProfileToView`). This mapper NEVER re-applies the fee: doing so
 * would double the markup shown on the marketing home relative to `/experts` and
 * `/experts/{username}`, which read the same `view.rate`.
 *
 * @param row `expertsRepository.findPublicProfileByUsername`'s raw result — already gated
 *   `searchable = true AND approved_at IS NOT NULL` by that repository method (not re-checked
 *   here; NOT a visibility bypass — D2's consent list is re-verified at the READ, not here).
 * @param view `mapProfileToView(row)` — the same pure mapper the public profile page uses.
 * @param username the lookup key `row` was fetched by. `expert_profiles.username` is
 *   nullable in general, but we looked this row up BY username, so it is non-null here by
 *   construction — no runtime guard needed.
 * @param avatarUrl `getAvatarUrl(view.avatarKey, 'thumbnail')`, resolved server-side by the
 *   caller (mirrors `experts/[username]/page.tsx`).
 */
export function mapPublicProfileToCardData(
  row: PublicExpertProfile,
  view: ExpertProfileView,
  username: string,
  avatarUrl: string | null
): ExpertCardData {
  return {
    id: view.expertId,
    username,
    name: view.name,
    initials: view.initials,
    avatarUrl,
    headline: view.headline,
    bio: view.bio,
    countryCode: view.countryCode,
    rate: view.rate,
    // No live-calendar promise on the marketing home — `AvailabilityPill` renders its
    // no-claim state. Deliberate deviation from the ref's "Available" badge (§8.2).
    nextAvailableAt: null,
    languages: view.languages,
    agency: view.agency,
    distinctions: NO_DISTINCTIONS,
    rating: view.ratingAverage,
    ratingCount: view.ratingCount,
    yearsExperience: view.yearsExperience,
    consultationCount: view.consultationCount,
    expertise: buildExpertise(row.competencies),
  };
}

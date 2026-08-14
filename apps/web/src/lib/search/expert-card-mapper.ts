import { buildExpertise, type ExpertCardData } from '@/components/expert';
import type { ExpertSearchResultDTO } from './search-data';

/**
 * Maps the API search-result DTO to the `ExpertCardData` the `ExpertCard` reuses.
 *
 * `ExpertCardData` needs two things the DTO shapes differently:
 * - `initials` — derived from `name`.
 * - `expertise` — built from the DTO's flat `competencies` via the shared
 *   `buildExpertise` (groups by product, maps support-type slug → SkillType).
 *   An expert with no competencies yields `[]`, which the card handles cleanly
 *   (ExpertisePills returns null; buildHeadline falls back to `headline`).
 *
 * ⚠ BAL-422 — `rating` / `ratingCount` NOW CARRY REAL DATA. They used to be hardcoded
 * `null` / `0` here, which short-circuited the already-mounted `RatingBadge` for every
 * expert on the platform. Both are straight pass-throughs of the DTO now; the mapper
 * invents nothing.
 *
 * ⚠ A `null` rating STILL renders nothing — it means NO REVIEWS, not a zero score, and
 * `RatingBadge` gates on it. Do not coalesce it to `0`: the scale starts at 1, so 0.0 is a
 * fabricated rating and the one value this feature must never display.
 */

export function deriveInitials(name: string): string {
  const tokens = name.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return '?';
  if (tokens.length === 1) return tokens[0]!.charAt(0).toUpperCase();
  return (tokens[0]!.charAt(0) + tokens[tokens.length - 1]!.charAt(0)).toUpperCase();
}

export function mapSearchResultToCardData(result: ExpertSearchResultDTO): ExpertCardData {
  return {
    id: result.id,
    username: result.username,
    name: result.name,
    initials: deriveInitials(result.name),
    avatarUrl: result.avatarUrl,
    headline: result.headline,
    bio: result.bio,
    countryCode: result.countryCode,
    rate: result.rate,
    nextAvailableAt: result.nextAvailableAt,
    languages: result.languages,
    agency: result.agency,
    distinctions: result.distinctions,
    rating: result.rating,
    ratingCount: result.ratingCount,
    yearsExperience: result.yearsExperience,
    consultationCount: result.consultationCount,
    expertise: buildExpertise(
      result.competencies.map((c) => ({
        productId: c.productId,
        proficiency: c.proficiency,
        product: { name: c.productName },
        supportType: { slug: c.supportTypeSlug },
      }))
    ),
  };
}

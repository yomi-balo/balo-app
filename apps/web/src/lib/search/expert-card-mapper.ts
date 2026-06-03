import { buildExpertise, type ExpertCardData } from '@/components/expert';
import type { ExpertSearchResultDTO } from './search-data';

/**
 * Maps the API search-result DTO to the `ExpertCardData` the `ExpertCard` reuses.
 *
 * `ExpertCardData` needs three things the DTO shapes differently:
 * - `initials` — derived from `name`.
 * - `reviewCount` — `0` in v1 (rating UI is null-gated and short-circuits).
 * - `expertise` — built from the DTO's flat `skills` via the shared
 *   `buildExpertise` (groups by product, maps support-type slug → SkillType).
 *   An expert with no skills yields `[]`, which the card handles cleanly
 *   (ExpertisePills returns null; buildHeadline falls back to `headline`).
 * `rating` passes the DTO's `null` straight through.
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
    rating: null,
    reviewCount: 0,
    yearsExperience: result.yearsExperience,
    consultationCount: result.consultationCount,
    expertise: buildExpertise(
      result.skills.map((s) => ({
        skillId: s.skillId,
        proficiency: s.proficiency,
        skill: { name: s.skillName },
        supportType: { slug: s.supportTypeSlug },
      }))
    ),
  };
}

import type { ExpertCardData } from '@/components/expert';
import type { ExpertSearchResultDTO } from './search-data';

/**
 * Maps the API search-result DTO to the `ExpertCardData` the `ExpertCard` reuses.
 *
 * `ExpertCardData` needs three things the DTO lacks:
 * - `initials` — derived from `name`.
 * - `reviewCount` — `0` in v1 (rating UI is null-gated and short-circuits).
 * - `expertise` — NOT in the DTO; v1 default `[]`. The card handles empty cleanly
 *   (ExpertisePills returns null; buildHeadline falls back to `headline`). A future
 *   ticket adding expertise to the DTO only changes this mapper.
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
    expertise: [],
  };
}

/**
 * Canonical, enriched expert-search result DTO. OWNED by this endpoint.
 *
 * `apps/api` MUST NOT import from `apps/web`. The on-disk web `ExpertCardData`
 * (`apps/web/src/components/expert/expert-card.types.ts`) is the UN-enriched type
 * and lacks `nextAvailableAt/languages/agency/distinctions/countryCode`
 * (BAL-245 enrichment unmerged). This endpoint therefore owns the canonical
 * enriched result DTO, named `ExpertSearchResult` (a distinct name — NOT
 * `ExpertCardData` — because it is a superset and the web type is mid-migration).
 * BAL-245 reconciles the web `ExpertCardData` to match this shape later (and may
 * then promote it to `packages/shared`).
 */

export interface ExpertSearchLanguage {
  name: string;
  flagEmoji: string | null;
}

/** `null` when the expert has no agency. */
export interface ExpertSearchAgency {
  name: string;
  logoUrl: string | null;
}

export interface ExpertSearchDistinctions {
  isSalesforceMvp: boolean;
  isSalesforceCta: boolean;
  isCertifiedTrainer: boolean;
}

export interface ExpertSearchResult {
  /** expert_profiles.id */
  id: string;
  /** for profile linking by BAL-247 */
  username: string | null;
  /** [firstName, lastName].filter(Boolean).join(' '); fallback username, else '' */
  name: string;
  /** users.avatar_url */
  avatarUrl: string | null;
  /** expert_profiles.headline */
  headline: string | null;
  /** expert_profiles.bio */
  bio: string | null;
  /** users.country_code */
  countryCode: string | null;
  /** rate_cents / 100 (dollars/min); null if rate_cents null */
  rate: number | null;
  /** earliest_available_at ISO 8601; null when gate OFF + no cache */
  nextAvailableAt: string | null;
  /** expert_languages join (name, flagEmoji) */
  languages: ExpertSearchLanguage[];
  /** { name, logoUrl } or null */
  agency: ExpertSearchAgency | null;
  distinctions: ExpertSearchDistinctions;
  /** DEFERRED — ALWAYS null, never fabricated */
  rating: null;
  /** now.getFullYear() - year_started_salesforce; null if unset */
  yearsExperience: number | null;
  /** proxy: confirmed, non-deleted consultations; degrades to 0 */
  consultationCount: number;
}

/** Array of objects with the display name (NOT a bare `Record<string, number>`). */
export interface FacetCount {
  id: string;
  name: string;
  count: number;
}

export interface ExpertSearchResponse {
  experts: ExpertSearchResult[];
  total: number;
  facetCounts: {
    /** per skills.id */
    products: FacetCount[];
    /** per support_types.id */
    supportTypes: FacetCount[];
    /** per languages.id */
    languages: FacetCount[];
  };
}

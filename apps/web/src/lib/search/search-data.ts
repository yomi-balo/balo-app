import { loggedFetch } from '@/lib/logging/fetch-wrapper';
import { filtersToSearchRequest, type SearchFilters, type SearchRequest } from './filters';

/**
 * The single data-fetch seam for Expert Search. The page server component reads
 * `searchParams`, parses them to `SearchFilters`, and calls `searchExperts` —
 * which does a server-side `fetch()` of the Fastify `GET /experts/search` route.
 *
 * Going through the route (not the repo) keeps a single owner of the search
 * contract: rate-limiting by IP, Redis facet caching, server analytics
 * (`search_performed` / `search_zero_results`), `Cache-Control`, and vertical-slug
 * resolution all live there. Calling the repo directly would bypass them.
 *
 * All page state tests mock THIS module:
 *   vi.mock('@/lib/search/search-data', () => ({ searchExperts: vi.fn() }))
 */

// ── Web mirror of apps/api/src/routes/experts/types.ts ────────────────
// Cross-app import is forbidden, so these mirror the API interfaces field-for-
// field. The `wasAvailabilityGated` field is added independently here (the API is
// adding it server-side in parallel). Mirror — do not re-derive.

export interface ExpertSearchLanguageDTO {
  name: string;
  flagEmoji: string | null;
}

/** `null` when the expert has no agency. */
export interface ExpertSearchAgencyDTO {
  name: string;
  logoUrl: string | null;
}

export interface ExpertSearchDistinctionsDTO {
  isSalesforceMvp: boolean;
  isSalesforceCta: boolean;
  isCertifiedTrainer: boolean;
}

/** One expert_skills row, flattened with the skill name + support-type slug. */
export interface ExpertSearchSkillDTO {
  skillId: string;
  skillName: string;
  supportTypeSlug: string;
  proficiency: number;
}

export interface ExpertSearchResultDTO {
  id: string;
  username: string | null;
  name: string;
  avatarUrl: string | null;
  headline: string | null;
  bio: string | null;
  countryCode: string | null;
  /** dollars/min; `null` if rate unset. */
  rate: number | null;
  /** ISO 8601; `null` when gate OFF + no cache. */
  nextAvailableAt: string | null;
  languages: ExpertSearchLanguageDTO[];
  agency: ExpertSearchAgencyDTO | null;
  distinctions: ExpertSearchDistinctionsDTO;
  /** DEFERRED — ALWAYS null. */
  rating: null;
  yearsExperience: number | null;
  consultationCount: number;
  /** expert_skills, proficiency-desc; powers the "Top expert in" pills. */
  skills: ExpertSearchSkillDTO[];
}

export interface FacetCountDTO {
  id: string;
  name: string;
  count: number;
}

export interface ExpertSearchResponseDTO {
  experts: ExpertSearchResultDTO[];
  total: number;
  facetCounts: {
    products: FacetCountDTO[];
    supportTypes: FacetCountDTO[];
    languages: FacetCountDTO[];
  };
  /**
   * `true` only when `total === 0` because the availability gate is on AND at
   * least one expert would have matched the same filters with the gate ignored.
   * Lets the zero-results UI distinguish "no skills match" from "matched but none
   * currently bookable". Always `false` when `total > 0` or the gate is off.
   */
  wasAvailabilityGated: boolean;
}

// Matches the seed-action precedent (apps/web/src/app/dev/_actions/seed.ts).
const API_BASE_URL =
  process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3002';

/**
 * Build the querystring for `GET /experts/search`. Arrays use repeated keys; empty
 * arrays and undefined params are omitted (the API treats absent === `[]`).
 */
function buildQueryString(request: SearchRequest): string {
  const params = new URLSearchParams();

  if (request.q !== undefined) params.set('q', request.q);
  for (const id of request.products) params.append('products', id);
  for (const id of request.supportTypes) params.append('supportTypes', id);
  for (const id of request.languages) params.append('languages', id);
  if (request.timeframe !== undefined) params.set('timeframe', request.timeframe);
  if (request.rateMin !== undefined) params.set('rateMin', String(request.rateMin));
  if (request.rateMax !== undefined) params.set('rateMax', String(request.rateMax));
  params.set('vertical', request.vertical);
  params.set('sort', request.sort);
  params.set('page', String(request.page));
  params.set('pageSize', String(request.pageSize));

  return params.toString();
}

export async function searchExperts(filters: SearchFilters): Promise<ExpertSearchResponseDTO> {
  const request = filtersToSearchRequest(filters);
  const qs = buildQueryString(request);

  const response = await loggedFetch(`${API_BASE_URL}/experts/search?${qs}`, {
    service: 'expert-search',
    method: 'GET',
    // Align with the API's Cache-Control max-age=30. `next` is part of Next.js's
    // global RequestInit augmentation, which loggedFetch's FetchOptions extends.
    next: { revalidate: 30 },
  });

  if (!response.ok) {
    throw new Error(`expert-search request failed with status ${response.status}`);
  }

  return (await response.json()) as ExpertSearchResponseDTO;
}

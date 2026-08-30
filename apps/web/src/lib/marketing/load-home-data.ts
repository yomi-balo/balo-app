import 'server-only';
import { cache } from 'react';
import { expertsRepository } from '@balo/db';
import { FEATURED_EXPERT_LIMIT, FEATURED_EXPERT_USERNAMES } from '@balo/shared/marketing';
import { log } from '@/lib/logging';
import type { ExpertCardData } from '@/components/expert/expert-card.types';
import { mapProfileToView } from '@/lib/expert-profile/profile-view';
import { EMPTY_FILTERS } from '@/lib/search/filters';
import { loadSearchTaxonomy } from '@/lib/search/load-taxonomy';
import { searchExperts, type ExpertSearchResponseDTO } from '@/lib/search/search-data';
import { buildProductNameMap, EMPTY_TAXONOMY, type ProductTaxonomy } from '@/lib/search/taxonomy';
import { getAvatarUrl } from '@/lib/storage/avatar-url';
import { resolveBenchTiles, type ResolvedBenchTile } from './bench-tiles';
import { resolvePopularChips, type PopularChip } from './popular-chips';
import { mapPublicProfileToCardData } from './spotlight-mapper';

/**
 * BAL-493 §6 — the marketing home's ONE server fetch, and what happens when it fails.
 *
 * ⚠ NOTHING IN THIS PAGE MAY THROW. A marketing front door that shows an error boundary is a
 * worse outcome than one missing its counts — every branch below degrades and logs instead.
 */
export interface MarketingHomeData {
  taxonomy: ProductTaxonomy;
  productNameMap: Record<string, string>;
  chips: PopularChip[];
  benchTiles: ResolvedBenchTile[];
  /** `null` ⇒ hide the live-count pill (the search fetch failed). */
  expertTotal: number | null;
  wasAvailabilityGated: boolean;
  /** 0..`FEATURED_EXPERT_LIMIT` — see the 0/1/2-card states (§8.3). */
  spotlight: ExpertCardData[];
}

function logError(message: string, error: unknown): void {
  log.error(message, {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
}

/**
 * `searchExperts(EMPTY_FILTERS)` (`lib/search/search-data.ts`) throws on a non-OK response —
 * unlike `loadSearchTaxonomy`, which never throws. Caught here so a single failed fetch never
 * takes the whole page down with it: bench counts hide, the live pill hides, everything else
 * on the page renders.
 */
async function loadSearchResult(): Promise<ExpertSearchResponseDTO | null> {
  try {
    return await searchExperts(EMPTY_FILTERS);
  } catch (error) {
    logError('Marketing home search fetch failed', error);
    return null;
  }
}

/**
 * The 18 bench tiles' product-id resolution and the 7 popular chips both need the taxonomy.
 * When it comes back empty (`loadSearchTaxonomy` already logs its own failure), skip
 * resolution entirely rather than let 25 individual "no taxonomy match" warnings fire at
 * once — this single warning is the documented signal for that failure mode.
 */
function resolveChipsAndTiles(
  taxonomy: ProductTaxonomy,
  searchResult: ExpertSearchResponseDTO | null
): { chips: PopularChip[]; benchTiles: ResolvedBenchTile[] } {
  if (taxonomy.groups.length === 0) {
    log.warn('Marketing home taxonomy empty');
    return { chips: [], benchTiles: [] };
  }

  return {
    chips: resolvePopularChips(taxonomy),
    benchTiles: resolveBenchTiles(taxonomy, searchResult?.facetCounts.products ?? []),
  };
}

/**
 * Request-scoped memo — same read `experts/[username]/page.tsx` already uses, so a featured
 * username that also happens to be viewed directly this request costs one query, not two.
 */
const loadFeaturedExpert = cache((username: string) =>
  expertsRepository.findPublicProfileByUsername(username)
);

/**
 * §8.2 — curated usernames → publicly-visible `ExpertCardData[]`, in parallel, in declared
 * order, never throwing. A username that 404s, or whose profile has since gone
 * unsearchable/unapproved, is silently omitted from the result (and logged) — D2's consent
 * list is re-checked against the canonical visibility gate at every read, not bypassed.
 */
async function loadSpotlight(): Promise<ExpertCardData[]> {
  const usernames = FEATURED_EXPERT_USERNAMES.slice(0, FEATURED_EXPERT_LIMIT);
  const settled = await Promise.allSettled(
    usernames.map((username) => loadFeaturedExpert(username))
  );

  const cards: ExpertCardData[] = [];
  for (let i = 0; i < settled.length; i++) {
    const username = usernames[i];
    const outcome = settled[i];
    if (username === undefined || outcome === undefined) continue;

    if (outcome.status === 'rejected') {
      logError(`Featured expert lookup failed for "${username}"`, outcome.reason);
      continue;
    }

    const row = outcome.value;
    if (!row) {
      log.warn('Featured expert not publicly visible', { username });
      continue;
    }

    // ⚠ THE MAPPER BLOCK IS INSIDE THE GUARD, NOT NEXT TO IT. `mapProfileToView` /
    // `getAvatarUrl` / `mapPublicProfileToCardData` are pure, but they read a real DB row —
    // a null where the view-model expects a value, or an unparseable `ratingAverage`, throws
    // synchronously. `Promise.allSettled` above only catches the LOOKUP; without this try the
    // throw escapes `loadSpotlight` and 500s the whole marketing front door. One bad curated
    // profile must cost exactly one card.
    try {
      const view = mapProfileToView(row);
      const avatarUrl = getAvatarUrl(view.avatarKey, 'thumbnail');
      cards.push(mapPublicProfileToCardData(row, view, username, avatarUrl));
    } catch (error) {
      log.warn('Featured expert card mapping failed', {
        username,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return cards;
}

/**
 * One settled arm → its value, or a logged fallback. The three loaders each guard themselves,
 * so a rejection reaching here is by definition an unanticipated one — hence `log.error`
 * rather than `warn`, and hence a fallback rather than a rethrow.
 */
function settledOr<T>(outcome: PromiseSettledResult<T>, fallback: T, message: string): T {
  if (outcome.status === 'fulfilled') return outcome.value;
  logError(message, outcome.reason);
  return fallback;
}

export async function loadHomeData(): Promise<MarketingHomeData> {
  /*
   * ⚠ `allSettled`, NOT `all` — this is the structural half of the "NOTHING MAY THROW"
   * contract at the top of this file. Each of the three loaders already catches its own
   * failures, but `Promise.all` rejects on the FIRST rejection, so the page's no-throw
   * property would rest entirely on all three staying internally correct forever. With
   * `allSettled` the combinator itself cannot reject, and a future loader that grows an
   * unguarded path degrades to a fallback + `log.error` instead of an error boundary on the
   * marketing front door.
   */
  const [searchOutcome, taxonomyOutcome, spotlightOutcome] = await Promise.allSettled([
    loadSearchResult(),
    loadSearchTaxonomy(),
    loadSpotlight(),
  ]);

  const searchResult = settledOr(searchOutcome, null, 'Marketing home search load threw');
  const taxonomy = settledOr(
    taxonomyOutcome,
    EMPTY_TAXONOMY,
    // `loadSearchTaxonomy` already logs and never rejects in practice — defence in depth only,
    // so a future change to its contract can't turn into an uncaught page 500.
    'Marketing home taxonomy load threw unexpectedly'
  );
  const spotlight = settledOr(
    spotlightOutcome,
    [] as ExpertCardData[],
    'Marketing home spotlight load threw unexpectedly'
  );

  const { chips, benchTiles } = resolveChipsAndTiles(taxonomy, searchResult);

  return {
    taxonomy,
    productNameMap: buildProductNameMap(taxonomy),
    chips,
    benchTiles,
    expertTotal: searchResult?.total ?? null,
    wasAvailabilityGated: searchResult?.wasAvailabilityGated ?? false,
    spotlight,
  };
}

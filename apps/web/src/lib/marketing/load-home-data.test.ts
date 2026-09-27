import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockFindPublicProfileByUsername,
  mockMapProfileToView,
  mockLoadSearchTaxonomy,
  mockSearchExperts,
  mockGetAvatarUrl,
  mockResolveBenchTiles,
  mockResolvePopularChips,
  mockMapPublicProfileToCardData,
  mockUnstableCache,
} = vi.hoisted(() => ({
  mockFindPublicProfileByUsername: vi.fn(),
  mockMapProfileToView: vi.fn(),
  mockLoadSearchTaxonomy: vi.fn(),
  mockSearchExperts: vi.fn(),
  mockGetAvatarUrl: vi.fn(),
  mockResolveBenchTiles: vi.fn(),
  mockResolvePopularChips: vi.fn(),
  mockMapPublicProfileToCardData: vi.fn(),
  // Passthrough, same pattern as `lib/expert-apply/reference-data.test.ts`: `unstable_cache`
  // needs Next's Data Cache runtime, unavailable in a plain vitest process. Recording the call
  // also lets the "rejects with DegradedHomeDataError" suite below invoke the wrapped strict
  // loader directly.
  mockUnstableCache: vi.fn((...args: unknown[]) => args[0]),
}));

vi.mock('server-only', () => ({}));

vi.mock('next/cache', () => ({
  unstable_cache: (...args: unknown[]) => mockUnstableCache(...args),
}));

vi.mock('@balo/db', () => ({
  expertsRepository: { findPublicProfileByUsername: mockFindPublicProfileByUsername },
}));

vi.mock('@balo/shared/marketing', () => ({
  FEATURED_EXPERT_USERNAMES: ['dana', 'priya', 'jonas'],
  FEATURED_EXPERT_LIMIT: 3,
}));

vi.mock('@/lib/expert-profile/profile-view', () => ({
  mapProfileToView: mockMapProfileToView,
}));

vi.mock('@/lib/search/load-taxonomy', () => ({
  loadSearchTaxonomy: mockLoadSearchTaxonomy,
}));

vi.mock('@/lib/search/search-data', () => ({
  searchExperts: mockSearchExperts,
}));

vi.mock('@/lib/storage/avatar-url', () => ({
  getAvatarUrl: mockGetAvatarUrl,
}));

vi.mock('./bench-tiles', () => ({
  resolveBenchTiles: mockResolveBenchTiles,
}));

vi.mock('./popular-chips', () => ({
  resolvePopularChips: mockResolvePopularChips,
}));

vi.mock('./spotlight-mapper', () => ({
  mapPublicProfileToCardData: mockMapPublicProfileToCardData,
}));

import { log } from '@/lib/logging';
import { EMPTY_TAXONOMY } from '@/lib/search/taxonomy';
import type { ExpertCardData } from '@/components/expert/expert-card.types';
import type { ResolvedBenchTile } from './bench-tiles';
import type { PopularChip } from './popular-chips';
import {
  loadHomeData,
  loadHomeDataResult,
  DegradedHomeDataError,
  type MarketingHomeData,
} from './load-home-data';

// The private strict loader `unstable_cache` wraps at module load — captured once so the
// "rejects with DegradedHomeDataError" suite can call it directly, bypassing the
// `loadHomeDataResult()` catch that would otherwise swallow the rejection.
const [firstUnstableCacheCall] = mockUnstableCache.mock.calls;
if (!firstUnstableCacheCall) {
  throw new Error('unstable_cache was not called during module load');
}
const [strictLoaderArg] = firstUnstableCacheCall;
const strictLoader = strictLoaderArg as () => Promise<MarketingHomeData>;

const TAXONOMY = {
  groups: [{ id: 'cat-1', name: 'AI', items: [{ id: 'p-1', name: 'Agentforce' }] }],
};

const SEARCH_RESULT = {
  experts: [],
  total: 214,
  facetCounts: {
    products: [{ id: 'p-1', name: 'Agentforce', count: 67 }],
    supportTypes: [],
    languages: [],
  },
  wasAvailabilityGated: false,
};

/**
 * A fully populated `ExpertCardData` — every field non-null — for the JSON round-trip test
 * below. `satisfies` keeps this pinned to the real interface, so a new required field on
 * `ExpertCardData` fails this file to update, not the mapper mock silently omitting it.
 */
const REAL_EXPERT_CARD_FIXTURE = {
  id: 'expert-1',
  username: 'dana',
  name: 'Dana Okafor',
  initials: 'DO',
  avatarUrl: 'https://cdn.example.com/avatars/dana.png',
  headline: 'Senior Salesforce Architect',
  bio: 'Ten years building on Salesforce, from Sales Cloud to Agentforce.',
  countryCode: 'AU',
  rate: 4.5,
  nextAvailableAt: '2026-09-28T09:00:00.000Z',
  languages: [{ name: 'English', flagEmoji: '🇬🇧' }],
  agency: { name: 'CloudPeak', logoUrl: 'https://cdn.example.com/logos/cloudpeak.png' },
  distinctions: { isSalesforceMvp: true, isSalesforceCta: false, isCertifiedTrainer: true },
  rating: 4.8,
  ratingCount: 42,
  yearsExperience: 10,
  consultationCount: 128,
  expertise: [{ product: 'Agentforce', skills: ['technical', 'architecture'] }],
} satisfies ExpertCardData;

const REAL_BENCH_TILE_FIXTURE = {
  productId: 'p-1',
  product: 'Agentforce',
  label: 'AI Agents',
  icon: 'sparkles',
  tint: 'violet',
  row: 'A',
  href: '/experts?products=p-1',
  displayCount: 60,
  showCount: true,
  ariaLabel: '60+ experts available',
} satisfies ResolvedBenchTile;

const REAL_POPULAR_CHIP_FIXTURE = { id: 'p-1', name: 'Agentforce' } satisfies PopularChip;

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadSearchTaxonomy.mockResolvedValue(TAXONOMY);
  mockSearchExperts.mockResolvedValue(SEARCH_RESULT);
  mockResolveBenchTiles.mockReturnValue([{ productId: 'p-1' }]);
  mockResolvePopularChips.mockReturnValue([{ id: 'p-1', name: 'Agentforce' }]);
  mockFindPublicProfileByUsername.mockResolvedValue(undefined);
  mockGetAvatarUrl.mockReturnValue(null);
  mockMapProfileToView.mockImplementation((row: { avatarKey?: string }) => ({
    avatarKey: row.avatarKey ?? null,
  }));
  mockMapPublicProfileToCardData.mockImplementation(
    (_row: unknown, _view: unknown, username: string) => ({
      id: username,
    })
  );
});

describe('loadHomeData — happy path', () => {
  it('resolves taxonomy, chips, bench tiles, expert total and gate flag from one search fetch', async () => {
    const data = await loadHomeData();

    expect(mockSearchExperts).toHaveBeenCalledTimes(1);
    expect(mockLoadSearchTaxonomy).toHaveBeenCalledTimes(1);
    expect(mockResolvePopularChips).toHaveBeenCalledWith(TAXONOMY);
    expect(mockResolveBenchTiles).toHaveBeenCalledWith(
      TAXONOMY,
      SEARCH_RESULT.facetCounts.products
    );
    expect(data.taxonomy).toBe(TAXONOMY);
    expect(data.expertTotal).toBe(214);
    expect(data.wasAvailabilityGated).toBe(false);
    expect(data.chips).toEqual([{ id: 'p-1', name: 'Agentforce' }]);
    expect(data.benchTiles).toEqual([{ productId: 'p-1' }]);
    expect(data.productNameMap).toEqual({ 'p-1': 'Agentforce' });
  });
});

describe('loadHomeData — search-fetch failure degrades, never throws', () => {
  it('hides the live pill and passes an empty facet list to bench-tile resolution, but still resolves chips/taxonomy', async () => {
    mockSearchExperts.mockRejectedValue(new Error('expert-search request failed with status 502'));

    const data = await loadHomeData();

    expect(data.expertTotal).toBeNull();
    expect(data.wasAvailabilityGated).toBe(false);
    expect(mockResolveBenchTiles).toHaveBeenCalledWith(TAXONOMY, []);
    expect(log.error).toHaveBeenCalledWith(
      'Marketing home search fetch failed',
      expect.objectContaining({ error: expect.stringContaining('502') })
    );
    // The rest of the page still gets a taxonomy and chips.
    expect(data.chips).toEqual([{ id: 'p-1', name: 'Agentforce' }]);
  });
});

describe('loadHomeData — taxonomy-empty degradation', () => {
  it('empties chips and bench tiles and logs once, without calling either resolver (no 25-warning flood)', async () => {
    mockLoadSearchTaxonomy.mockResolvedValue(EMPTY_TAXONOMY);

    const data = await loadHomeData();

    expect(data.chips).toEqual([]);
    expect(data.benchTiles).toEqual([]);
    expect(mockResolvePopularChips).not.toHaveBeenCalled();
    expect(mockResolveBenchTiles).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith('Marketing home taxonomy empty');
  });
});

describe('loadHomeData — spotlight partial resolution', () => {
  it('omits a 404/unsearchable username and logs it, but keeps the others', async () => {
    mockFindPublicProfileByUsername.mockImplementation((username: string) => {
      if (username === 'dana') return Promise.resolve({ id: 'row-dana', competencies: [] });
      return Promise.resolve(undefined);
    });

    const data = await loadHomeData();

    expect(data.spotlight).toEqual([{ id: 'dana' }]);
    expect(log.warn).toHaveBeenCalledWith('Featured expert not publicly visible', {
      username: 'priya',
    });
    expect(log.warn).toHaveBeenCalledWith('Featured expert not publicly visible', {
      username: 'jonas',
    });
  });

  it('omits a username whose lookup rejects, and logs the error rather than throwing', async () => {
    mockFindPublicProfileByUsername.mockImplementation((username: string) => {
      if (username === 'dana') return Promise.reject(new Error('db timeout'));
      if (username === 'priya') return Promise.resolve({ id: 'row-priya', competencies: [] });
      return Promise.resolve(undefined);
    });

    const data = await loadHomeData();

    expect(data.spotlight).toEqual([{ id: 'priya' }]);
    expect(log.error).toHaveBeenCalledWith(
      'Featured expert lookup failed for "dana"',
      expect.objectContaining({ error: 'db timeout' })
    );
  });

  it('resolves all three in declared order when every lookup succeeds', async () => {
    mockFindPublicProfileByUsername.mockImplementation((username: string) =>
      Promise.resolve({ id: `row-${username}`, competencies: [] })
    );

    const data = await loadHomeData();

    expect(data.spotlight).toEqual([{ id: 'dana' }, { id: 'priya' }, { id: 'jonas' }]);
  });

  it('never throws — the page always renders even if every source fails', async () => {
    mockSearchExperts.mockRejectedValue(new Error('down'));
    mockLoadSearchTaxonomy.mockResolvedValue(EMPTY_TAXONOMY);
    mockFindPublicProfileByUsername.mockRejectedValue(new Error('down'));

    await expect(loadHomeData()).resolves.toBeDefined();
  });
});

/**
 * BAL-493 fix round 1 (review MAJOR 3) — the SYNCHRONOUS half of "nothing may throw".
 *
 * `Promise.allSettled` only ever caught the LOOKUP. The mapper block that turns a row into an
 * `ExpertCardData` ran outside any guard, so one bad curated profile threw straight out of
 * `loadSpotlight` and 500'd the marketing front door. Unreachable only while
 * `FEATURED_EXPERT_USERNAMES` ships empty — it goes live the moment someone does the
 * documented thing and adds a username.
 */
describe('loadHomeData — a curated profile that throws during MAPPING', () => {
  it('omits just that card, keeps the others, and logs a warning instead of throwing', async () => {
    mockFindPublicProfileByUsername.mockImplementation((username: string) =>
      Promise.resolve({ id: `row-${username}`, competencies: [] })
    );
    mockMapPublicProfileToCardData.mockImplementation(
      (_row: unknown, _view: unknown, username: string) => {
        if (username === 'priya') throw new TypeError('Cannot read properties of null');
        return { id: username };
      }
    );

    const data = await loadHomeData();

    expect(data.spotlight).toEqual([{ id: 'dana' }, { id: 'jonas' }]);
    expect(log.warn).toHaveBeenCalledWith('Featured expert card mapping failed', {
      username: 'priya',
      error: 'Cannot read properties of null',
    });
  });

  it('still resolves the REST of the page when the view mapper throws for every profile', async () => {
    mockFindPublicProfileByUsername.mockImplementation((username: string) =>
      Promise.resolve({ id: `row-${username}`, competencies: [] })
    );
    mockMapProfileToView.mockImplementation(() => {
      throw new Error('unparseable ratingAverage');
    });

    const data = await loadHomeData();

    expect(data.spotlight).toEqual([]);
    // The page's other data is untouched — the spotlight failing costs the spotlight only.
    expect(data.expertTotal).toBe(214);
    expect(data.chips).toEqual([{ id: 'p-1', name: 'Agentforce' }]);
    expect(data.benchTiles).toEqual([{ productId: 'p-1' }]);
  });
});

/**
 * The OUTER combinator is `allSettled` too (plan §6). Each loader guards itself, so a
 * rejection arriving here is by definition unanticipated — it must degrade to a fallback, not
 * reject the page.
 */
describe('loadHomeData — an unanticipated rejection from a loader', () => {
  it('falls back to the empty taxonomy and logs, rather than rejecting', async () => {
    mockLoadSearchTaxonomy.mockRejectedValue(new Error('taxonomy contract changed'));

    const data = await loadHomeData();

    expect(data.taxonomy).toBe(EMPTY_TAXONOMY);
    expect(data.chips).toEqual([]);
    expect(log.error).toHaveBeenCalledWith(
      'Marketing home taxonomy load threw unexpectedly',
      expect.objectContaining({ error: 'taxonomy contract changed' })
    );
  });
});

/**
 * BAL-504 Phase 1 — the function `unstable_cache` wraps must REJECT (not degrade-and-resolve)
 * on every path that makes `buildHomeData()`'s `degraded` true. A rejection is the only thing
 * `unstable_cache` can't store, so this is what keeps a degraded result out of the cross-request
 * cache (the "degraded never cached" AC).
 */
describe('the strict loader unstable_cache wraps — rejects with DegradedHomeDataError', () => {
  it('rejects when the search fetch fails', async () => {
    mockSearchExperts.mockRejectedValue(new Error('502'));

    await expect(strictLoader()).rejects.toBeInstanceOf(DegradedHomeDataError);
  });

  it('rejects when the taxonomy comes back empty', async () => {
    mockLoadSearchTaxonomy.mockResolvedValue(EMPTY_TAXONOMY);

    await expect(strictLoader()).rejects.toBeInstanceOf(DegradedHomeDataError);
  });

  it('rejects when a spotlight lookup rejects', async () => {
    mockFindPublicProfileByUsername.mockImplementation((username: string) =>
      username === 'dana' ? Promise.reject(new Error('db timeout')) : Promise.resolve(undefined)
    );

    await expect(strictLoader()).rejects.toBeInstanceOf(DegradedHomeDataError);
  });

  it('rejects when the spotlight mapper throws', async () => {
    mockFindPublicProfileByUsername.mockImplementation((username: string) =>
      Promise.resolve({ id: `row-${username}`, competencies: [] })
    );
    mockMapPublicProfileToCardData.mockImplementation(
      (_row: unknown, _view: unknown, username: string) => {
        if (username === 'priya') throw new TypeError('bad row');
        return { id: username };
      }
    );

    await expect(strictLoader()).rejects.toBeInstanceOf(DegradedHomeDataError);
  });

  // Mutation proof: setting `hadFailure` on the null-row branch (instead of only on a rejected
  // lookup or mapper throw) makes this resolve fail — a `null` row is an expected, logged
  // omission, not a degradation.
  it('resolves — not degraded — when one featured profile is null and the rest are healthy', async () => {
    mockFindPublicProfileByUsername.mockImplementation((username: string) =>
      username === 'dana'
        ? Promise.resolve({ id: 'row-dana', competencies: [] })
        : Promise.resolve(undefined)
    );

    await expect(strictLoader()).resolves.toBeDefined();
  });
});

describe('loadHomeDataResult — degraded via the strict loader', () => {
  it('resolves with the degraded data without a second fetch, and warns once', async () => {
    mockSearchExperts.mockRejectedValue(new Error('expert-search request failed with status 502'));

    const result = await loadHomeDataResult();

    expect(result.degraded).toBe(true);
    expect(result.data.expertTotal).toBeNull();
    expect(mockSearchExperts).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      'Marketing home data degraded; serving uncached',
      expect.objectContaining({ error: expect.any(String) })
    );
  });

  it('loadHomeData() unwraps loadHomeDataResult() to just the data', async () => {
    mockSearchExperts.mockRejectedValue(new Error('502'));

    const data = await loadHomeData();

    expect(data.expertTotal).toBeNull();
  });
});

/**
 * Same fallback the `expert-apply` reference-data loader already proves: when the wrapper
 * itself throws (a misconfigured cache handler, or vitest's `incrementalCache missing`),
 * `loadHomeDataResult()` reads live via `buildHomeData()` instead of failing the page.
 */
describe('loadHomeDataResult — unstable_cache wrapper itself throws', () => {
  it('falls back to a live read and warns, returning full data', async () => {
    vi.resetModules();
    vi.doMock('next/cache', () => ({
      unstable_cache: () => () => {
        throw new Error('Invariant: incrementalCache missing in unstable_cache');
      },
    }));

    const { loadHomeDataResult: freshLoadHomeDataResult } = await import('./load-home-data');
    const { log: freshLog } = await import('@/lib/logging');

    const result = await freshLoadHomeDataResult();

    expect(result.degraded).toBe(false);
    expect(result.data.expertTotal).toBe(214);
    expect(freshLog.warn).toHaveBeenCalledWith(
      'unstable_cache unavailable for marketing home data; reading uncached',
      expect.objectContaining({ error: expect.stringContaining('incrementalCache') })
    );

    vi.doUnmock('next/cache');
    vi.resetModules();
  });
});

/**
 * BAL-504 ticket 1.3 — `unstable_cache` persists its resolved value through Next's Data Cache,
 * which round-trips through JSON. A shape that survives `JSON.stringify`/`JSON.parse` unchanged
 * (no `Date`, `Map`, `Set`, `undefined` field, etc.) is what makes that safe.
 *
 * The mapper/resolver mocks return REAL, fully populated `ExpertCardData` / `ResolvedBenchTile` /
 * `PopularChip` fixtures here (not the `{ id: username }` stubs the other suites use), and the
 * assertion is `toStrictEqual`, which — unlike `toEqual` — fails if a key goes missing or turns
 * into `undefined`. A field JSON silently drops (e.g. a future `lastActiveAt: Date`) would pass
 * a stub-based `toEqual` check; it fails this one.
 */
describe('loadHomeData — JSON round trip (ticket 1.3)', () => {
  it('deep-equals its own JSON round trip, with a fully populated MarketingHomeData shape', async () => {
    mockFindPublicProfileByUsername.mockImplementation((username: string) =>
      Promise.resolve({ id: `row-${username}`, competencies: [] })
    );
    mockMapPublicProfileToCardData.mockReturnValue(REAL_EXPERT_CARD_FIXTURE);
    mockResolveBenchTiles.mockReturnValue([REAL_BENCH_TILE_FIXTURE]);
    mockResolvePopularChips.mockReturnValue([REAL_POPULAR_CHIP_FIXTURE]);

    const data = await loadHomeData();

    expect(data.spotlight.length).toBeGreaterThan(0);
    expect(data.spotlight[0]).toStrictEqual(REAL_EXPERT_CARD_FIXTURE);
    expect(data.benchTiles).toStrictEqual([REAL_BENCH_TILE_FIXTURE]);
    expect(data.chips).toStrictEqual([REAL_POPULAR_CHIP_FIXTURE]);
    expect(JSON.parse(JSON.stringify(data))).toStrictEqual(data);
  });
});

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
} = vi.hoisted(() => ({
  mockFindPublicProfileByUsername: vi.fn(),
  mockMapProfileToView: vi.fn(),
  mockLoadSearchTaxonomy: vi.fn(),
  mockSearchExperts: vi.fn(),
  mockGetAvatarUrl: vi.fn(),
  mockResolveBenchTiles: vi.fn(),
  mockResolvePopularChips: vi.fn(),
  mockMapPublicProfileToCardData: vi.fn(),
}));

vi.mock('server-only', () => ({}));

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
import { loadHomeData } from './load-home-data';

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

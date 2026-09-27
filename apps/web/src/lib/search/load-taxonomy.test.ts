import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGetVertical, mockGetProducts } = vi.hoisted(() => ({
  mockGetVertical: vi.fn(),
  mockGetProducts: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  referenceDataRepository: {
    getSalesforceVertical: mockGetVertical,
    getProductsByVertical: mockGetProducts,
  },
}));

// `unstable_cache` needs Next's Data Cache runtime, unavailable in a plain vitest
// process. Pass through so the wrapped function still runs and is still testable —
// same pattern as `lib/expert-apply/reference-data.test.ts`.
vi.mock('next/cache', () => ({
  unstable_cache: <T>(fn: T): T => fn,
}));

import { log } from '@/lib/logging';
import { loadSearchTaxonomy, loadSearchTaxonomyCached } from './load-taxonomy';
import { EMPTY_TAXONOMY } from './taxonomy';

const POPULATED_CATEGORIES = [
  {
    category: { id: 'c1', name: 'AI', slug: 'ai', sortOrder: 0 },
    products: [{ id: 's1', name: 'Agentforce', slug: 'agentforce', sortOrder: 0 }],
  },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('loadSearchTaxonomy', () => {
  it('maps the vertical skills to a ProductTaxonomy', async () => {
    mockGetVertical.mockResolvedValue({ id: 'vert-sf', slug: 'salesforce' });
    mockGetProducts.mockResolvedValue([
      {
        category: { id: 'c1', name: 'AI', slug: 'ai', sortOrder: 0 },
        products: [{ id: 's1', name: 'Agentforce', slug: 'agentforce', sortOrder: 0 }],
      },
    ]);

    const taxonomy = await loadSearchTaxonomy();
    expect(mockGetProducts).toHaveBeenCalledWith('vert-sf');
    expect(taxonomy).toEqual({
      groups: [{ id: 'c1', name: 'AI', items: [{ id: 's1', name: 'Agentforce' }] }],
    });
  });

  it('returns an empty taxonomy and logs on failure (no throw)', async () => {
    mockGetVertical.mockRejectedValue(new Error('db down'));

    const taxonomy = await loadSearchTaxonomy();
    expect(taxonomy).toEqual(EMPTY_TAXONOMY);
    expect(log.error).toHaveBeenCalledWith(
      'Search taxonomy load failed',
      expect.objectContaining({ error: 'db down' })
    );
  });
});

describe('loadSearchTaxonomyCached', () => {
  it('resolves with the mapped taxonomy when populated', async () => {
    mockGetVertical.mockResolvedValue({ id: 'vert-sf', slug: 'salesforce' });
    mockGetProducts.mockResolvedValue(POPULATED_CATEGORIES);

    const taxonomy = await loadSearchTaxonomyCached();
    expect(taxonomy).toEqual({
      groups: [{ id: 'c1', name: 'AI', items: [{ id: 's1', name: 'Agentforce' }] }],
    });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('falls back to the uncached loader and logs a warning on a repository failure', async () => {
    mockGetVertical.mockRejectedValue(new Error('db down'));

    const taxonomy = await loadSearchTaxonomyCached();
    expect(taxonomy).toEqual(EMPTY_TAXONOMY);
    expect(log.warn).toHaveBeenCalledWith(
      'Search taxonomy cache unavailable; falling back to uncached read',
      expect.objectContaining({ error: 'db down' })
    );
  });

  it('falls back to the uncached loader and logs a warning on an empty result', async () => {
    mockGetVertical.mockResolvedValue({ id: 'vert-sf', slug: 'salesforce' });
    mockGetProducts.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    const taxonomy = await loadSearchTaxonomyCached();
    expect(taxonomy).toEqual(EMPTY_TAXONOMY);
    expect(log.warn).toHaveBeenCalledWith(
      'Search taxonomy cache unavailable; falling back to uncached read',
      expect.objectContaining({ error: 'Search taxonomy empty' })
    );
  });
});

// `unstable_cache` needs Next's request-scoped incremental-cache handler, absent in a
// plain vitest process (and, rarely, in a misconfigured production cache handler).
// This suite proves the fallback: reset the module registry and remock `next/cache` so
// `unstable_cache` throws the exact invariant Next throws, then assert
// `loadSearchTaxonomyCached` still resolves (from the uncached read) and logs a warning
// rather than throwing.
describe('loadSearchTaxonomyCached — unstable_cache unavailable', () => {
  it('falls back to the uncached read when unstable_cache throws', async () => {
    vi.resetModules();
    vi.doMock('next/cache', () => ({
      unstable_cache: () => () => {
        throw new Error('Invariant: incrementalCache missing in unstable_cache');
      },
    }));

    const { loadSearchTaxonomyCached: freshLoadSearchTaxonomyCached } =
      await import('./load-taxonomy');
    const { log: freshLog } = await import('@/lib/logging');
    mockGetVertical.mockResolvedValue({ id: 'vert-sf', slug: 'salesforce' });
    mockGetProducts.mockResolvedValue(POPULATED_CATEGORIES);

    const taxonomy = await freshLoadSearchTaxonomyCached();

    expect(taxonomy).toEqual({
      groups: [{ id: 'c1', name: 'AI', items: [{ id: 's1', name: 'Agentforce' }] }],
    });
    expect(freshLog.warn).toHaveBeenCalledWith(
      'Search taxonomy cache unavailable; falling back to uncached read',
      expect.objectContaining({ error: expect.stringContaining('incrementalCache') })
    );

    vi.doUnmock('next/cache');
    vi.resetModules();
  });
});

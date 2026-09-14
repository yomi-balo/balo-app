import { describe, it, expect, vi, beforeEach } from 'vitest';
import { log } from '@/lib/logging';

vi.mock('server-only', () => ({}));

const { mockGetVertical, mockGetTags, mockGetProducts } = vi.hoisted(() => ({
  mockGetVertical: vi.fn(),
  mockGetTags: vi.fn(),
  mockGetProducts: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  referenceDataRepository: {
    getSalesforceVertical: mockGetVertical,
    getProjectTagsByVertical: mockGetTags,
    getProductsByVertical: mockGetProducts,
  },
}));

import { loadProjectRequestTaxonomies } from './load-project-taxonomy';

describe('loadProjectRequestTaxonomies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetVertical.mockResolvedValue({ id: 'vert-sf', slug: 'salesforce' });
  });

  it('maps tags and products to the shared taxonomy shape', async () => {
    mockGetTags.mockResolvedValue([
      {
        group: { id: 'grp-1', name: 'Foundational', slug: 'foundational', sortOrder: 0 },
        tags: [{ id: 'tag-1', name: 'New Implementation', slug: 'new', sortOrder: 0 }],
      },
    ]);
    mockGetProducts.mockResolvedValue([
      {
        category: { id: 'cat-1', name: 'AI', slug: 'ai', sortOrder: 0 },
        products: [{ id: 'prod-1', name: 'Agentforce', slug: 'agentforce', sortOrder: 0 }],
      },
    ]);

    const result = await loadProjectRequestTaxonomies();

    expect(result.tags.groups).toEqual([
      { id: 'grp-1', name: 'Foundational', items: [{ id: 'tag-1', name: 'New Implementation' }] },
    ]);
    expect(result.products.groups).toEqual([
      { id: 'cat-1', name: 'AI', items: [{ id: 'prod-1', name: 'Agentforce' }] },
    ]);
  });

  it('fetches tags and products in parallel after resolving the vertical', async () => {
    mockGetTags.mockResolvedValue([]);
    mockGetProducts.mockResolvedValue([]);
    await loadProjectRequestTaxonomies();
    expect(mockGetVertical).toHaveBeenCalledOnce();
    expect(mockGetTags).toHaveBeenCalledWith('vert-sf');
    expect(mockGetProducts).toHaveBeenCalledWith('vert-sf');
  });

  it('returns EMPTY for both and logs when the vertical lookup throws', async () => {
    mockGetVertical.mockRejectedValue(new Error('no vertical'));
    const result = await loadProjectRequestTaxonomies();
    expect(result).toEqual({ tags: { groups: [] }, products: { groups: [] }, loadFailed: true });
    expect(log.error).toHaveBeenCalledWith(
      'Project taxonomy load failed',
      expect.objectContaining({ error: 'no vertical' })
    );
  });

  it('returns EMPTY for both when a taxonomy read throws', async () => {
    mockGetTags.mockRejectedValue(new Error('tag read failed'));
    mockGetProducts.mockResolvedValue([]);
    const result = await loadProjectRequestTaxonomies();
    expect(result).toEqual({ tags: { groups: [] }, products: { groups: [] }, loadFailed: true });
    expect(log.error).toHaveBeenCalled();
  });

  /**
   * ⚠⚠ BAL-254 fix round F17 — `loadFailed` IS THE ONLY THING SEPARATING "the taxonomy is
   * genuinely empty" FROM "the read blew up", and this loader swallows the difference by design
   * (the picker wants to degrade, not throw). `getProjectBriefParseAction` filters the model's
   * chosen tag/product ids against these ids, so an unflagged failure would have silently
   * stripped every tag off an AI brief with nothing anywhere saying so.
   *
   * The field is OPTIONAL on the interface (RSC callers and fixtures write the shape as a
   * literal), so nothing in the type system forces the loader to set it — which is exactly why
   * both branches are pinned here.
   */
  describe('loadFailed distinguishes a failed read from a genuinely empty one (F17)', () => {
    it('is false on a successful load, even when BOTH taxonomies come back empty', async () => {
      mockGetTags.mockResolvedValue([]);
      mockGetProducts.mockResolvedValue([]);
      const result = await loadProjectRequestTaxonomies();
      expect(result.tags.groups).toEqual([]);
      expect(result.products.groups).toEqual([]);
      expect(result.loadFailed).toBe(false);
    });

    it('is true when the read throws', async () => {
      mockGetProducts.mockRejectedValue(new Error('product read failed'));
      mockGetTags.mockResolvedValue([]);
      const result = await loadProjectRequestTaxonomies();
      expect(result.loadFailed).toBe(true);
    });
  });
});

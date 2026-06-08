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
    expect(result).toEqual({ tags: { groups: [] }, products: { groups: [] } });
    expect(log.error).toHaveBeenCalledWith(
      'Project taxonomy load failed',
      expect.objectContaining({ error: 'no vertical' })
    );
  });

  it('returns EMPTY for both when a taxonomy read throws', async () => {
    mockGetTags.mockRejectedValue(new Error('tag read failed'));
    mockGetProducts.mockResolvedValue([]);
    const result = await loadProjectRequestTaxonomies();
    expect(result).toEqual({ tags: { groups: [] }, products: { groups: [] } });
    expect(log.error).toHaveBeenCalled();
  });
});

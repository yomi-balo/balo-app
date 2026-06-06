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

import { log } from '@/lib/logging';
import { loadSearchTaxonomy } from './load-taxonomy';
import { EMPTY_TAXONOMY } from './taxonomy';

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

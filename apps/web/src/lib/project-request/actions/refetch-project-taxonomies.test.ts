import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const mockLoad = vi.fn();
vi.mock('@/lib/project-request/load-project-taxonomy', () => ({
  loadProjectRequestTaxonomies: (...args: unknown[]) => mockLoad(...args),
}));

import { refetchProjectTaxonomiesAction } from './refetch-project-taxonomies';

describe('refetchProjectTaxonomiesAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delegates to loadProjectRequestTaxonomies and returns its result', async () => {
    const taxonomies = {
      tags: { groups: [{ id: 'g', name: 'G', items: [] }] },
      products: { groups: [] },
    };
    mockLoad.mockResolvedValue(taxonomies);
    const result = await refetchProjectTaxonomiesAction();
    expect(result).toBe(taxonomies);
    expect(mockLoad).toHaveBeenCalledOnce();
  });
});

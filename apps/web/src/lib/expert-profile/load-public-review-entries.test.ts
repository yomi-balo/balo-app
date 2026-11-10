import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PublicReviewEntry } from '@balo/shared/reviews';
import { log } from '@/lib/logging';

const { mockList } = vi.hoisted(() => ({ mockList: vi.fn() }));

vi.mock('@balo/db', () => ({
  reviewsRepository: { listPublicEntriesByExpert: mockList },
}));

import { loadPublicReviewEntries } from './load-public-review-entries';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('loadPublicReviewEntries', () => {
  it('passes the repository entries through', async () => {
    const entries = [{ key: 'r1' }] as unknown as PublicReviewEntry[];
    mockList.mockResolvedValue(entries);

    await expect(loadPublicReviewEntries('expert-1')).resolves.toBe(entries);
    expect(mockList).toHaveBeenCalledWith('expert-1');
  });

  it('returns null and logs when the read throws', async () => {
    mockList.mockRejectedValue(new Error('db down'));

    await expect(loadPublicReviewEntries('expert-1')).resolves.toBeNull();
    expect(log.error).toHaveBeenCalledWith(
      'Public review entries fetch failed',
      expect.objectContaining({ expertProfileId: 'expert-1', error: 'db down' })
    );
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

const ENGAGEMENT_ID = 'a0000000-0000-4000-8000-000000000001';
const VIEWER_ID = 'b0000000-0000-4000-8000-000000000002';
const EXPERT_PROFILE_ID = 'd0000000-0000-4000-8000-000000000004';

vi.mock('server-only', () => ({}));

const { mockFindEngagement, mockFindLive } = vi.hoisted(() => ({
  mockFindEngagement: vi.fn(),
  mockFindLive: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  engagementsRepository: { findById: (...a: unknown[]) => mockFindEngagement(...a) },
  reviewsRepository: { findLive: (...a: unknown[]) => mockFindLive(...a) },
}));

import { readEngagementReview } from './read-engagement-review';

const CREATED_AT = new Date('2026-07-12T09:30:00Z');
const EDITED_AT = new Date('2026-07-20T18:00:00Z');

beforeEach(() => {
  vi.clearAllMocks();
  mockFindEngagement.mockResolvedValue({
    id: ENGAGEMENT_ID,
    expertProfileId: EXPERT_PROFILE_ID,
  });
});

describe('readEngagementReview', () => {
  it('resolves the expert from the engagement, never from the caller', async () => {
    mockFindLive.mockResolvedValue(undefined);
    await readEngagementReview(ENGAGEMENT_ID, VIEWER_ID);

    expect(mockFindLive).toHaveBeenCalledWith(ENGAGEMENT_ID, VIEWER_ID, EXPERT_PROFILE_ID);
  });

  it('returns the "none" state when the viewer has not rated yet', async () => {
    mockFindLive.mockResolvedValue(undefined);

    const result = await readEngagementReview(ENGAGEMENT_ID, VIEWER_ID);

    expect(result).toEqual({ review: null, state: { kind: 'none' } });
  });

  it('resolves a 4 as rated_ok and projects only rating/body/date', async () => {
    mockFindLive.mockResolvedValue({
      id: 'review-1',
      rating: 4,
      body: 'Steady and clear',
      createdAt: CREATED_AT,
      lastEditedAt: null,
      reviewerUserId: VIEWER_ID,
      expertProfileId: EXPERT_PROFILE_ID,
    });

    const result = await readEngagementReview(ENGAGEMENT_ID, VIEWER_ID);

    expect(result).toEqual({
      review: { rating: 4, body: 'Steady and clear', ratedOnIso: CREATED_AT.toISOString() },
      state: { kind: 'rated_ok', rating: 4 },
    });
    // The projection is an allow-list: no reviewer id, no expert id, no row internals.
    expect(Object.keys(result?.review ?? {}).sort()).toEqual(['body', 'ratedOnIso', 'rating']);
  });

  it('resolves a 3 as rated_low — the warm re-ask branch', async () => {
    mockFindLive.mockResolvedValue({
      rating: 3,
      body: null,
      createdAt: CREATED_AT,
      lastEditedAt: null,
    });

    const result = await readEngagementReview(ENGAGEMENT_ID, VIEWER_ID);

    expect(result?.state).toEqual({ kind: 'rated_low', rating: 3 });
  });

  it('prefers last_edited_at over created_at for the "you rated on" date', async () => {
    mockFindLive.mockResolvedValue({
      rating: 5,
      body: null,
      createdAt: CREATED_AT,
      lastEditedAt: EDITED_AT,
    });

    const result = await readEngagementReview(ENGAGEMENT_ID, VIEWER_ID);

    expect(result?.review?.ratedOnIso).toBe(EDITED_AT.toISOString());
  });

  it('returns undefined for a missing or soft-deleted engagement', async () => {
    mockFindEngagement.mockResolvedValue(undefined);

    const result = await readEngagementReview(ENGAGEMENT_ID, VIEWER_ID);

    expect(result).toBeUndefined();
    expect(mockFindLive).not.toHaveBeenCalled();
  });

  it('treats an out-of-range stored rating as "no review" rather than rendering it', async () => {
    mockFindLive.mockResolvedValue({
      rating: 9,
      body: 'impossible under review_rating_range',
      createdAt: CREATED_AT,
      lastEditedAt: null,
    });

    const result = await readEngagementReview(ENGAGEMENT_ID, VIEWER_ID);

    expect(result).toEqual({ review: null, state: { kind: 'none' } });
  });
});

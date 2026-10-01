import { describe, it, expect, vi, beforeEach } from 'vitest';

const ENGAGEMENT_ID = 'a0000000-0000-4000-8000-000000000001';
const VIEWER_ID = 'b0000000-0000-4000-8000-000000000002';
const NOW = new Date('2026-08-01T00:00:00Z');

vi.mock('server-only', () => ({}));

const { mockReadEngagementReview, mockConsultationTimestamps, mockLogError } = vi.hoisted(() => ({
  mockReadEngagementReview: vi.fn(),
  mockConsultationTimestamps: vi.fn(),
  mockLogError: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  meetingContextsRepository: {
    consultationTimestampsForEngagements: (...a: unknown[]) => mockConsultationTimestamps(...a),
  },
}));

vi.mock('./read-engagement-review', () => ({
  readEngagementReview: (...a: unknown[]) => mockReadEngagementReview(...a),
}));

vi.mock('@/lib/logging', () => ({
  log: { error: (...a: unknown[]) => mockLogError(...a), warn: vi.fn(), info: vi.fn() },
}));

import { readRatingCard } from './read-rating-card';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('readRatingCard', () => {
  it('passes through the "none" state untouched, not requiring a held consultation', async () => {
    mockReadEngagementReview.mockResolvedValue({ review: null, state: { kind: 'none' } });

    const result = await readRatingCard({
      engagementId: ENGAGEMENT_ID,
      viewerUserId: VIEWER_ID,
      requireHeldConsultation: false,
      now: NOW,
    });

    expect(result).toEqual({
      engagementId: ENGAGEMENT_ID,
      state: { kind: 'none' },
      existingBody: null,
    });
    expect(mockConsultationTimestamps).not.toHaveBeenCalled();
  });

  it('passes through rated_ok with the existing body', async () => {
    mockReadEngagementReview.mockResolvedValue({
      review: { rating: 5, body: 'Great work', ratedOnIso: NOW.toISOString() },
      state: { kind: 'rated_ok', rating: 5 },
    });

    const result = await readRatingCard({
      engagementId: ENGAGEMENT_ID,
      viewerUserId: VIEWER_ID,
      requireHeldConsultation: false,
      now: NOW,
    });

    expect(result).toEqual({
      engagementId: ENGAGEMENT_ID,
      state: { kind: 'rated_ok', rating: 5 },
      existingBody: 'Great work',
    });
  });

  it('passes through rated_low', async () => {
    mockReadEngagementReview.mockResolvedValue({
      review: { rating: 2, body: null, ratedOnIso: NOW.toISOString() },
      state: { kind: 'rated_low', rating: 2 },
    });

    const result = await readRatingCard({
      engagementId: ENGAGEMENT_ID,
      viewerUserId: VIEWER_ID,
      requireHeldConsultation: false,
      now: NOW,
    });

    expect(result?.state).toEqual({ kind: 'rated_low', rating: 2 });
  });

  it('returns null for a missing engagement', async () => {
    mockReadEngagementReview.mockResolvedValue(undefined);

    const result = await readRatingCard({
      engagementId: ENGAGEMENT_ID,
      viewerUserId: VIEWER_ID,
      requireHeldConsultation: false,
      now: NOW,
    });

    expect(result).toBeNull();
  });

  it('required + lastCompletedConsultationAt null returns null', async () => {
    mockReadEngagementReview.mockResolvedValue({ review: null, state: { kind: 'none' } });
    mockConsultationTimestamps.mockResolvedValue(
      new Map([
        [
          ENGAGEMENT_ID,
          {
            lastCompletedConsultationAt: null,
            nextScheduledConsultationAt: null,
            lastSchedulingActivityAt: null,
          },
        ],
      ])
    );

    const result = await readRatingCard({
      engagementId: ENGAGEMENT_ID,
      viewerUserId: VIEWER_ID,
      requireHeldConsultation: true,
      now: NOW,
    });

    expect(result).toBeNull();
  });

  it('required + missing from the map returns null', async () => {
    mockReadEngagementReview.mockResolvedValue({ review: null, state: { kind: 'none' } });
    mockConsultationTimestamps.mockResolvedValue(new Map());

    const result = await readRatingCard({
      engagementId: ENGAGEMENT_ID,
      viewerUserId: VIEWER_ID,
      requireHeldConsultation: true,
      now: NOW,
    });

    expect(result).toBeNull();
  });

  it('required + a Date returns the view', async () => {
    mockReadEngagementReview.mockResolvedValue({ review: null, state: { kind: 'none' } });
    mockConsultationTimestamps.mockResolvedValue(
      new Map([
        [
          ENGAGEMENT_ID,
          {
            lastCompletedConsultationAt: NOW,
            nextScheduledConsultationAt: null,
            lastSchedulingActivityAt: null,
          },
        ],
      ])
    );

    const result = await readRatingCard({
      engagementId: ENGAGEMENT_ID,
      viewerUserId: VIEWER_ID,
      requireHeldConsultation: true,
      now: NOW,
    });

    expect(result).toEqual({
      engagementId: ENGAGEMENT_ID,
      state: { kind: 'none' },
      existingBody: null,
    });
  });

  it('not required never calls the consultation-timestamps repository', async () => {
    mockReadEngagementReview.mockResolvedValue({ review: null, state: { kind: 'none' } });

    await readRatingCard({
      engagementId: ENGAGEMENT_ID,
      viewerUserId: VIEWER_ID,
      requireHeldConsultation: false,
      now: NOW,
    });

    expect(mockConsultationTimestamps).not.toHaveBeenCalled();
  });

  it('a thrown error returns null and logs', async () => {
    mockReadEngagementReview.mockRejectedValue(new Error('db exploded'));

    const result = await readRatingCard({
      engagementId: ENGAGEMENT_ID,
      viewerUserId: VIEWER_ID,
      requireHeldConsultation: false,
      now: NOW,
    });

    expect(result).toBeNull();
    expect(mockLogError).toHaveBeenCalledWith(
      'Rating card read failed',
      expect.objectContaining({ engagementId: ENGAGEMENT_ID, error: 'db exploded' })
    );
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

const ENGAGEMENT_ID = 'a0000000-0000-4000-8000-000000000001';
const VIEWER_ID = 'b0000000-0000-4000-8000-000000000002';
const COMPANY_ID = 'c0000000-0000-4000-8000-000000000003';
const EXPERT_PROFILE_ID = 'd0000000-0000-4000-8000-000000000004';

vi.mock('server-only', () => ({}));

const mockRequireOnboarded = vi.fn();
vi.mock('@/lib/auth/session', () => ({ requireOnboardedUser: () => mockRequireOnboarded() }));

const mockHasCapability = vi.fn();
vi.mock('@/lib/authz', () => ({
  hasCapability: (...a: unknown[]) => mockHasCapability(...a),
  CAPABILITIES: { PARTICIPATE: 'participate' },
}));

/**
 * ⚠ MOCKED, NOT LEFT REAL — AND THAT IS ABOUT DETERMINISM, NOT CONVENIENCE.
 * `checkMemoryLimit` keeps its buckets in a MODULE-LEVEL `Map`, so a real one would be
 * shared by every case in this file: the cases below submit the same
 * (reviewer, engagement) pair well over ten times, and somewhere past the tenth the
 * limiter would start denying and the failures would land on whichever case happened to
 * run eleventh. Mocking makes the limit an explicit input, so the two cases that care
 * assert it and the rest are unaffected by their own position in the file.
 */
const mockCheckLimit = vi.fn();
vi.mock('@/lib/rate-limit/memory-window', () => ({
  checkMemoryLimit: (...a: unknown[]) => mockCheckLimit(...a),
}));

const { mockFindEngagement, mockUpsert } = vi.hoisted(() => ({
  mockFindEngagement: vi.fn(),
  mockUpsert: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  engagementsRepository: { findById: (...a: unknown[]) => mockFindEngagement(...a) },
  reviewsRepository: { upsert: (...a: unknown[]) => mockUpsert(...a) },
}));

const mockTrack = vi.fn();
vi.mock('@/lib/analytics/server', async () => {
  const events = await import('@balo/analytics/events');
  return {
    trackServerAndFlush: (...a: unknown[]) => mockTrack(...a),
    REVIEW_SERVER_EVENTS: events.REVIEW_SERVER_EVENTS,
  };
});

import { log } from '@/lib/logging';
import {
  REVIEW_ENGAGEMENT_NOT_FOUND,
  REVIEW_GENERIC_FAILURE,
  REVIEW_INVALID_REQUEST,
  REVIEW_NOT_SIGNED_IN,
} from '@/lib/reviews/messages';
import { submitEngagementReviewAction } from './submit-engagement-review';

function primeHappyPath(): void {
  mockRequireOnboarded.mockResolvedValue({ id: VIEWER_ID });
  mockFindEngagement.mockResolvedValue({
    id: ENGAGEMENT_ID,
    engagementType: 'case',
    companyId: COMPANY_ID,
    expertProfileId: EXPERT_PROFILE_ID,
  });
  mockHasCapability.mockResolvedValue(true);
  mockUpsert.mockResolvedValue({ review: { id: 'review-1' }, created: true, ratingCount: 3 });
  mockCheckLimit.mockReturnValue(true);
}

describe('submitEngagementReviewAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Allowed unless a case says otherwise — `clearAllMocks` resets the return value to
    // `undefined`, which is falsy and would silently throttle every case.
    mockCheckLimit.mockReturnValue(true);
  });

  it('writes with authMethod=session and the caller-chosen surface', async () => {
    primeHappyPath();

    const result = await submitEngagementReviewAction({
      engagementId: ENGAGEMENT_ID,
      rating: 5,
      body: 'Unblocked us in one call',
      surface: 'end_of_call',
    });

    expect(result).toEqual({ success: true, created: true });
    expect(mockUpsert).toHaveBeenCalledWith({
      engagementId: ENGAGEMENT_ID,
      reviewerUserId: VIEWER_ID,
      expertProfileId: EXPERT_PROFILE_ID,
      rating: 5,
      body: 'Unblocked us in one call',
      surface: 'end_of_call',
      authMethod: 'session',
    });
  });

  it('parameterises the surface — the recap seam reuses it unchanged', async () => {
    primeHappyPath();
    await submitEngagementReviewAction({
      engagementId: ENGAGEMENT_ID,
      rating: 4,
      surface: 'recap',
    });

    expect(mockUpsert).toHaveBeenCalledWith(expect.objectContaining({ surface: 'recap' }));
    expect(mockTrack).toHaveBeenCalledWith(
      'review_submitted',
      expect.objectContaining({ surface: 'recap', auth_method: 'session' })
    );
  });

  it("refuses surface 'email' — that path authenticates by token, not by session", async () => {
    primeHappyPath();

    const result = await submitEngagementReviewAction({
      engagementId: ENGAGEMENT_ID,
      rating: 4,
      surface: 'email',
    } as unknown as { engagementId: string; rating: number; surface: 'recap' });

    expect(result).toEqual({ success: false, error: REVIEW_INVALID_REQUEST });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  /**
   * ⚠ DRIFT TELEMETRY (BAL-422). The "Review submitted" line carries the `rating_count` the
   * in-transaction recompute actually COMMITTED, so an operator can compare the stored
   * aggregate against the review rows from the log alone. It comes back OUT of the write —
   * not from a re-read a layer out — so the logged number cannot disagree with the row.
   *
   * ⚠ NEITHER THE BODY NOR THE RATING IS LOGGED, and this pins that too.
   */
  it('logs the committed ratingCount, and never the review body', async () => {
    primeHappyPath();
    mockUpsert.mockResolvedValue({ review: { id: 'review-1' }, created: true, ratingCount: 7 });

    await submitEngagementReviewAction({
      engagementId: ENGAGEMENT_ID,
      rating: 5,
      body: 'Unblocked us in one call',
      surface: 'end_of_call',
    });

    expect(log.info).toHaveBeenCalledWith(
      'Review submitted',
      expect.objectContaining({ ratingCount: 7, created: true })
    );
    const payload = vi.mocked(log.info).mock.calls.at(-1)?.[1];
    expect(JSON.stringify(payload)).not.toContain('Unblocked us in one call');
  });

  /**
   * ⚠⚠ THE MOUNTED, AUTHENTICATED PATH IS RATE LIMITED (BAL-422 fix round). It shipped with
   * NONE while the magic-link sibling had two, and "authenticated" is not a defence here: a
   * review is REVISABLE INDEFINITELY, so every repeat call from the same user on the same
   * engagement is a LEGITIMATE write that nothing else caps. Each one takes a row lock on
   * `expert_profiles` inside the write transaction, which turns an unbounded revise loop
   * into a targeted latency attack on ONE expert's writes.
   */
  it('rate limits per (reviewer, engagement), not per IP', async () => {
    primeHappyPath();
    await submitEngagementReviewAction({
      engagementId: ENGAGEMENT_ID,
      rating: 5,
      surface: 'end_of_call',
    });

    expect(mockCheckLimit).toHaveBeenCalledWith(
      `review-submit-engagement:${VIEWER_ID}:${ENGAGEMENT_ID}`,
      { max: 10, windowMs: 600_000 }
    );
  });

  /** ⚠ AND IT DENIES BEFORE THE DATABASE IS TOUCHED — no query, and no lock taken. */
  it('refuses a throttled submit without reaching the repository, with the generic copy', async () => {
    primeHappyPath();
    mockCheckLimit.mockReturnValue(false);

    const result = await submitEngagementReviewAction({
      engagementId: ENGAGEMENT_ID,
      rating: 5,
      surface: 'end_of_call',
    });

    // Generic, NOT a distinguishable "slow down" — a rate-limit reply is a signal worth
    // not handing out, and the same copy already covers a genuine write fault.
    expect(result).toEqual({ success: false, error: REVIEW_GENERIC_FAILURE });
    expect(mockFindEngagement).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('gates on the onboarded session before anything else', async () => {
    mockRequireOnboarded.mockRejectedValue(new Error('Onboarding not completed'));

    const result = await submitEngagementReviewAction({
      engagementId: ENGAGEMENT_ID,
      rating: 5,
      surface: 'end_of_call',
    });

    expect(result).toEqual({ success: false, error: REVIEW_NOT_SIGNED_IN });
    expect(mockFindEngagement).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('evaluates PARTICIPATE for the SIGNED-IN user against the engagement company', async () => {
    primeHappyPath();
    await submitEngagementReviewAction({
      engagementId: ENGAGEMENT_ID,
      rating: 3,
      surface: 'end_of_call',
    });

    expect(mockHasCapability).toHaveBeenCalledWith({ id: VIEWER_ID }, 'participate', {
      companyId: COMPANY_ID,
    });
  });

  it('collapses a denied capability to the not-found copy — never an existence oracle', async () => {
    primeHappyPath();
    mockHasCapability.mockResolvedValue(false);

    const denied = await submitEngagementReviewAction({
      engagementId: ENGAGEMENT_ID,
      rating: 5,
      surface: 'end_of_call',
    });

    mockFindEngagement.mockResolvedValue(undefined);
    const missing = await submitEngagementReviewAction({
      engagementId: ENGAGEMENT_ID,
      rating: 5,
      surface: 'end_of_call',
    });

    expect(denied).toEqual({ success: false, error: REVIEW_ENGAGEMENT_NOT_FOUND });
    expect(denied).toEqual(missing);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('surfaces a repository fault as the generic failure, distinct from not-found', async () => {
    primeHappyPath();
    mockUpsert.mockRejectedValue(new Error('deadlock detected'));

    const result = await submitEngagementReviewAction({
      engagementId: ENGAGEMENT_ID,
      rating: 5,
      surface: 'end_of_call',
    });

    expect(result).toEqual({ success: false, error: REVIEW_GENERIC_FAILURE });
  });

  it('rejects a malformed engagement id without reading the database', async () => {
    primeHappyPath();

    const result = await submitEngagementReviewAction({
      engagementId: 'not-a-uuid',
      rating: 5,
      surface: 'end_of_call',
    });

    expect(result).toEqual({ success: false, error: REVIEW_INVALID_REQUEST });
    expect(mockFindEngagement).not.toHaveBeenCalled();
  });
});

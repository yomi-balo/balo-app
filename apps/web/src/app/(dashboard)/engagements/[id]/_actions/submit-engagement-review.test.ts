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

import {
  submitEngagementReviewAction,
  REVIEW_ENGAGEMENT_NOT_FOUND,
  REVIEW_GENERIC_FAILURE,
  REVIEW_INVALID_REQUEST,
  REVIEW_NOT_SIGNED_IN,
} from './submit-engagement-review';

function primeHappyPath(): void {
  mockRequireOnboarded.mockResolvedValue({ id: VIEWER_ID });
  mockFindEngagement.mockResolvedValue({
    id: ENGAGEMENT_ID,
    engagementType: 'case',
    companyId: COMPANY_ID,
    expertProfileId: EXPERT_PROFILE_ID,
  });
  mockHasCapability.mockResolvedValue(true);
  mockUpsert.mockResolvedValue({ review: { id: 'review-1' }, created: true });
}

describe('submitEngagementReviewAction', () => {
  beforeEach(() => vi.clearAllMocks());

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

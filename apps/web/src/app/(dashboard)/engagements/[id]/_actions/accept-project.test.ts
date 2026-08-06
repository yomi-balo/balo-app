import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import type { ProjectEngagementWithMilestones } from '@balo/db';

const ENGAGEMENT_ID = 'a0000000-0000-4000-8000-000000000001';
const COMPANY_ID = 'c0000000-0000-4000-8000-000000000003';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const mockRequireUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({ requireOnboardedUser: () => mockRequireUser() }));

const mockResolveLens = vi.fn();
vi.mock('@/lib/engagement/resolve-engagement-lens', () => ({
  resolveEngagementLens: (...a: unknown[]) => mockResolveLens(...a),
}));

const mockHasCapability = vi.fn();
vi.mock('@/lib/authz', () => ({
  hasCapability: (...a: unknown[]) => mockHasCapability(...a),
  CAPABILITIES: { PARTICIPATE: 'participate' },
}));

const {
  mockFindEngagement,
  mockAccept,
  mockCountAudit,
  mockFindLiveReview,
  mockCreateReviewToken,
  InvalidEngagementTransitionError,
} = vi.hoisted(() => {
  class InvalidEngagementTransitionError extends Error {}
  return {
    mockFindEngagement: vi.fn(),
    mockAccept: vi.fn(),
    mockCountAudit: vi.fn(),
    mockFindLiveReview: vi.fn(),
    mockCreateReviewToken: vi.fn(),
    InvalidEngagementTransitionError,
  };
});

vi.mock('@balo/db', () => ({
  projectEngagementsRepository: {
    findWithMilestones: (...a: unknown[]) => mockFindEngagement(...a),
    acceptCompletion: (...a: unknown[]) => mockAccept(...a),
  },
  auditEventsRepository: { countByEntityAndAction: (...a: unknown[]) => mockCountAudit(...a) },
  companiesRepository: { findOwnerByCompanyId: vi.fn() },
  // BAL-390: the accepting member now gets their own record of the acceptance with the
  // star-rating ask fused in, so the action mints them a magic-link token when unrated.
  reviewsRepository: { findLive: (...a: unknown[]) => mockFindLiveReview(...a) },
  reviewInviteTokensRepository: { create: (...a: unknown[]) => mockCreateReviewToken(...a) },
  AUTO_ACCEPT_DAYS: 7,
  MilestonesIncompleteError: class extends Error {},
  InvalidEngagementTransitionError,
}));

const mockTrack = vi.fn();
vi.mock('@/lib/analytics/server', () => ({
  trackServerAndFlush: (...a: unknown[]) => mockTrack(...a),
  ENGAGEMENT_SERVER_EVENTS: {
    ACCEPTED: 'engagement_accepted',
    CHANGES_REQUESTED: 'engagement_changes_requested',
  },
}));

const mockPublish = vi.fn();
vi.mock('@/lib/notifications/publish', () => ({
  publishNotificationEvent: (...a: unknown[]) => {
    mockPublish(...a);
    return Promise.resolve();
  },
}));

import { acceptProjectAction } from './accept-project';
import { revalidatePath } from 'next/cache';

const INPUT = { engagementId: ENGAGEMENT_ID };

function engagement(overrides: Partial<ProjectEngagementWithMilestones> = {}) {
  return {
    id: ENGAGEMENT_ID,
    status: 'pending_acceptance',
    companyId: COMPANY_ID,
    expertProfileId: 'expert-1',
    completionRequestedAt: new Date('2026-07-04T00:00:00Z'),
    activatedAt: new Date('2026-06-24T00:00:00Z'),
    createdAt: new Date('2026-06-01T00:00:00Z'),
    company: { id: COMPANY_ID, name: 'Northwind Industrial' },
    projectRequest: { id: 'req-1', title: 'CPQ implementation' },
    expertProfile: {
      id: 'expert-1',
      user: { firstName: 'Priya', lastName: 'Sharma' },
      agency: null,
      headline: null,
      type: 'freelancer',
    },
    milestones: [{ status: 'completed' }, { status: 'completed' }],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireUser.mockResolvedValue({
    id: 'client-1',
    firstName: 'Dana',
    lastName: 'Lee',
    platformRole: 'user',
    companyId: COMPANY_ID,
  });
  mockFindEngagement.mockResolvedValue(engagement());
  mockResolveLens.mockReturnValue({ lens: 'client', archetype: 'participant' });
  mockHasCapability.mockResolvedValue(true);
  mockAccept.mockResolvedValue({
    status: 'completed',
    acceptedAt: new Date('2026-07-11T00:00:00Z'),
  });
  mockCountAudit.mockResolvedValue(1);
  // BAL-390 defaults: the accepting member has not rated yet, so a token is minted.
  mockFindLiveReview.mockResolvedValue(undefined);
  mockCreateReviewToken.mockResolvedValue({ id: 'tok-1' });
});

describe('acceptProjectAction', () => {
  it('rejects a malformed engagementId as INVALID_REQUEST', async () => {
    expect(await acceptProjectAction({ engagementId: 'not-a-uuid' })).toEqual({
      success: false,
      error: 'Invalid request.',
    });
    expect(mockAccept).not.toHaveBeenCalled();
  });

  it('returns ONLY_CLIENT for a non-client lens', async () => {
    mockResolveLens.mockReturnValue({ lens: 'expert', archetype: 'participant' });
    expect(await acceptProjectAction(INPUT)).toEqual({
      success: false,
      error: 'Only the client can do that.',
    });
    expect(mockAccept).not.toHaveBeenCalled();
  });

  it('returns NOT_UNDER_REVIEW when the engagement is not pending_acceptance', async () => {
    mockFindEngagement.mockResolvedValue(engagement({ status: 'active' }));
    expect(await acceptProjectAction(INPUT)).toEqual({
      success: false,
      error: "This project isn't under review.",
    });
    expect(mockAccept).not.toHaveBeenCalled();
  });

  it('fails closed (ONLY_CLIENT) when the live membership capability is missing', async () => {
    mockHasCapability.mockResolvedValue(false);
    expect(await acceptProjectAction(INPUT)).toEqual({
      success: false,
      error: 'Only the client can do that.',
    });
    expect(mockHasCapability).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'client-1' }),
      'participate',
      { companyId: COMPANY_ID }
    );
    expect(mockAccept).not.toHaveBeenCalled();
  });

  it('accepts as the client: tracks method=client, publishes expert+admin, revalidates', async () => {
    const result = await acceptProjectAction(INPUT);
    expect(result).toEqual({ success: true });
    expect(mockAccept).toHaveBeenCalledWith({
      engagementId: ENGAGEMENT_ID,
      method: 'client',
      userId: 'client-1',
    });

    expect(mockTrack).toHaveBeenCalledWith(
      'engagement_accepted',
      expect.objectContaining({
        engagement_id: ENGAGEMENT_ID,
        acceptance_method: 'client',
        review_cycle: 1,
        distinct_id: 'client-1',
        days_in_review: expect.any(Number),
      })
    );

    expect(mockPublish).toHaveBeenCalledWith(
      'engagement.accepted',
      expect.objectContaining({
        correlationId: `${ENGAGEMENT_ID}:accepted`,
        engagementId: ENGAGEMENT_ID,
        expertProfileId: 'expert-1',
        actorClientLabel: 'Dana @ Northwind Industrial',
        projectTitle: 'CPQ implementation',
        acceptedOn: '11 Jul 2026',
        milestonesTotal: 2,
      })
    );

    expect(revalidatePath).toHaveBeenCalledWith(`/engagements/${ENGAGEMENT_ID}`);
  });

  /**
   * ⚠ `userId` IS LOAD-BEARING, NOT DECORATION. The BAL-390 client rule in
   * `apps/api/src/notifications/engine/rules.ts` is gated on
   * `typeof ctx.payload.userId === 'string'` (recipient 'self', the `payment.charged`
   * actor-gets-a-receipt shape). Drop it and the accepting member's email SILENTLY never
   * sends — no error, no dead letter, nothing to notice in a manual test.
   */
  it('publishes the BAL-390 self-recipient fields: userId, party labels and the raw review token', async () => {
    await acceptProjectAction(INPUT);

    expect(mockFindLiveReview).toHaveBeenCalledWith(ENGAGEMENT_ID, 'client-1', 'expert-1');
    expect(mockCreateReviewToken).toHaveBeenCalledTimes(1);

    const mint = mockCreateReviewToken.mock.calls[0]?.[0] as {
      engagementId: string;
      reviewerUserId: string;
      tokenHash: string;
    };
    const payload = mockPublish.mock.calls[0]?.[1] as {
      userId: string;
      clientCompanyName: string;
      expertPartyLabel: string;
      reviewToken?: string;
    };

    expect(payload.userId).toBe('client-1');
    expect(payload.clientCompanyName).toBe('Northwind Industrial');
    expect(payload.expertPartyLabel).toBe('Priya Sharma');
    // 32 random bytes → 43 base64url chars; the STORED value is its SHA-256 hex, not this.
    const { reviewToken } = payload;
    if (reviewToken === undefined) {
      throw new Error('expected the accept email to carry a raw review token');
    }
    expect(reviewToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(mint.reviewerUserId).toBe('client-1');
    // Pin the ALGORITHM, not merely "it was hashed at all". `not.toBe(raw)` stays green if
    // the mint switches to sha512 or base64 — and the verifier (`sha256Hex`, hex) would then
    // never reproduce the stored hash, so every accept-email star link would render
    // <LinkNotActive /> in production with CI fully green. The API side already pins this
    // (`review-nudge-sweep.test.ts`); the web side did not, and that asymmetry WAS the drift
    // hole the shared-helper docblock warns about.
    expect(mint.tokenHash).toBe(createHash('sha256').update(reviewToken).digest('hex'));
  });

  it('omits reviewToken when the accepting member has already rated this expert', async () => {
    mockFindLiveReview.mockResolvedValue({ id: 'rev-1', rating: 5 });

    expect(await acceptProjectAction(INPUT)).toEqual({ success: true });
    expect(mockCreateReviewToken).not.toHaveBeenCalled();
    expect(mockPublish).toHaveBeenCalledWith(
      'engagement.accepted',
      expect.objectContaining({
        userId: 'client-1',
        reviewToken: undefined,
        // The email's "Thanks for rating this one already" line hangs on THIS, not on
        // the missing token — see the mint-failure case below for why.
        alreadyRated: true,
      })
    );
  });

  /**
   * ⚠ A FAILED MINT IS NOT "ALREADY RATED". The accept still publishes with no token (a
   * rating token must never break an accept), so the two states are indistinguishable
   * from `reviewToken === undefined` alone. `alreadyRated: false` is what stops the email
   * thanking someone for a review they never left.
   */
  it('still accepts and publishes on a mint failure — and does NOT claim they rated', async () => {
    mockCreateReviewToken.mockRejectedValue(new Error('db down'));

    expect(await acceptProjectAction(INPUT)).toEqual({ success: true });
    expect(mockPublish).toHaveBeenCalledWith(
      'engagement.accepted',
      expect.objectContaining({
        userId: 'client-1',
        reviewToken: undefined,
        alreadyRated: false,
      })
    );
  });

  it('does not claim a prior rating when the rating LOOKUP itself throws', async () => {
    mockFindLiveReview.mockRejectedValue(new Error('db down'));

    expect(await acceptProjectAction(INPUT)).toEqual({ success: true });
    expect(mockPublish).toHaveBeenCalledWith(
      'engagement.accepted',
      expect.objectContaining({ reviewToken: undefined, alreadyRated: false })
    );
  });

  it('sends alreadyRated: false alongside a freshly minted token', async () => {
    await acceptProjectAction(INPUT);

    const payload = mockPublish.mock.calls[0]?.[1] as { alreadyRated?: boolean };
    expect(payload.alreadyRated).toBe(false);
  });

  it('maps InvalidEngagementTransitionError from the repo to STATUS_CHANGED', async () => {
    mockAccept.mockRejectedValue(new InvalidEngagementTransitionError('x'));
    expect(await acceptProjectAction(INPUT)).toEqual({
      success: false,
      error: "This project's status changed. Refresh and try again.",
    });
  });
});

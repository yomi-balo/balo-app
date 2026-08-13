import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ENGAGEMENT_CAPABILITIES } from '@balo/shared/authz';

/**
 * BAL-421 — unit tests for the EXPERT's resolution ask: the FIRST `apps/web` consumer of the
 * ENGAGEMENT-capability axis.
 *
 * ⚠⚠ THE POINT OF THIS FILE IS THAT THE TWO CASE MUTATIONS SIT ON DIFFERENT AXES, and each is
 * refused the other's. The close asks `PARTICIPATE` on the MEMBERSHIP axis and is CLIENT-only
 * (BAL-417); the ask asks `MANAGE_ENGAGEMENT` on the ENGAGEMENT axis and is EXPERT-only. A
 * refactor that "unified" them would have to break one of these suites.
 *
 * ⚠ `authorizeCaseMutation` IS REAL — that is how `requireOnboardedUser` is exercised.
 * `hasEngagementCapability` is mocked because it has its own suite (`lib/authz/engagement.
 * test.ts`) where the holder rule is tested against the REAL pure core; what matters HERE is
 * the SUBJECT this action hands it and that its `false` is honoured.
 */

const ENGAGEMENT_ID = 'e0000000-0000-4000-8000-000000000001';
const USER_ID = 'u0000000-0000-4000-8000-000000000002';
const COMPANY_ID = 'c0000000-0000-4000-8000-000000000003';
const PROFILE_ID = 'p0000000-0000-4000-8000-000000000004';

vi.mock('server-only', () => ({}));

const mockFindCase = vi.fn();
const mockRequestResolution = vi.fn();
vi.mock('@balo/db', () => ({
  caseEngagementsRepository: {
    findByEngagementId: (...a: unknown[]) => mockFindCase(...a),
    requestResolution: (...a: unknown[]) => mockRequestResolution(...a),
  },
}));

const mockRequireOnboardedUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  requireOnboardedUser: () => mockRequireOnboardedUser(),
}));

const mockResolveCaseAccess = vi.fn();
vi.mock('@/lib/cases/resolve-case-access', () => ({
  resolveCaseAccess: (...a: unknown[]) => mockResolveCaseAccess(...a),
}));

const mockHasEngagementCapability = vi.fn();
vi.mock('@/lib/authz/engagement', () => ({
  hasEngagementCapability: (...a: unknown[]) => mockHasEngagementCapability(...a),
}));

const mockRevalidate = vi.fn();
vi.mock('next/cache', () => ({ revalidatePath: (...a: unknown[]) => mockRevalidate(...a) }));

const mockPublish = vi.fn();
vi.mock('@/lib/notifications/publish', () => ({
  publishNotificationEvent: (...a: unknown[]) => {
    mockPublish(...a);
    return Promise.resolve();
  },
}));

import { requestResolutionAction } from './request-resolution';
import { log } from '@/lib/logging';

const ACCESS = {
  lens: 'expert',
  engagementId: ENGAGEMENT_ID,
  companyId: COMPANY_ID,
  expertProfileId: PROFILE_ID,
  engagementStatus: 'active',
  conversationId: 'conv-1',
  conversationWritable: true,
};

const INPUT = { engagementId: ENGAGEMENT_ID };
const DENIED = { success: false, error: "You don't have permission to do that." };

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireOnboardedUser.mockResolvedValue({ id: USER_ID });
  mockResolveCaseAccess.mockResolvedValue(ACCESS);
  mockFindCase.mockResolvedValue({ engagementId: ENGAGEMENT_ID, title: 'Flow interview loop' });
  mockHasEngagementCapability.mockResolvedValue(true);
  mockRequestResolution.mockResolvedValue({ engagementId: ENGAGEMENT_ID });
});

describe('requestResolutionAction — the two gates, in order', () => {
  it('goes through requireOnboardedUser BEFORE the tenancy gate', async () => {
    mockRequireOnboardedUser.mockRejectedValue(new Error('Onboarding not completed'));
    expect(await requestResolutionAction(INPUT)).toEqual({
      success: false,
      error: 'You are not signed in.',
    });
    expect(mockResolveCaseAccess).not.toHaveBeenCalled();
    expect(mockRequestResolution).not.toHaveBeenCalled();
  });

  it('re-runs the FULL tenancy gate, discharging the READ obligation the act axis does NOT', async () => {
    // "a `true` from that seam authorizes the ACT, never the READ, and
    // `meeting_contexts.context_id` has no FK and no RLS."
    await requestResolutionAction(INPUT);
    expect(mockResolveCaseAccess).toHaveBeenCalledWith(ENGAGEMENT_ID, USER_ID);
  });

  it('rejects a malformed engagementId before any DB read', async () => {
    expect(await requestResolutionAction({ engagementId: 'nope' })).toEqual({
      success: false,
      error: 'Invalid request.',
    });
    expect(mockResolveCaseAccess).not.toHaveBeenCalled();
    expect(mockHasEngagementCapability).not.toHaveBeenCalled();
  });

  /**
   * ⚠⚠ THE MIRROR OF BAL-417. A CLIENT-side actor is structurally excluded from the engagement
   * resolver anyway (it reads only the delivering expert's profile and their agency roles), so
   * checking the lens explicitly is what turns a confusing `false` into a legible rule with its
   * own test.
   */
  it('REFUSES the CLIENT lens, before the engagement axis is consulted at all', async () => {
    mockResolveCaseAccess.mockResolvedValue({ ...ACCESS, lens: 'client' });
    expect(await requestResolutionAction(INPUT)).toEqual(DENIED);
    expect(mockHasEngagementCapability).not.toHaveBeenCalled();
    expect(mockRequestResolution).not.toHaveBeenCalled();
  });

  it('gates on MANAGE_ENGAGEMENT with a subject DERIVED from the gate, never supplied', async () => {
    await requestResolutionAction(INPUT);
    expect(mockHasEngagementCapability).toHaveBeenCalledWith(
      { id: USER_ID },
      ENGAGEMENT_CAPABILITIES.MANAGE_ENGAGEMENT,
      // A `case` context's contextId IS the engagement id.
      { contextType: 'case', contextId: ENGAGEMENT_ID }
    );
  });

  it('is NOT the membership axis — MANAGE_ENGAGEMENT, never PARTICIPATE', async () => {
    await requestResolutionAction(INPUT);
    const [, capability] = mockHasEngagementCapability.mock.calls[0] as [unknown, string];
    expect(capability).toBe('manage_engagement');
    expect(capability).not.toBe('participate');
  });

  /**
   * ⚠ AN AGENCY COLLEAGUE WITH ROLE `expert` LANDS HERE. They can SEE the whole case surface
   * (visibility is deliberately wider — ADR-1046 §7) and are refused the act. That gap is the
   * design, and this is the assertion that keeps the action honouring it.
   */
  it('REFUSES when the engagement axis says no — the agency-role-`expert` path', async () => {
    mockHasEngagementCapability.mockResolvedValue(false);
    expect(await requestResolutionAction(INPUT)).toEqual(DENIED);
    expect(mockRequestResolution).not.toHaveBeenCalled();
  });

  it('refuses a gate denial and a NON-case engagement with ONE indistinguishable literal', async () => {
    mockResolveCaseAccess.mockResolvedValue(null);
    const denied = await requestResolutionAction(INPUT);

    mockResolveCaseAccess.mockResolvedValue(ACCESS);
    mockFindCase.mockResolvedValue(undefined);
    const nonCase = await requestResolutionAction(INPUT);

    expect(denied).toEqual({ success: false, error: 'This case is no longer available.' });
    expect(denied).toEqual(nonCase);
    expect(mockRequestResolution).not.toHaveBeenCalled();
  });
});

describe('requestResolutionAction — the write, and what it deliberately does NOT do', () => {
  it('writes with the gate engagementId and the SESSION user', async () => {
    expect(await requestResolutionAction(INPUT)).toEqual({ success: true });
    expect(mockRequestResolution).toHaveBeenCalledWith({
      engagementId: ENGAGEMENT_ID,
      userId: USER_ID,
    });
    expect(mockRevalidate).toHaveBeenCalledWith('/cases/' + ENGAGEMENT_ID);
  });

  /**
   * ⚠⚠ NO NOTIFICATION, NO DOMAIN EVENT, NO TEMPLATE, NO RULE — symmetric with the shipped
   * dismiss half (owner decision D-E). The ask renders as a BANNER on the client's case
   * surface, and that banner is the ENTIRE delivery mechanism. This assertion is what makes
   * "last-ask-wins" safe: an expert re-raising a dismissed banner cannot email-bomb anyone.
   */
  it('publishes NOTHING — the banner is the entire delivery mechanism', async () => {
    await requestResolutionAction(INPUT);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('reports a CLOSED case honestly when the repository refuses the write', async () => {
    // The repository's WHERE carries `closed_at IS NULL`, so a closed (or soft-deleted, or
    // non-`case`) parent yields undefined with NO write.
    mockRequestResolution.mockResolvedValue(undefined);
    expect(await requestResolutionAction(INPUT)).toEqual({
      success: false,
      error: 'This case is no longer open.',
    });
    expect(mockRevalidate).not.toHaveBeenCalled();
  });

  it('logs and returns friendly copy when the write REJECTS', async () => {
    mockRequestResolution.mockRejectedValue(new Error('23514'));
    expect(await requestResolutionAction(INPUT)).toEqual({
      success: false,
      error: 'Something went wrong. Please try again.',
    });
    expect(log.error).toHaveBeenCalled();
  });

  it('is idempotent in effect — a re-ask writes again and stays successful', async () => {
    expect(await requestResolutionAction(INPUT)).toEqual({ success: true });
    expect(await requestResolutionAction(INPUT)).toEqual({ success: true });
    expect(mockRequestResolution).toHaveBeenCalledTimes(2);
    expect(mockPublish).not.toHaveBeenCalled();
  });
});

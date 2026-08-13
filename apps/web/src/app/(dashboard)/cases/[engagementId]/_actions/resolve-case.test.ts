import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

/**
 * BAL-421 — unit tests for the CASE-SURFACE close: the SECOND entry point onto BAL-388's
 * shipped close contract.
 *
 * ⚠⚠ SIBLING FILE, NOT A REPLACEMENT. `meetings/[meetingId]/_actions/resolve-case.test.ts` is
 * BAL-388's shipped test over the FIRST entry point and must keep passing UNCHANGED — that is
 * the stated behaviour-preservation proof for extracting `close-case-effects`. This file tests
 * what is genuinely different at this grain: the subject is an ENGAGEMENT id rather than a
 * meeting id, so the anti-oracle property has to be earned rather than inherited, and the CTA
 * anchor must be DERIVED (the recap always had a meeting in hand; here there may be none).
 *
 * ⚠⚠ `authorizeCaseMutation` AND `close-case-effects` ARE BOTH REAL HERE. Mocking either would
 * hollow out the two claims worth testing: that the close runs through `requireOnboardedUser`
 * (Server Actions bypass middleware — there is nothing else), and that a token MINT FAILURE
 * degrades to a tokenless publish instead of failing a close that has ALREADY COMMITTED. Only
 * `@balo/db`, the session, the tenancy gate and the publish transport are mocked.
 */

const ENGAGEMENT_ID = 'e0000000-0000-4000-8000-000000000001';
const USER_ID = 'u0000000-0000-4000-8000-000000000002';
const COMPANY_ID = 'c0000000-0000-4000-8000-000000000003';
const PROFILE_ID = 'p0000000-0000-4000-8000-000000000004';
const CLOSED_AT = new Date('2026-08-12T09:00:00Z');

vi.mock('server-only', () => ({}));

// ⚠ `vi.hoisted` IS REQUIRED, NOT STYLE — `vi.mock` factories hoist above every top-level
// declaration, so a plain `class X extends Error {}` would be in its TDZ when the factory runs.
const { CaseAlreadyClosedError, CaseCloserNotMemberError } = vi.hoisted(() => {
  class AlreadyClosed extends Error {}
  class CloserNotMember extends Error {}
  return { CaseAlreadyClosedError: AlreadyClosed, CaseCloserNotMemberError: CloserNotMember };
});

const mockFindCase = vi.fn();
const mockClose = vi.fn();
const mockFindLiveReview = vi.fn();
const mockCreateToken = vi.fn();
const mockListSiblings = vi.fn();
const mockFindCompany = vi.fn();
const mockFindProfile = vi.fn();
const mockFindUser = vi.fn();
const mockFindAgency = vi.fn();

vi.mock('@balo/db', () => ({
  CaseAlreadyClosedError,
  CaseCloserNotMemberError,
  caseEngagementsRepository: {
    findByEngagementId: (...a: unknown[]) => mockFindCase(...a),
    close: (...a: unknown[]) => mockClose(...a),
  },
  reviewsRepository: { findLive: (...a: unknown[]) => mockFindLiveReview(...a) },
  reviewInviteTokensRepository: { create: (...a: unknown[]) => mockCreateToken(...a) },
  meetingContextsRepository: {
    listMeetingsForContext: (...a: unknown[]) => mockListSiblings(...a),
  },
  companiesRepository: { findNameById: (...a: unknown[]) => mockFindCompany(...a) },
  expertsRepository: { findDisplayProfileById: (...a: unknown[]) => mockFindProfile(...a) },
  usersRepository: { findDisplayById: (...a: unknown[]) => mockFindUser(...a) },
  agenciesRepository: { getSummaryById: (...a: unknown[]) => mockFindAgency(...a) },
}));

const mockRequireOnboardedUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  requireOnboardedUser: () => mockRequireOnboardedUser(),
}));

const mockResolveCaseAccess = vi.fn();
vi.mock('@/lib/cases/resolve-case-access', () => ({
  resolveCaseAccess: (...a: unknown[]) => mockResolveCaseAccess(...a),
}));

const mockHasCapability = vi.fn();
vi.mock('@/lib/authz', () => ({
  hasCapability: (...a: unknown[]) => mockHasCapability(...a),
  CAPABILITIES: { PARTICIPATE: 'participate' },
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

const mockTrack = vi.fn();
// The constants come from SOURCE, not a hand-restated literal, so a rename in
// `packages/analytics` fails HERE rather than leaving a green suite asserting a dead name.
vi.mock('@/lib/analytics/server', async () => {
  const events = await import('@balo/analytics/events');
  return {
    trackServerAndFlush: (...a: unknown[]) => mockTrack(...a),
    RECAP_SERVER_EVENTS: events.RECAP_SERVER_EVENTS,
  };
});

import { resolveCaseAction } from './resolve-case';
import { log } from '@/lib/logging';

const ACCESS = {
  lens: 'client',
  engagementId: ENGAGEMENT_ID,
  companyId: COMPANY_ID,
  expertProfileId: PROFILE_ID,
  engagementStatus: 'active',
  conversationId: 'conv-1',
  conversationWritable: true,
};

const INPUT = { engagementId: ENGAGEMENT_ID };

function sibling(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    scheduledStart: new Date('2026-07-01T10:00:00Z'),
    startedAt: new Date('2026-07-01T10:00:00Z'),
    status: 'ended',
    outcome: 'completed',
    ...over,
  };
}

function publishedPayload(): Record<string, unknown> {
  const [, payload] = mockPublish.mock.calls[0] as [string, Record<string, unknown>];
  return payload;
}

function seed(over: { siblings?: unknown[] } = {}): void {
  vi.clearAllMocks();
  mockRequireOnboardedUser.mockResolvedValue({ id: USER_ID });
  mockResolveCaseAccess.mockResolvedValue(ACCESS);
  mockFindCase.mockResolvedValue({ engagementId: ENGAGEMENT_ID, title: 'Flow interview loop' });
  mockHasCapability.mockResolvedValue(true);
  mockClose.mockResolvedValue({ closedAt: CLOSED_AT });
  mockFindLiveReview.mockResolvedValue(undefined);
  mockCreateToken.mockResolvedValue({ id: 'tok-1' });
  mockListSiblings.mockResolvedValue(over.siblings ?? [sibling('m1')]);
  mockFindCompany.mockResolvedValue({ id: COMPANY_ID, name: 'Northwind Industrial' });
  mockFindProfile.mockResolvedValue({ userId: 'u-expert', agencyId: null, type: 'freelancer' });
  mockFindUser.mockResolvedValue({ firstName: 'Amara', lastName: 'Okafor' });
  mockFindAgency.mockResolvedValue(undefined);
}

beforeEach(() => {
  seed();
});

describe('resolveCaseAction (case surface) — the gates, in order', () => {
  it('goes through requireOnboardedUser BEFORE the tenancy gate', async () => {
    mockRequireOnboardedUser.mockRejectedValue(new Error('Onboarding not completed'));
    expect(await resolveCaseAction(INPUT)).toEqual({
      success: false,
      error: 'You are not signed in.',
    });
    expect(mockResolveCaseAccess).not.toHaveBeenCalled();
    expect(mockClose).not.toHaveBeenCalled();
  });

  it('re-runs the FULL tenancy gate — a Server Action never trusts the page decision', async () => {
    await resolveCaseAction(INPUT);
    expect(mockResolveCaseAccess).toHaveBeenCalledWith(ENGAGEMENT_ID, USER_ID);
  });

  it('rejects a malformed engagementId before any DB read', async () => {
    expect(await resolveCaseAction({ engagementId: 'nope' })).toEqual({
      success: false,
      error: 'Invalid request.',
    });
    expect(mockResolveCaseAccess).not.toHaveBeenCalled();
  });

  /**
   * ⚠⚠ BAL-417 — AN EXPERT CAN NEVER CLOSE A CASE; they may only ASK. The lens assertion runs
   * BEFORE any capability check so the rule is legible and has a test of its own, rather than
   * being an emergent property of two other checks.
   */
  it('REFUSES the EXPERT lens the close, before any capability is resolved', async () => {
    mockResolveCaseAccess.mockResolvedValue({ ...ACCESS, lens: 'expert' });
    expect(await resolveCaseAction(INPUT)).toEqual({
      success: false,
      error: "You don't have permission to resolve this case.",
    });
    expect(mockHasCapability).not.toHaveBeenCalled();
    expect(mockClose).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('resolves PARTICIPATE on the MEMBERSHIP axis with the GATE companyId (ADR-1029)', async () => {
    await resolveCaseAction(INPUT);
    expect(mockHasCapability).toHaveBeenCalledWith({ id: USER_ID }, 'participate', {
      companyId: COMPANY_ID,
    });
  });

  it('refuses when the capability check fails, and never closes', async () => {
    mockHasCapability.mockResolvedValue(false);
    expect((await resolveCaseAction(INPUT)).success).toBe(false);
    expect(mockClose).not.toHaveBeenCalled();
  });

  it('refuses a gate denial and a NON-case engagement with ONE indistinguishable literal', async () => {
    mockResolveCaseAccess.mockResolvedValue(null);
    const denied = await resolveCaseAction(INPUT);

    seed();
    mockFindCase.mockResolvedValue(undefined);
    const nonCase = await resolveCaseAction(INPUT);

    expect(denied).toEqual({ success: false, error: 'This case is no longer available.' });
    expect(denied).toEqual(nonCase);
    expect(mockClose).not.toHaveBeenCalled();
  });

  it('closes with the HONEST reason and the engagement id FROM THE GATE', async () => {
    expect(await resolveCaseAction(INPUT)).toEqual({ success: true });
    expect(mockClose).toHaveBeenCalledWith({
      engagementId: ENGAGEMENT_ID,
      reason: 'resolved',
      userId: USER_ID,
    });
  });

  it('surfaces CaseCloserNotMemberError as a friendly failure, with no publish', async () => {
    mockClose.mockRejectedValue(new CaseCloserNotMemberError('not a member'));
    const result = await resolveCaseAction(INPUT);
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('permission') });
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('logs and returns friendly copy on an unexpected failure', async () => {
    mockClose.mockRejectedValue(new Error('boom'));
    expect(await resolveCaseAction(INPUT)).toEqual({
      success: false,
      error: 'Something went wrong. Please try again.',
    });
    expect(log.error).toHaveBeenCalled();
  });

  it('revalidates the CASE path, not the recap path', async () => {
    await resolveCaseAction(INPUT);
    expect(mockRevalidate).toHaveBeenCalledWith('/cases/' + ENGAGEMENT_ID);
  });

  it('tracks case_resolved with source=case_surface — the second value of that dimension', async () => {
    await resolveCaseAction(INPUT);
    expect(mockTrack).toHaveBeenCalledWith('case_resolved', {
      source: 'case_surface',
      engagement_id: ENGAGEMENT_ID,
      distinct_id: USER_ID,
    });
  });
});

/**
 * The case surface has NO meeting in scope, so the CTA anchor must be derived — and
 * `undefined` is a fully supported answer that makes the templates render no link at all.
 */
describe('resolveCaseAction (case surface) — the derived CTA anchor', () => {
  it('anchors to the MOST RECENT HELD consultation', async () => {
    seed({
      siblings: [
        sibling('m-old', { startedAt: new Date('2026-07-01T10:00:00Z') }),
        sibling('m-new', { startedAt: new Date('2026-07-08T10:00:00Z') }),
      ],
    });
    await resolveCaseAction(INPUT);
    expect(publishedPayload().meetingId).toBe('m-new');
  });

  it('emits NO meetingId when nothing was ever HELD — never a fabricated id', async () => {
    // A cancelled/no-show meeting resolves to a recap saying the call never happened — a
    // WORSE CTA than none.
    seed({
      siblings: [
        sibling('m1', { status: 'cancelled', outcome: null }),
        sibling('m2', { outcome: 'no_show_client' }),
      ],
    });
    await resolveCaseAction(INPUT);
    expect(publishedPayload().meetingId).toBeUndefined();
  });

  it('emits NO meetingId for a case closed before any consultation existed', async () => {
    seed({ siblings: [] });
    expect(await resolveCaseAction(INPUT)).toEqual({ success: true });
    expect(publishedPayload().meetingId).toBeUndefined();
  });

  it('counts only HELD consultations for consultationCount', async () => {
    seed({
      siblings: [
        sibling('m1'),
        sibling('m2'),
        sibling('m3', { outcome: 'missed_call' }),
        sibling('m4', { status: 'cancelled', outcome: null }),
      ],
    });
    await resolveCaseAction(INPUT);
    expect(publishedPayload().consultationCount).toBe(2);
  });

  it('reads the sibling set ONCE for both figures', async () => {
    await resolveCaseAction(INPUT);
    expect(mockListSiblings).toHaveBeenCalledTimes(1);
  });

  it('CAPS the case title so a long one is not silently dropped by the publish schema', async () => {
    mockFindCase.mockResolvedValue({ engagementId: ENGAGEMENT_ID, title: 'x'.repeat(400) });
    await resolveCaseAction(INPUT);
    expect((publishedPayload().caseTitle as string).length).toBe(200);
  });
});

describe('resolveCaseAction (case surface) — the review ask degrades, never blocks', () => {
  it('mints a raw token and pins the hashing algorithm to sha256-hex', async () => {
    await resolveCaseAction(INPUT);
    const reviewToken = publishedPayload().reviewToken as string | undefined;
    if (typeof reviewToken !== 'string') {
      throw new Error('expected the close email to carry a raw review token');
    }
    expect(reviewToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const mint = mockCreateToken.mock.calls[0]?.[0] as Record<string, unknown>;
    // Pin the ALGORITHM: mint and verify must agree FOREVER, or every emailed star link is
    // dead in production with CI fully green.
    expect(mint.tokenHash).toBe(createHash('sha256').update(reviewToken).digest('hex'));
    expect(mint.engagementId).toBe(ENGAGEMENT_ID);
    expect(mint.reviewerUserId).toBe(USER_ID);
  });

  /**
   * ⚠⚠ THE CLOSE HAS ALREADY COMMITTED BY THE TIME THE MINT RUNS. A rating token is a
   * nice-to-have riding along with a TERMINAL state change, so a mint failure must degrade to
   * a tokenless publish — never to a failed action that tells the client their case did not
   * close when the row says it did.
   */
  it('a MINT FAILURE still lets the close SUCCEED, degrading to a tokenless publish', async () => {
    mockCreateToken.mockRejectedValue(new Error('db down'));

    expect(await resolveCaseAction(INPUT)).toEqual({ success: true });
    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(publishedPayload().reviewToken).toBeUndefined();
    expect(log.error).toHaveBeenCalled();
  });

  it('a mint failure still revalidates and still tracks — the close is complete', async () => {
    mockCreateToken.mockRejectedValue(new Error('db down'));
    await resolveCaseAction(INPUT);
    expect(mockRevalidate).toHaveBeenCalledWith('/cases/' + ENGAGEMENT_ID);
    expect(mockTrack).toHaveBeenCalled();
  });

  it('omits reviewToken entirely when the resolving member already rated this expert', async () => {
    mockFindLiveReview.mockResolvedValue({ id: 'rev-1', rating: 5 });
    await resolveCaseAction(INPUT);
    expect(mockCreateToken).not.toHaveBeenCalled();
    expect(publishedPayload().reviewToken).toBeUndefined();
  });

  it('asks findLive about the RESOLVING member — the reviewer IS the recipient', async () => {
    await resolveCaseAction(INPUT);
    expect(mockFindLiveReview).toHaveBeenCalledWith(ENGAGEMENT_ID, USER_ID, PROFILE_ID);
  });

  it('never logs the raw token or its hash on the success path', async () => {
    await resolveCaseAction(INPUT);
    const token = publishedPayload().reviewToken as string;
    const logged = JSON.stringify([
      ...vi.mocked(log.info).mock.calls,
      ...vi.mocked(log.warn).mock.calls,
      ...vi.mocked(log.error).mock.calls,
    ]);
    expect(logged).not.toContain(token);
    expect(logged).not.toContain(createHash('sha256').update(token).digest('hex'));
  });
});

describe('resolveCaseAction (case surface) — exactly once under double-submit', () => {
  it('treats CaseAlreadyClosedError as SUCCESS but does NOT publish again', async () => {
    mockClose.mockRejectedValue(new CaseAlreadyClosedError('already closed'));
    expect(await resolveCaseAction(INPUT)).toEqual({ success: true });
    // A double-click must not send two close emails or mint a second live token.
    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockCreateToken).not.toHaveBeenCalled();
    expect(mockRevalidate).toHaveBeenCalledWith('/cases/' + ENGAGEMENT_ID);
  });

  it('a real DOUBLE-SUBMIT closes once and emails once', async () => {
    mockClose
      .mockResolvedValueOnce({ closedAt: CLOSED_AT })
      .mockRejectedValueOnce(new CaseAlreadyClosedError('already closed'));

    const [first, second] = await Promise.all([resolveCaseAction(INPUT), resolveCaseAction(INPUT)]);

    expect(first).toEqual({ success: true });
    expect(second).toEqual({ success: true });
    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockCreateToken).toHaveBeenCalledTimes(1);
  });

  it('publishes engagement.case_closed with the honest reason and no email address anywhere', async () => {
    await resolveCaseAction(INPUT);
    const [event, payload] = mockPublish.mock.calls[0] as [string, Record<string, unknown>];
    expect(event).toBe('engagement.case_closed');
    expect(payload).toMatchObject({
      correlationId: ENGAGEMENT_ID + ':case_closed',
      engagementId: ENGAGEMENT_ID,
      recipientId: USER_ID,
      expertProfileId: PROFILE_ID,
      closeReason: 'resolved',
    });
    expect(JSON.stringify(payload)).not.toContain('@');
  });
});

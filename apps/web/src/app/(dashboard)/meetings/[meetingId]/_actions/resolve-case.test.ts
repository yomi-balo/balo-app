import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

const MEETING_ID = 'a0000000-0000-4000-8000-000000000001';
const USER_ID = 'b0000000-0000-4000-8000-000000000002';
const COMPANY_ID = 'c0000000-0000-4000-8000-000000000003';
const PROFILE_ID = 'd0000000-0000-4000-8000-000000000004';
const ENGAGEMENT_ID = 'e0000000-0000-4000-8000-000000000005';
const CLOSED_AT = new Date('2026-08-12T09:00:00Z');

vi.mock('server-only', () => ({}));

// ⚠ `vi.hoisted` IS REQUIRED, NOT STYLE. `vi.mock` factories are hoisted above every top-level
// declaration, so a plain `class X extends Error {}` here would be in its temporal dead zone
// when the factory runs — the module under test then fails to import at all, with a
// "Cannot access before initialization" that looks nothing like a mocking problem.
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

const mockHasCapability = vi.fn();
vi.mock('@/lib/authz', () => ({
  hasCapability: (...a: unknown[]) => mockHasCapability(...a),
  CAPABILITIES: { PARTICIPATE: 'participate' },
}));

const mockResolveAccess = vi.fn();
vi.mock('@/lib/meetings/resolve-recap-access', () => ({
  resolveRecapAccess: (...a: unknown[]) => mockResolveAccess(...a),
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
// ⚠ THE CONSTANTS COME FROM SOURCE, NOT A HAND-RESTATED LITERAL. `apps/web/src/test/setup.ts`
// sets the precedent ("so the mock stays in sync with source"): a rename in
// `packages/analytics/src/events/recap.ts` must fail HERE rather than leave a green suite
// asserting an event name nothing emits.
vi.mock('@/lib/analytics/server', async () => {
  const events = await import('@balo/analytics/events');
  return {
    trackServerAndFlush: (...a: unknown[]) => mockTrack(...a),
    RECAP_SERVER_EVENTS: events.RECAP_SERVER_EVENTS,
  };
});

import { resolveCaseAction } from './resolve-case';
import { log } from '@/lib/logging';

const CASE_ACCESS = {
  lens: 'client',
  meeting: { id: MEETING_ID },
  subject: { contextType: 'case', contextId: ENGAGEMENT_ID },
  companyId: COMPANY_ID,
  expertProfileId: PROFILE_ID,
};

const INPUT = { meetingId: MEETING_ID };

/**
 * Everything this action logged, at EVERY level. Reading only `log.info` was the hole: the
 * branch that could plausibly quote a token hash is the mint-failure `log.error`.
 */
function loggedText(): string {
  const calls = (level: unknown): unknown[] => (level as { mock: { calls: unknown[] } }).mock.calls;
  return JSON.stringify([...calls(log.info), ...calls(log.error), ...calls(log.warn)]);
}

function sibling(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    scheduledStart: new Date('2026-07-01T10:00:00Z'),
    startedAt: null,
    status: 'ended',
    outcome: 'completed',
    ...over,
  };
}

interface ResolveCaseSeed {
  user?: unknown;
  siblings?: unknown[];
}

/**
 * ONE seed for every `beforeEach` in this file. Hoisted because the four blocks below had
 * drifted into near-identical 13-line copies — close enough to SonarJS's S4144 threshold that
 * one more shared line would have tripped the duplication gate. Every test that cares about a
 * particular mock still overrides it inline, which is where the intent belongs.
 */
function seedResolveCaseMocks(seed: ResolveCaseSeed = {}): void {
  vi.clearAllMocks();
  mockRequireOnboardedUser.mockResolvedValue(seed.user ?? { id: USER_ID });
  mockResolveAccess.mockResolvedValue(CASE_ACCESS);
  mockHasCapability.mockResolvedValue(true);
  mockFindCase.mockResolvedValue({ engagementId: ENGAGEMENT_ID, title: 'Flow interview loop' });
  mockClose.mockResolvedValue({ closedAt: CLOSED_AT });
  mockFindLiveReview.mockResolvedValue(undefined);
  mockCreateToken.mockResolvedValue({ id: 'tok-1' });
  mockListSiblings.mockResolvedValue(seed.siblings ?? [sibling('m1')]);
  mockFindCompany.mockResolvedValue({ id: COMPANY_ID, name: 'Northwind Industrial' });
  mockFindProfile.mockResolvedValue({ userId: 'u-expert', agencyId: null, type: 'freelancer' });
  mockFindUser.mockResolvedValue({ firstName: 'Amara', lastName: 'Okafor' });
  mockFindAgency.mockResolvedValue(undefined);
}

describe('resolveCaseAction — the CTA the close email carries', () => {
  beforeEach(() => {
    seedResolveCaseMocks({ user: { id: USER_ID, firstName: 'Dana' } });
  });

  it('carries the MEETING id, so both deep links resolve', async () => {
    // `/engagements/{id}` 404s BY CONSTRUCTION for a case (that loader filters
    // engagement_type = 'project'), and this action is the event's FIRST publisher — so without
    // a meetingId the very first close email the platform ever sends would end in a 404.
    await resolveCaseAction(INPUT);
    const [, payload] = mockPublish.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload.meetingId).toBe(MEETING_ID);
    expect(payload.engagementId).toBe(ENGAGEMENT_ID);
  });

  it('CAPS the case title at the publish schema limit, so the email is not silently dropped', async () => {
    // `case_engagements.title` is uncapped `text`; the publish schema caps it at 200 and
    // `publishNotificationEvent` swallows the 400 — a long title meant NO email at all.
    mockFindCase.mockResolvedValue({ engagementId: ENGAGEMENT_ID, title: 'x'.repeat(400) });
    await resolveCaseAction(INPUT);
    const [, payload] = mockPublish.mock.calls[0] as [string, Record<string, unknown>];
    expect((payload.caseTitle as string).length).toBe(200);
  });

  it('leaves a short title verbatim', async () => {
    await resolveCaseAction(INPUT);
    const [, payload] = mockPublish.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload.caseTitle).toBe('Flow interview loop');
  });

  it('refuses a case context that names no expert, with the SAME denial literal', async () => {
    mockResolveAccess.mockResolvedValue({ ...CASE_ACCESS, expertProfileId: null });
    const result = await resolveCaseAction(INPUT);
    expect(result).toEqual({ success: false, error: 'This recap is no longer available.' });
    expect(mockClose).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });
});

describe('resolveCaseAction — gates', () => {
  beforeEach(() => {
    seedResolveCaseMocks({
      user: { id: USER_ID, firstName: 'Dana' },
      siblings: [sibling('m1'), sibling('m2')],
    });
  });

  it('rejects when not signed in, before the gate runs', async () => {
    mockRequireOnboardedUser.mockRejectedValue(new Error('Unauthorized'));
    expect(await resolveCaseAction(INPUT)).toEqual({
      success: false,
      error: 'You are not signed in.',
    });
    expect(mockResolveAccess).not.toHaveBeenCalled();
  });

  it('rejects an un-onboarded user', async () => {
    mockRequireOnboardedUser.mockRejectedValue(new Error('Onboarding not completed'));
    expect((await resolveCaseAction(INPUT)).success).toBe(false);
    expect(mockClose).not.toHaveBeenCalled();
  });

  it('rejects a malformed meetingId before the gate', async () => {
    expect(await resolveCaseAction({ meetingId: 'nope' })).toEqual({
      success: false,
      error: 'Invalid request.',
    });
    expect(mockResolveAccess).not.toHaveBeenCalled();
  });

  it('rejects a gate denial with generic copy and never closes', async () => {
    mockResolveAccess.mockResolvedValue(null);
    expect((await resolveCaseAction(INPUT)).success).toBe(false);
    expect(mockClose).not.toHaveBeenCalled();
  });

  it('REJECTS THE EXPERT LENS — an expert can never close a case (BAL-417)', async () => {
    mockResolveAccess.mockResolvedValue({ ...CASE_ACCESS, lens: 'expert' });
    expect((await resolveCaseAction(INPUT)).success).toBe(false);
    expect(mockClose).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('rejects a NON-case context', async () => {
    mockResolveAccess.mockResolvedValue({
      ...CASE_ACCESS,
      subject: { contextType: 'request_interaction', contextId: 'rel-1' },
    });
    expect((await resolveCaseAction(INPUT)).success).toBe(false);
    expect(mockClose).not.toHaveBeenCalled();
  });

  it('resolves the capability on the MEMBERSHIP axis with the GATE companyId', async () => {
    await resolveCaseAction(INPUT);
    expect(mockHasCapability).toHaveBeenCalledWith(
      { id: USER_ID, firstName: 'Dana' },
      'participate',
      { companyId: COMPANY_ID }
    );
  });

  it('rejects when the capability check fails, and never closes', async () => {
    mockHasCapability.mockResolvedValue(false);
    expect((await resolveCaseAction(INPUT)).success).toBe(false);
    expect(mockClose).not.toHaveBeenCalled();
  });

  it('closes with the HONEST reason and the ENGAGEMENT ID FROM THE GATE', async () => {
    expect(await resolveCaseAction(INPUT)).toEqual({ success: true });
    expect(mockClose).toHaveBeenCalledWith({
      engagementId: ENGAGEMENT_ID,
      reason: 'resolved',
      userId: USER_ID,
    });
  });

  it('surfaces CaseCloserNotMemberError as a friendly failure', async () => {
    mockClose.mockRejectedValue(new CaseCloserNotMemberError('not a member'));
    const result = await resolveCaseAction(INPUT);
    expect(result.success).toBe(false);
    expect(result).toMatchObject({ error: expect.stringContaining('permission') });
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
});

describe('resolveCaseAction — the two-step close contract', () => {
  beforeEach(() => {
    seedResolveCaseMocks({
      siblings: [
        sibling('m1'),
        sibling('m2'),
        sibling('m3', { outcome: 'no_show_client' }),
        sibling('m4', { status: 'cancelled', outcome: null }),
      ],
    });
  });

  it('publishes engagement.case_closed EXACTLY ONCE, with the honest close reason', async () => {
    await resolveCaseAction(INPUT);
    expect(mockPublish).toHaveBeenCalledTimes(1);
    const [event, payload] = mockPublish.mock.calls[0] as [string, Record<string, unknown>];
    expect(event).toBe('engagement.case_closed');
    expect(payload).toMatchObject({
      correlationId: ENGAGEMENT_ID + ':case_closed',
      engagementId: ENGAGEMENT_ID,
      recipientId: USER_ID,
      expertProfileId: PROFILE_ID,
      clientCompanyName: 'Northwind Industrial',
      caseTitle: 'Flow interview loop',
      closeReason: 'resolved',
    });
  });

  it('supplies consultationCount from the ordinal derivation (ended + completed only)', async () => {
    await resolveCaseAction(INPUT);
    const [, payload] = mockPublish.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload.consultationCount).toBe(2);
  });

  it('names the expert PARTY, and never an email address, anywhere in the payload', async () => {
    await resolveCaseAction(INPUT);
    const [, payload] = mockPublish.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload.expertPartyLabel).toBe('Amara Okafor');
    expect(JSON.stringify(payload)).not.toContain('@');
  });

  it('mints a raw review token and PINS THE HASHING ALGORITHM to sha256-hex', async () => {
    await resolveCaseAction(INPUT);
    const [, payload] = mockPublish.mock.calls[0] as [string, Record<string, unknown>];
    const reviewToken = payload.reviewToken as string | undefined;
    if (typeof reviewToken !== 'string') {
      throw new Error('expected the close email to carry a raw review token');
    }
    expect(reviewToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const mint = mockCreateToken.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(mint.engagementId).toBe(ENGAGEMENT_ID);
    expect(mint.reviewerUserId).toBe(USER_ID);
    // Pin the ALGORITHM, not merely that it was hashed at all. A `not.toBe(raw)` assertion
    // stays green if the mint switches to sha512 or base64 — and the VERIFIER (`sha256Hex`,
    // hex) would then never reproduce the stored hash, so every emailed star link would render
    // as an inactive link in production with CI fully green. Mirrored from
    // `accept-project.test.ts`, which closed exactly this drift hole on the web side.
    expect(mint.tokenHash).toBe(createHash('sha256').update(reviewToken).digest('hex'));
  });

  it('omits reviewToken ENTIRELY when the resolving member has already rated this expert', async () => {
    mockFindLiveReview.mockResolvedValue({ id: 'rev-1', rating: 5 });
    await resolveCaseAction(INPUT);
    expect(mockCreateToken).not.toHaveBeenCalled();
    const [, payload] = mockPublish.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload.reviewToken).toBeUndefined();
  });

  it('asks findLive about the RESOLVING member — the reviewer IS the recipient', async () => {
    await resolveCaseAction(INPUT);
    expect(mockFindLiveReview).toHaveBeenCalledWith(ENGAGEMENT_ID, USER_ID, PROFILE_ID);
  });

  it('degrades a MINT FAILURE to a tokenless publish, and the close still succeeds', async () => {
    mockCreateToken.mockRejectedValue(new Error('db down'));
    expect(await resolveCaseAction(INPUT)).toEqual({ success: true });
    expect(mockPublish).toHaveBeenCalledTimes(1);
    const [, payload] = mockPublish.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload.reviewToken).toBeUndefined();
    expect(log.error).toHaveBeenCalled();
  });

  it('never logs the raw token or its hash on the SUCCESS path', async () => {
    await resolveCaseAction(INPUT);
    const [, payload] = mockPublish.mock.calls[0] as [string, Record<string, unknown>];
    const token = payload.reviewToken as string;
    expect(loggedText()).not.toContain(token);
    expect(loggedText()).not.toContain(createHash('sha256').update(token).digest('hex'));
  });

  /**
   * ⚠ THE MINT-FAILURE PATH IS THE ONE THAT COULD PLAUSIBLY LEAK, and it is `log.error`, not
   * `log.info`. drizzle-orm interpolates the failing statement's BOUND PARAMS into
   * `DrizzleQueryError.message` (from ~0.41) — and the token hash IS a bound param of this
   * insert — so a routine dependency bump would start writing a live token hash into Axiom
   * with no code change in the action at all. `stack` repeats the message, so it goes too.
   */
  it('never logs the token HASH when the mint itself fails with the hash in its message', async () => {
    let mintedHash = '';
    mockCreateToken.mockImplementation((input: { tokenHash: string }) => {
      mintedHash = input.tokenHash;
      // Exactly what a post-0.41 DrizzleQueryError looks like: params interpolated into both
      // `message` and (therefore) `stack`.
      const error = new Error(
        'Failed query: insert into review_invite_tokens … params: ' + input.tokenHash
      );
      error.name = 'DrizzleQueryError';
      return Promise.reject(error);
    });

    expect(await resolveCaseAction(INPUT)).toEqual({ success: true });

    expect(mintedHash).toHaveLength(64);
    expect(log.error).toHaveBeenCalled();
    expect(loggedText()).not.toContain(mintedHash);
    // …and the failure is still routable: the identifiers and the error NAME survive.
    const errorCalls = (log.error as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const mintCall = errorCalls.find((call) => call[0] === 'Review invite token mint failed');
    expect(mintCall?.[1]).toMatchObject({
      engagementId: ENGAGEMENT_ID,
      userId: USER_ID,
      errorName: 'DrizzleQueryError',
    });
  });

  it('tracks case_resolved with source=recap — the whole point of the event', async () => {
    await resolveCaseAction(INPUT);
    expect(mockTrack).toHaveBeenCalledWith('case_resolved', {
      source: 'recap',
      engagement_id: ENGAGEMENT_ID,
      distinct_id: USER_ID,
    });
  });

  it('revalidates the recap path', async () => {
    await resolveCaseAction(INPUT);
    expect(mockRevalidate).toHaveBeenCalledWith('/meetings/' + MEETING_ID);
  });

  it('still succeeds when the sibling read fails — the ordinal is a garnish', async () => {
    mockListSiblings.mockRejectedValue(new Error('timeout'));
    expect(await resolveCaseAction(INPUT)).toEqual({ success: true });
    const [, payload] = mockPublish.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload.consultationCount).toBe(0);
  });
});

describe('resolveCaseAction — exactly once, and idempotent under double-submit', () => {
  beforeEach(() => {
    seedResolveCaseMocks();
  });

  it('treats CaseAlreadyClosedError as SUCCESS', async () => {
    mockClose.mockRejectedValue(new CaseAlreadyClosedError('already closed'));
    expect(await resolveCaseAction(INPUT)).toEqual({ success: true });
  });

  it('does NOT publish a second time on the already-closed path', async () => {
    mockClose.mockRejectedValue(new CaseAlreadyClosedError('already closed'));
    await resolveCaseAction(INPUT);
    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockCreateToken).not.toHaveBeenCalled();
  });

  it('a real DOUBLE-SUBMIT closes once and emails once', async () => {
    // First submit wins the row lock; the second sees the guard and throws.
    mockClose
      .mockResolvedValueOnce({ closedAt: CLOSED_AT })
      .mockRejectedValueOnce(new CaseAlreadyClosedError('already closed'));

    const [first, second] = await Promise.all([resolveCaseAction(INPUT), resolveCaseAction(INPUT)]);

    expect(first).toEqual({ success: true });
    expect(second).toEqual({ success: true });
    expect(mockClose).toHaveBeenCalledTimes(2);
    // ⚠ THE LOAD-BEARING ASSERTION: one close, ONE email, ONE token.
    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockCreateToken).toHaveBeenCalledTimes(1);
  });

  it('still refreshes the page on the idempotent path', async () => {
    mockClose.mockRejectedValue(new CaseAlreadyClosedError('already closed'));
    await resolveCaseAction(INPUT);
    expect(mockRevalidate).toHaveBeenCalledWith('/meetings/' + MEETING_ID);
  });
});

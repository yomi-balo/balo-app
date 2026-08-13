import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

/**
 * BAL-421 — unit tests for the POST-COMMIT half of the case-close contract, at its OWN grain.
 *
 * ⚠⚠ COMPLEMENTARY TO, NOT A REPLACEMENT FOR, THE TWO ACTION SUITES. Both entry points
 * (`meetings/[meetingId]/_actions/resolve-case.test.ts` and
 * `cases/[engagementId]/_actions/resolve-case.test.ts`) drive this module through a whole
 * Server Action, which is the right shape for the ordering and the degradation claims. What
 * they cannot reach is the CONDITION set: the fallbacks on every optional read
 * (`company?.name ?? …`, `profile?.agencyId == null`, `agency?.name ?? null`), the
 * `errorCodeOf` narrowing ladder, and both sides of the held-meeting predicate. Each of those
 * is a distinct branch that decides what a real email says, and each gets its own case here.
 *
 * ⚠ EVERY FIXTURE THE MODULE READS CARRIES AN EMAIL-SHAPED FIELD IT MUST NOT COPY. The reads
 * are column-projected upstream; the assertions below serialize the whole payload and hunt for
 * an `@`, so a widened projection fails here rather than in production.
 */

vi.mock('server-only', () => ({}));

const mockFindLiveReview = vi.fn();
const mockCreateToken = vi.fn();
const mockListSiblings = vi.fn();
const mockFindCompanyName = vi.fn();
const mockFindProfile = vi.fn();
const mockFindUser = vi.fn();
const mockFindAgency = vi.fn();

vi.mock('@balo/db', () => ({
  reviewsRepository: { findLive: (...a: unknown[]) => mockFindLiveReview(...a) },
  reviewInviteTokensRepository: { create: (...a: unknown[]) => mockCreateToken(...a) },
  meetingContextsRepository: {
    listMeetingsForContext: (...a: unknown[]) => mockListSiblings(...a),
  },
  companiesRepository: { findNameById: (...a: unknown[]) => mockFindCompanyName(...a) },
  expertsRepository: { findDisplayProfileById: (...a: unknown[]) => mockFindProfile(...a) },
  usersRepository: { findDisplayById: (...a: unknown[]) => mockFindUser(...a) },
  agenciesRepository: { getSummaryById: (...a: unknown[]) => mockFindAgency(...a) },
}));

const mockPublish = vi.fn();
vi.mock('@/lib/notifications/publish', () => ({
  publishNotificationEvent: (...a: unknown[]) => mockPublish(...a),
}));

import {
  CASE_TITLE_MAX,
  capCaseTitle,
  publishCaseClosed,
  readCloseAnchors,
  readHeldConsultationCount,
  resolveReviewAsk,
  type PublishCaseClosedInput,
} from './close-case-effects';
import { log } from '@/lib/logging';

const ENGAGEMENT_ID = 'e0000000-0000-4000-8000-000000000001';
const REVIEWER_ID = 'u0000000-0000-4000-8000-000000000002';
const PROFILE_ID = 'p0000000-0000-4000-8000-000000000003';
const COMPANY_ID = 'c0000000-0000-4000-8000-000000000004';
const AGENCY_ID = 'a0000000-0000-4000-8000-000000000005';
const EXPERT_USER_ID = 'u0000000-0000-4000-8000-000000000006';
const CLOSED_AT = new Date('2026-08-12T09:00:00Z');

// ── fixtures ─────────────────────────────────────────────────────────────────────────────

interface SiblingOverrides {
  scheduledStart?: Date;
  startedAt?: Date | null;
  status?: string;
  outcome?: string | null;
}

/** A `listMeetingsForContext` row — full-fat, credentials included, as the repo hands it over. */
function sibling(id: string, over: SiblingOverrides = {}): Record<string, unknown> {
  return {
    id,
    scheduledStart: new Date('2026-07-01T10:00:00Z'),
    startedAt: new Date('2026-07-01T10:00:00Z'),
    status: 'ended',
    outcome: 'completed',
    joinUrl: 'https://balo.daily.co/room?t=SECRETJOINTOKEN',
    dailyRoomName: 'case-room-7f3a',
    ...over,
  };
}

function publishInput(over: Partial<PublishCaseClosedInput> = {}): PublishCaseClosedInput {
  return {
    engagementId: ENGAGEMENT_ID,
    meetingId: 'm0000000-0000-4000-8000-00000000000a',
    companyId: COMPANY_ID,
    expertProfileId: PROFILE_ID,
    caseTitle: 'Flow interview loop',
    closedAt: CLOSED_AT,
    recipientId: REVIEWER_ID,
    consultationCount: 2,
    reviewToken: 'raw-token',
    ...over,
  };
}

function publishedPayload(): Record<string, unknown> {
  const call = mockPublish.mock.calls[0];
  if (call === undefined) throw new Error('expected exactly one publish');
  const [, payload] = call as [string, Record<string, unknown>];
  return payload;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFindLiveReview.mockResolvedValue(undefined);
  mockCreateToken.mockResolvedValue({ id: 'tok-1' });
  mockListSiblings.mockResolvedValue([sibling('m1')]);
  mockFindCompanyName.mockResolvedValue({ id: COMPANY_ID, name: 'Northwind Industrial' });
  mockFindProfile.mockResolvedValue({
    id: PROFILE_ID,
    userId: EXPERT_USER_ID,
    agencyId: null,
    type: 'freelancer',
  });
  mockFindUser.mockResolvedValue({
    id: EXPERT_USER_ID,
    firstName: 'Amara',
    lastName: 'Okafor',
    avatarUrl: null,
  });
  mockFindAgency.mockResolvedValue(undefined);
  mockPublish.mockResolvedValue(undefined);
});

// ── capCaseTitle ─────────────────────────────────────────────────────────────────────────

describe('capCaseTitle — both sides of the cap', () => {
  it('passes an under-cap title through byte for byte', () => {
    expect(capCaseTitle('Flow interview loop')).toBe('Flow interview loop');
  });

  it('passes a title of EXACTLY the cap through unchanged', () => {
    const exact = 'x'.repeat(CASE_TITLE_MAX);
    expect(capCaseTitle(exact)).toBe(exact);
  });

  /**
   * The publish schema caps at 200 and `publishNotificationEvent` SWALLOWS a 400 — so an
   * uncapped long title would mean no close email at all, not a long subject line.
   */
  it('truncates one character over the cap, with an ellipsis in the last position', () => {
    const capped = capCaseTitle('y'.repeat(CASE_TITLE_MAX + 1));
    expect(capped).toHaveLength(CASE_TITLE_MAX);
    expect(capped.endsWith('…')).toBe(true);
    expect(capped.startsWith('yyy')).toBe(true);
  });
});

// ── resolveReviewAsk ─────────────────────────────────────────────────────────────────────

describe('resolveReviewAsk — mints once, degrades always', () => {
  it('mints a raw token and pins the hash to sha256-hex through the SHARED helper', async () => {
    const token = await resolveReviewAsk(ENGAGEMENT_ID, PROFILE_ID, REVIEWER_ID);

    if (typeof token !== 'string') throw new Error('expected a raw review token');
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(mockCreateToken).toHaveBeenCalledWith({
      engagementId: ENGAGEMENT_ID,
      reviewerUserId: REVIEWER_ID,
      // Mint and verify must agree on the algorithm FOREVER — a drift here renders every
      // emailed star row dead in production with CI fully green.
      tokenHash: createHash('sha256').update(token).digest('hex'),
    });
    expect(mockFindLiveReview).toHaveBeenCalledWith(ENGAGEMENT_ID, REVIEWER_ID, PROFILE_ID);
  });

  it('returns NO token — and mints nothing — when the member already rated this expert', async () => {
    mockFindLiveReview.mockResolvedValue({ id: 'rev-1', rating: 5 });

    expect(await resolveReviewAsk(ENGAGEMENT_ID, PROFILE_ID, REVIEWER_ID)).toBeUndefined();
    expect(mockCreateToken).not.toHaveBeenCalled();
  });

  it('degrades a REJECTING existing-review read to no token — the close already committed', async () => {
    mockFindLiveReview.mockRejectedValue(new Error('connection terminated'));

    expect(await resolveReviewAsk(ENGAGEMENT_ID, PROFILE_ID, REVIEWER_ID)).toBeUndefined();
    expect(mockCreateToken).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalled();
  });

  it('degrades a REJECTING mint to no token', async () => {
    mockCreateToken.mockRejectedValue(new Error('db down'));

    expect(await resolveReviewAsk(ENGAGEMENT_ID, PROFILE_ID, REVIEWER_ID)).toBeUndefined();
    expect(log.error).toHaveBeenCalled();
  });
});

/**
 * ⚠⚠ THE FAILING STATEMENT'S BOUND PARAMS INCLUDE THE SHA-256 TOKEN HASH, and drizzle-orm
 * interpolates bound params into `DrizzleQueryError.message` — which `stack` then repeats
 * verbatim. That is why THIS catch logs `name` / `code` and NOT `message` or `stack`. Each
 * rung of the `errorCodeOf` narrowing ladder gets its own case, because a "tidied" catch is
 * the exact mechanism by which a live token hash starts flowing into Axiom with no visible
 * defect anywhere.
 */
describe('resolveReviewAsk — the HARDENED catch never quotes the statement', () => {
  function loggedPayload(): Record<string, unknown> {
    const call = vi.mocked(log.error).mock.calls[0];
    if (call === undefined) throw new Error('expected an error log');
    const [, payload] = call as [string, Record<string, unknown>];
    return payload;
  }

  it('logs NEITHER message NOR stack, even when both carry the hash', async () => {
    const leaky = new Error('insert into review_invite_tokens … $2 = deadbeefTOKENHASH');
    mockCreateToken.mockRejectedValue(leaky);

    await resolveReviewAsk(ENGAGEMENT_ID, PROFILE_ID, REVIEWER_ID);

    const payload = loggedPayload();
    expect(payload).toEqual({
      engagementId: ENGAGEMENT_ID,
      userId: REVIEWER_ID,
      errorName: 'Error',
      errorCode: undefined,
    });
    expect(JSON.stringify(payload)).not.toContain('deadbeefTOKENHASH');
  });

  it('routes a driver error by its STRING code', async () => {
    mockCreateToken.mockRejectedValue(Object.assign(new Error('dup'), { code: '23505' }));

    await resolveReviewAsk(ENGAGEMENT_ID, PROFILE_ID, REVIEWER_ID);

    expect(loggedPayload()).toMatchObject({ errorName: 'Error', errorCode: '23505' });
  });

  it('ignores a NON-STRING code rather than coercing it', async () => {
    mockCreateToken.mockRejectedValue(Object.assign(new Error('dup'), { code: 23505 }));

    await resolveReviewAsk(ENGAGEMENT_ID, PROFILE_ID, REVIEWER_ID);

    expect(loggedPayload().errorCode).toBeUndefined();
  });

  it('handles a NON-OBJECT throw — errorName is the typeof, code is absent', async () => {
    mockCreateToken.mockRejectedValue('everything is on fire');

    await resolveReviewAsk(ENGAGEMENT_ID, PROFILE_ID, REVIEWER_ID);

    expect(loggedPayload()).toMatchObject({ errorName: 'string', errorCode: undefined });
  });

  it('handles a NULL throw without dereferencing it', async () => {
    // `typeof null === 'object'`, so the null guard is the ONLY thing between this and a crash.
    mockCreateToken.mockRejectedValue(null);

    await resolveReviewAsk(ENGAGEMENT_ID, PROFILE_ID, REVIEWER_ID);

    expect(loggedPayload()).toMatchObject({ errorName: 'object', errorCode: undefined });
  });

  it('handles a plain object with no code at all', async () => {
    mockCreateToken.mockRejectedValue({ detail: 'no code here' });

    await resolveReviewAsk(ENGAGEMENT_ID, PROFILE_ID, REVIEWER_ID);

    expect(loggedPayload()).toMatchObject({ errorName: 'object', errorCode: undefined });
  });
});

// ── the sibling derivations ──────────────────────────────────────────────────────────────

describe('readCloseAnchors / readHeldConsultationCount — ONE read, two PURE derivations', () => {
  it('reads the case sibling set exactly once, on the `case` context arm', async () => {
    mockListSiblings.mockResolvedValue([sibling('m1'), sibling('m2')]);

    const anchors = await readCloseAnchors(ENGAGEMENT_ID);

    expect(mockListSiblings).toHaveBeenCalledTimes(1);
    expect(mockListSiblings).toHaveBeenCalledWith('case', ENGAGEMENT_ID);
    expect(anchors).toEqual({ heldCount: 2, anchorMeetingId: 'm2' });
  });

  it('anchors to the MOST RECENT held consultation, not the last row returned', async () => {
    mockListSiblings.mockResolvedValue([
      sibling('m-new', { startedAt: new Date('2026-07-08T10:00:00Z') }),
      sibling('m-old', { startedAt: new Date('2026-07-01T10:00:00Z') }),
    ]);

    expect((await readCloseAnchors(ENGAGEMENT_ID)).anchorMeetingId).toBe('m-new');
  });

  it('falls back to scheduledStart for a held meeting with NO startedAt stamp', async () => {
    mockListSiblings.mockResolvedValue([
      sibling('m-scheduled-late', {
        startedAt: null,
        scheduledStart: new Date('2026-07-20T10:00:00Z'),
      }),
      sibling('m-started-early', { startedAt: new Date('2026-07-05T10:00:00Z') }),
    ]);

    expect((await readCloseAnchors(ENGAGEMENT_ID)).anchorMeetingId).toBe('m-scheduled-late');
  });

  it('breaks an exact timestamp tie on id, so the CTA is stable across refreshes', async () => {
    const sameInstant = new Date('2026-07-09T10:00:00Z');
    mockListSiblings.mockResolvedValue([
      sibling('aaa', { startedAt: sameInstant }),
      sibling('zzz', { startedAt: sameInstant }),
    ]);

    expect((await readCloseAnchors(ENGAGEMENT_ID)).anchorMeetingId).toBe('zzz');
  });

  /** Both sides of `status === 'ended' && outcome === 'completed'` get their own row. */
  it('counts and anchors ONLY on ended+completed — never a cancelled or no-show slot', async () => {
    mockListSiblings.mockResolvedValue([
      sibling('m-held', { startedAt: new Date('2026-07-01T10:00:00Z') }),
      // ended, but the call did not happen — `status` matches, `outcome` does not
      sibling('m-noshow', {
        startedAt: new Date('2026-07-05T10:00:00Z'),
        outcome: 'no_show_client',
      }),
      // completed outcome, but never reached `ended`
      sibling('m-inprogress', {
        startedAt: new Date('2026-07-06T10:00:00Z'),
        status: 'in_progress',
      }),
    ]);

    expect(await readCloseAnchors(ENGAGEMENT_ID)).toEqual({
      heldCount: 1,
      anchorMeetingId: 'm-held',
    });
  });

  it('emits NO anchor for a case closed before anything was ever held', async () => {
    mockListSiblings.mockResolvedValue([]);

    expect(await readCloseAnchors(ENGAGEMENT_ID)).toEqual({
      heldCount: 0,
      anchorMeetingId: undefined,
    });
  });

  it('degrades a REJECTING sibling read to zero and no anchor — it runs POST-COMMIT', async () => {
    mockListSiblings.mockRejectedValue(new Error('connection terminated'));

    expect(await readCloseAnchors(ENGAGEMENT_ID)).toEqual({
      heldCount: 0,
      anchorMeetingId: undefined,
    });
  });

  it('readHeldConsultationCount answers the count alone, from the same read', async () => {
    mockListSiblings.mockResolvedValue([
      sibling('m1'),
      sibling('m2'),
      sibling('m3', { status: 'cancelled', outcome: undefined }),
    ]);

    expect(await readHeldConsultationCount(ENGAGEMENT_ID)).toBe(2);
    expect(mockListSiblings).toHaveBeenCalledTimes(1);
  });

  it('readHeldConsultationCount degrades a rejecting read to 0', async () => {
    mockListSiblings.mockRejectedValue(new Error('db down'));

    expect(await readHeldConsultationCount(ENGAGEMENT_ID)).toBe(0);
  });

  it('lets NO meeting row escape — no joinUrl, no dailyRoomName in the derived answer', async () => {
    mockListSiblings.mockResolvedValue([sibling('m1')]);

    const anchors = await readCloseAnchors(ENGAGEMENT_ID);

    const serialized = JSON.stringify(anchors);
    expect(serialized).not.toContain('SECRETJOINTOKEN');
    expect(serialized).not.toContain('case-room-7f3a');
  });
});

// ── publishCaseClosed — one fallback per optional read ───────────────────────────────────

describe('publishCaseClosed — the party labels, one branch per optional read', () => {
  it('publishes the honest reason with the resolved company and freelancer name', async () => {
    await publishCaseClosed(publishInput());

    const [event] = mockPublish.mock.calls[0] as [string, Record<string, unknown>];
    expect(event).toBe('engagement.case_closed');
    expect(publishedPayload()).toEqual({
      correlationId: ENGAGEMENT_ID + ':case_closed',
      engagementId: ENGAGEMENT_ID,
      meetingId: 'm0000000-0000-4000-8000-00000000000a',
      recipientId: REVIEWER_ID,
      expertProfileId: PROFILE_ID,
      clientCompanyName: 'Northwind Industrial',
      expertPartyLabel: 'Amara Okafor',
      caseTitle: 'Flow interview loop',
      closedDate: '12 Aug 2026',
      closeReason: 'resolved',
      consultationCount: 2,
      reviewToken: 'raw-token',
    });
  });

  it('falls back to "your company" when the company name read comes back empty', async () => {
    mockFindCompanyName.mockResolvedValue(undefined);

    await publishCaseClosed(publishInput());

    expect(publishedPayload().clientCompanyName).toBe('your company');
  });

  /**
   * ⚠ A MISSING PROFILE SHORT-CIRCUITS **BOTH** SECOND-WAVE READS. Neither the expert user nor
   * the agency can be resolved without it, and neither lookup may be issued with `undefined`.
   */
  it('issues NO expert-user and NO agency read when the profile is missing, and still publishes', async () => {
    mockFindProfile.mockResolvedValue(undefined);

    await publishCaseClosed(publishInput());

    expect(mockFindUser).not.toHaveBeenCalled();
    expect(mockFindAgency).not.toHaveBeenCalled();
    expect(publishedPayload().expertPartyLabel).toBe('An expert');
  });

  it('issues NO agency read for an INDEPENDENT expert (null agencyId)', async () => {
    await publishCaseClosed(publishInput());

    expect(mockFindUser).toHaveBeenCalledWith(EXPERT_USER_ID);
    expect(mockFindAgency).not.toHaveBeenCalled();
  });

  it('names the AGENCY when the profile is agency-typed and the agency resolves', async () => {
    mockFindProfile.mockResolvedValue({
      id: PROFILE_ID,
      userId: EXPERT_USER_ID,
      agencyId: AGENCY_ID,
      type: 'agency',
    });
    mockFindAgency.mockResolvedValue({ id: AGENCY_ID, name: 'CloudPeak' });

    await publishCaseClosed(publishInput());

    expect(mockFindAgency).toHaveBeenCalledWith(AGENCY_ID);
    expect(publishedPayload().expertPartyLabel).toBe('CloudPeak');
  });

  it('falls back to the PERSON when an agency-typed profile has no resolvable agency', async () => {
    mockFindProfile.mockResolvedValue({
      id: PROFILE_ID,
      userId: EXPERT_USER_ID,
      agencyId: AGENCY_ID,
      type: 'agency',
    });
    mockFindAgency.mockResolvedValue(undefined);

    await publishCaseClosed(publishInput());

    expect(mockFindAgency).toHaveBeenCalledWith(AGENCY_ID);
    expect(publishedPayload().expertPartyLabel).toBe('Amara Okafor');
  });

  it('falls back to "An expert" when the profile resolves but the person does not', async () => {
    mockFindUser.mockResolvedValue(undefined);

    await publishCaseClosed(publishInput());

    expect(publishedPayload().expertPartyLabel).toBe('An expert');
  });

  it('renders a first-name-only person without an empty trailing space', async () => {
    mockFindUser.mockResolvedValue({
      id: EXPERT_USER_ID,
      firstName: 'Amara',
      lastName: null,
      avatarUrl: null,
    });

    await publishCaseClosed(publishInput());

    expect(publishedPayload().expertPartyLabel).toBe('Amara');
  });

  it('carries NO meetingId when the case had no held consultation — never a dead link', async () => {
    await publishCaseClosed(publishInput({ meetingId: undefined }));

    expect(publishedPayload().meetingId).toBeUndefined();
    expect(publishedPayload().engagementId).toBe(ENGAGEMENT_ID);
  });

  it('carries NO reviewToken when the mint degraded', async () => {
    await publishCaseClosed(publishInput({ reviewToken: undefined }));

    expect(publishedPayload().reviewToken).toBeUndefined();
  });

  it('leaks no email address and no avatar key into the payload', async () => {
    mockFindUser.mockResolvedValue({
      id: EXPERT_USER_ID,
      firstName: 'Amara',
      lastName: 'Okafor',
      avatarUrl: 'avatars/amara-SECRETAVATARKEY.png',
    });

    await publishCaseClosed(publishInput());

    const serialized = JSON.stringify(publishedPayload());
    expect(serialized).not.toContain('@');
    expect(serialized).not.toContain('SECRETAVATARKEY');
  });

  /** Fire-and-forget by contract — a transport failure must never fail a committed close. */
  it('swallows a REJECTING publish transport and resolves normally', async () => {
    mockPublish.mockRejectedValue(new Error('api unreachable'));

    await expect(publishCaseClosed(publishInput())).resolves.toBeUndefined();
    expect(mockPublish).toHaveBeenCalledTimes(1);
  });
});

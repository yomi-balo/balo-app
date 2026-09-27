import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRequireOnboardedUser = vi.fn();
const mockFindByBookingIdempotencyKey = vi.fn();
const mockMeetingFindByKey = vi.fn();
const mockMeetingFindWithContexts = vi.fn();
const mockCreate = vi.fn();
const mockListOpenForCompanyAndExpert = vi.fn();
const mockListCapabilityEligibleCompanies = vi.fn();
const mockFindNameById = vi.fn();
const mockCountByActorAndActionSince = vi.fn();
const mockGetSalesforceVertical = vi.fn();
const mockGetProductsByVertical = vi.fn();
const mockIsUniqueViolation = vi.fn();
const mockDeriveBookingIdempotencyKey = vi.fn();
const mockSanitizeCaseDescription = vi.fn();
const mockAuthorizeCaseAttach = vi.fn();
const mockResolveBookingExpertDisplay = vi.fn();
const mockPostBookMeeting = vi.fn();
const mockViewerApiCredentialIsLive = vi.fn();
const mockPostInviteGuests = vi.fn();
const mockPublishNotificationEvent = vi.fn();
const mockLogInfo = vi.fn();
const mockLogWarn = vi.fn();
const mockLogError = vi.fn();
const mockEnforceBookingFunding = vi.fn();

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth/session', () => ({
  requireOnboardedUser: (...args: unknown[]) => mockRequireOnboardedUser(...args),
}));
vi.mock('@balo/db', () => ({
  auditEventsRepository: {
    countByActorAndActionSince: (...args: unknown[]) => mockCountByActorAndActionSince(...args),
  },
  referenceDataRepository: {
    getSalesforceVertical: (...args: unknown[]) => mockGetSalesforceVertical(...args),
    getProductsByVertical: (...args: unknown[]) => mockGetProductsByVertical(...args),
  },
  caseEngagementsRepository: {
    findByBookingIdempotencyKey: (...args: unknown[]) => mockFindByBookingIdempotencyKey(...args),
    create: (...args: unknown[]) => mockCreate(...args),
    listOpenForCompanyAndExpert: (...args: unknown[]) => mockListOpenForCompanyAndExpert(...args),
  },
  companiesRepository: {
    findNameById: (...args: unknown[]) => mockFindNameById(...args),
  },
  meetingsRepository: {
    findByBookingIdempotencyKey: (...args: unknown[]) => mockMeetingFindByKey(...args),
    findWithContexts: (...args: unknown[]) => mockMeetingFindWithContexts(...args),
  },
  partyMembershipsRepository: {
    listCapabilityEligibleCompanies: (...args: unknown[]) =>
      mockListCapabilityEligibleCompanies(...args),
  },
  isUniqueViolation: (...args: unknown[]) => mockIsUniqueViolation(...args),
}));
vi.mock('@/lib/authz', () => ({
  CAPABILITIES: { CONSUME_CREDITS: 'consume_credits' },
}));
vi.mock('@/lib/logging', () => ({
  log: {
    info: (...args: unknown[]) => mockLogInfo(...args),
    warn: (...args: unknown[]) => mockLogWarn(...args),
    error: (...args: unknown[]) => mockLogError(...args),
  },
}));
vi.mock('@/lib/notifications/publish', () => ({
  publishNotificationEvent: (...args: unknown[]) => mockPublishNotificationEvent(...args),
}));
vi.mock('../booking-idempotency', () => ({
  deriveBookingIdempotencyKey: (...args: unknown[]) => mockDeriveBookingIdempotencyKey(...args),
}));
vi.mock('../sanitize-case-description', () => ({
  sanitizeCaseDescription: (...args: unknown[]) => mockSanitizeCaseDescription(...args),
}));
vi.mock('../authorize-case-attach', () => ({
  authorizeCaseAttach: (...args: unknown[]) => mockAuthorizeCaseAttach(...args),
}));
vi.mock('../booking-funding-gate', () => ({
  enforceBookingFunding: (...args: unknown[]) => mockEnforceBookingFunding(...args),
}));
vi.mock('../load-booking-context', () => ({
  resolveBookingExpertDisplay: (...args: unknown[]) => mockResolveBookingExpertDisplay(...args),
}));
/**
 * ⚠ PARTIAL BY `importActual`: only the two network calls are replaced. The api's funding-refusal
 * literals and their guard (`isBookingFundingRefusalCode`) stay REAL, so the action's routing of
 * a hop-2 `409` is tested against the shipped list, not a copy of it.
 */
vi.mock('../booking-api-client', async (importActual) => ({
  ...(await importActual<typeof import('../booking-api-client')>()),
  postBookMeeting: (...args: unknown[]) => mockPostBookMeeting(...args),
  postInviteGuests: (...args: unknown[]) => mockPostInviteGuests(...args),
}));
/**
 * ⚠ PARTIAL BY `importActual`, NOT A HAND-WRITTEN STUB. Only the session-reading
 * `viewerApiCredentialIsLive` is replaced; `isExpiredCredentialFailure` stays REAL so the 401
 * mapping is exercised against the shipped classifier — including its account-refusal
 * exclusion — rather than a second copy of the rule that could drift from it.
 */
vi.mock('@/lib/api/balo-api-client', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/api/balo-api-client')>()),
  viewerApiCredentialIsLive: (...args: unknown[]) => mockViewerApiCredentialIsLive(...args),
}));

import { bookConsultationAction } from './book-consultation';
import type { BookConsultationInput } from './types';

const ACTIVE_COMPANY_ID = '55555555-5555-4555-8555-555555555555';
const USER = { id: 'user-1', onboardingCompleted: true, companyId: ACTIVE_COMPANY_ID };
const KEY = 'a'.repeat(64);
const EXPERT_PROFILE_ID = '11111111-1111-4111-8111-111111111111';
const MEETING_ID = '22222222-2222-4222-8222-222222222222';
const COMPANY_ID = '33333333-3333-4333-8333-333333333333';
const ENGAGEMENT_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_EXPERT_PROFILE_ID = '99999999-9999-4999-8999-999999999999';
const OTHER_COMPANY_ID = '88888888-8888-4888-8888-888888888888';
const PRODUCT_ID = '77777777-7777-4777-8777-777777777777';
/** ⚠ THE SERVER'S window — deliberately NOT the slot `NEW_CASE_INPUT` submits. */
const SERVER_START = '2026-09-01T06:00:00.000Z';
const SERVER_END = '2026-09-01T06:45:00.000Z';

const NEW_CASE_INPUT: BookConsultationInput = {
  expertProfileId: EXPERT_PROFILE_ID,
  slot: {
    startIso: '2026-09-01T04:00:00.000Z',
    endIso: '2026-09-01T04:30:00.000Z',
    durationMinutes: 30,
  },
  bookingNonce: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  guests: [],
  caseChoice: {
    kind: 'new',
    title: 'Need help with a flow',
    descriptionHtml: '<p>A real problem statement.</p>',
    productIds: [],
  },
};

const EXISTING_CASE_INPUT: BookConsultationInput = {
  ...NEW_CASE_INPUT,
  caseChoice: { kind: 'existing', engagementId: ENGAGEMENT_ID },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireOnboardedUser.mockResolvedValue(USER);
  mockDeriveBookingIdempotencyKey.mockReturnValue(KEY);
  mockSanitizeCaseDescription.mockReturnValue({ ok: true, html: '<p>sanitised</p>' });
  mockFindByBookingIdempotencyKey.mockResolvedValue(undefined);
  mockMeetingFindByKey.mockResolvedValue(undefined);
  mockMeetingFindWithContexts.mockResolvedValue(undefined);
  mockListCapabilityEligibleCompanies.mockResolvedValue([
    { id: COMPANY_ID, name: 'Northwind', logoUrl: null },
  ]);
  mockCreate.mockResolvedValue({
    id: ENGAGEMENT_ID,
    companyId: COMPANY_ID,
    expertProfileId: EXPERT_PROFILE_ID,
    title: 'Need help with a flow',
  });
  mockAuthorizeCaseAttach.mockResolvedValue({
    ok: true,
    engagementId: ENGAGEMENT_ID,
    companyId: COMPANY_ID,
    expertProfileId: EXPERT_PROFILE_ID,
    title: 'Existing case',
  });
  mockCountByActorAndActionSince.mockResolvedValue(0);
  mockGetSalesforceVertical.mockResolvedValue({ id: 'vertical-1' });
  mockGetProductsByVertical.mockResolvedValue([{ products: [{ id: PRODUCT_ID }] }]);
  mockViewerApiCredentialIsLive.mockResolvedValue(true);
  mockPostBookMeeting.mockResolvedValue({
    ok: true,
    data: {
      meetingId: MEETING_ID,
      scheduledStart: SERVER_START,
      scheduledEnd: SERVER_END,
      provisioned: true,
    },
  });
  mockPostInviteGuests.mockResolvedValue({ ok: true, data: { invitedCount: 0 } });
  mockFindNameById.mockResolvedValue({ id: COMPANY_ID, name: 'Northwind' });
  mockResolveBookingExpertDisplay.mockResolvedValue({
    firstName: 'Dana',
    partyLabel: 'Dana Okoro',
  });
  mockListOpenForCompanyAndExpert.mockResolvedValue({ openCases: [], resolvedCaseCount: 0 });
  mockEnforceBookingFunding.mockResolvedValue({ ok: true });
});

describe('bookConsultationAction', () => {
  it('always authenticates via requireOnboardedUser (the mutation gate)', async () => {
    await bookConsultationAction(NEW_CASE_INPUT);
    expect(mockRequireOnboardedUser).toHaveBeenCalledTimes(1);
  });

  it('new-case happy path: creates the case, books the meeting, publishes booking.confirmed', async () => {
    const result = await bookConsultationAction(NEW_CASE_INPUT);
    expect(result).toEqual({
      ok: true,
      engagementId: ENGAGEMENT_ID,
      meetingId: MEETING_ID,
      joinPath: `/meetings/${MEETING_ID}/call`,
      provisioned: true,
      isNewCase: true,
      caseTitle: 'Need help with a flow',
      scheduledStartIso: SERVER_START,
      scheduledEndIso: SERVER_END,
      durationMinutes: 45,
      guestsInvited: 0,
      guestInviteFailed: false,
    });
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: COMPANY_ID,
        expertProfileId: EXPERT_PROFILE_ID,
        bookingIdempotencyKey: KEY,
        actorUserId: 'user-1',
      })
    );
    expect(mockPublishNotificationEvent).toHaveBeenCalledWith(
      'booking.confirmed',
      expect.objectContaining({
        correlationId: MEETING_ID,
        meetingId: MEETING_ID,
        engagementId: ENGAGEMENT_ID,
        recipientId: 'user-1',
        isNewCase: true,
        provisioned: true,
      })
    );
  });

  it('attach happy path: no case write, publishes with isNewCase:false', async () => {
    const result = await bookConsultationAction(EXISTING_CASE_INPUT);
    expect(result).toEqual({
      ok: true,
      engagementId: ENGAGEMENT_ID,
      meetingId: MEETING_ID,
      joinPath: `/meetings/${MEETING_ID}/call`,
      provisioned: true,
      isNewCase: false,
      caseTitle: 'Existing case',
      scheduledStartIso: SERVER_START,
      scheduledEndIso: SERVER_END,
      durationMinutes: 45,
      guestsInvited: 0,
      guestInviteFailed: false,
    });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockAuthorizeCaseAttach).toHaveBeenCalledWith({
      actorUserId: 'user-1',
      engagementId: ENGAGEMENT_ID,
      expertProfileId: EXPERT_PROFILE_ID,
    });
    expect(mockPublishNotificationEvent).toHaveBeenCalledWith(
      'booking.confirmed',
      expect.objectContaining({ isNewCase: false })
    );
  });

  /**
   * BAL-567 — the `joinPath` this action RETURNS and the one it PUBLISHES are both the MEMBER
   * CALL route; neither is the anonymous lobby any more.
   *
   * ⚠ THE NEGATIVE COMPANION IS NOT DECORATION, and neither is checking both halves. The
   * positive assertion alone stays green against a producer that fixed only the return value
   * and left the PUBLISHED payload on `/join/m/` — which is exactly the failure that matters,
   * because `memberCallPathSchema` in `apps/api` would then 400 the publish in production with
   * nothing red in CI. `book-consultation.ts` builds the path at TWO separate call sites, so
   * one of them regressing is a real shape, not a hypothetical.
   */
  it('BAL-567 — returns AND publishes the member CALL route, never the anonymous lobby', async () => {
    const result = await bookConsultationAction(NEW_CASE_INPUT);

    expect(result.ok).toBe(true);
    const returnedJoinPath = result.ok ? result.joinPath : '';
    expect(returnedJoinPath).toBe(`/meetings/${MEETING_ID}/call`);
    expect(returnedJoinPath).not.toContain('/join/m/');

    const [firstPublish] = mockPublishNotificationEvent.mock.calls;
    expect(firstPublish).toBeDefined();
    const publishedJoinPath = (firstPublish?.[1] as { joinPath: string } | undefined)?.joinPath;
    expect(publishedJoinPath).toBe(`/meetings/${MEETING_ID}/call`);
    expect(publishedJoinPath).not.toContain('/join/m/');
  });

  it("reports priorConsultationCount EXCLUDING this booking's own meeting", async () => {
    // `consultationCount` counts LIVE MEETINGS, and by the time `POST /meetings` has returned
    // the meeting from THIS booking is already in it. The repository therefore reports 3 for a
    // case that had 2 before today, and the expert's email must say 2.
    mockListOpenForCompanyAndExpert.mockResolvedValue({
      openCases: [{ engagementId: ENGAGEMENT_ID, consultationCount: 3 }],
      resolvedCaseCount: 0,
    });

    await bookConsultationAction(EXISTING_CASE_INPUT);

    expect(mockPublishNotificationEvent).toHaveBeenCalledWith(
      'booking.confirmed',
      expect.objectContaining({ priorConsultationCount: 2 })
    );
  });

  it('never publishes a NEGATIVE priorConsultationCount if the projection lags', async () => {
    mockListOpenForCompanyAndExpert.mockResolvedValue({
      openCases: [{ engagementId: ENGAGEMENT_ID, consultationCount: 0 }],
      resolvedCaseCount: 0,
    });

    await bookConsultationAction(EXISTING_CASE_INPUT);

    expect(mockPublishNotificationEvent).toHaveBeenCalledWith(
      'booking.confirmed',
      expect.objectContaining({ priorConsultationCount: 0 })
    );
  });

  it('reads the consultation count AFTER the meeting hop, never before', async () => {
    // The ordering IS the fix. A pre-hop read returns `prior + 1` on a lost-201 retry, because
    // the first attempt's meeting already exists — and the email then over-counts by one.
    const order: string[] = [];
    mockPostBookMeeting.mockImplementation(async () => {
      order.push('meeting-hop');
      return {
        ok: true,
        data: {
          meetingId: MEETING_ID,
          scheduledStart: SERVER_START,
          scheduledEnd: SERVER_END,
          provisioned: true,
        },
      };
    });
    mockListOpenForCompanyAndExpert.mockImplementation(async () => {
      order.push('count-read');
      return {
        openCases: [{ engagementId: ENGAGEMENT_ID, consultationCount: 1 }],
        resolvedCaseCount: 0,
      };
    });

    await bookConsultationAction(EXISTING_CASE_INPUT);

    expect(order).toEqual(['meeting-hop', 'count-read']);
  });

  it('denies the attach arm with the single case_not_available literal', async () => {
    mockAuthorizeCaseAttach.mockResolvedValue({ ok: false, code: 'case_not_available' });
    const result = await bookConsultationAction(EXISTING_CASE_INPUT);
    expect(result).toEqual({ ok: false, stage: 'case', code: 'case_not_available' });
    expect(mockPostBookMeeting).not.toHaveBeenCalled();
  });

  it('idempotent re-entry finds the existing case and does NOT create a second one', async () => {
    mockFindByBookingIdempotencyKey.mockResolvedValue({
      id: ENGAGEMENT_ID,
      companyId: COMPANY_ID,
      expertProfileId: EXPERT_PROFILE_ID,
      title: 'Already created case',
    });
    mockAuthorizeCaseAttach.mockResolvedValue({
      ok: true,
      engagementId: ENGAGEMENT_ID,
      companyId: COMPANY_ID,
      expertProfileId: EXPERT_PROFILE_ID,
      title: 'Already created case',
    });
    const result = await bookConsultationAction(NEW_CASE_INPUT);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockListCapabilityEligibleCompanies).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, engagementId: ENGAGEMENT_ID, isNewCase: true });
  });

  // ── S1/M5 regression: the case-grain replay is a GATE, not a lookup ───────
  //
  // `bookingNonce` is client-supplied, so a spent key can be re-submitted with a DIFFERENT
  // claimed expert. Before this gate, the branch returned the case with no capability check,
  // no company check and no expert check — and `booking.confirmed` was then published with
  // the CLIENT'S `expertProfileId`, delivering a Balo-branded email carrying a live
  // `meetingId` to an arbitrary marketplace expert who was not party to the booking.

  it('the replay branch REFUSES a key whose case names a different expert (S1)', async () => {
    mockFindByBookingIdempotencyKey.mockResolvedValue({
      id: ENGAGEMENT_ID,
      companyId: COMPANY_ID,
      expertProfileId: EXPERT_PROFILE_ID,
      title: 'Already created case',
    });
    // The row names EXPERT_PROFILE_ID; the resubmit claims someone else, so the shared gate
    // denies on `expert_mismatch` and collapses to the one wire literal.
    mockAuthorizeCaseAttach.mockResolvedValue({ ok: false, code: 'case_not_available' });

    const result = await bookConsultationAction({
      ...NEW_CASE_INPUT,
      expertProfileId: OTHER_EXPERT_PROFILE_ID,
    });

    expect(result).toEqual({ ok: false, stage: 'case', code: 'case_not_available' });
    expect(mockPostBookMeeting).not.toHaveBeenCalled();
    expect(mockPublishNotificationEvent).not.toHaveBeenCalled();
  });

  it('the replay branch runs the SAME gate the attach arm does, on the row it found', async () => {
    mockFindByBookingIdempotencyKey.mockResolvedValue({
      id: ENGAGEMENT_ID,
      companyId: COMPANY_ID,
      expertProfileId: EXPERT_PROFILE_ID,
      title: 'Already created case',
    });
    await bookConsultationAction(NEW_CASE_INPUT);
    expect(mockAuthorizeCaseAttach).toHaveBeenCalledWith({
      actorUserId: 'user-1',
      engagementId: ENGAGEMENT_ID,
      expertProfileId: EXPERT_PROFILE_ID,
    });
  });

  it('publishes the SERVER-RESOLVED expert, never the claimed one (S1)', async () => {
    // The gate passes (a benign re-entry), but the ROW names a different expert than the
    // request. Nothing downstream may read the request's value.
    mockFindByBookingIdempotencyKey.mockResolvedValue({
      id: ENGAGEMENT_ID,
      companyId: COMPANY_ID,
      expertProfileId: EXPERT_PROFILE_ID,
      title: 'Already created case',
    });
    mockAuthorizeCaseAttach.mockResolvedValue({
      ok: true,
      engagementId: ENGAGEMENT_ID,
      companyId: COMPANY_ID,
      expertProfileId: EXPERT_PROFILE_ID,
      title: 'Already created case',
    });

    await bookConsultationAction({
      ...NEW_CASE_INPUT,
      expertProfileId: OTHER_EXPERT_PROFILE_ID,
    });

    expect(mockResolveBookingExpertDisplay).toHaveBeenCalledWith(EXPERT_PROFILE_ID);
    expect(mockPublishNotificationEvent).toHaveBeenCalledWith(
      'booking.confirmed',
      expect.objectContaining({ expertProfileId: EXPERT_PROFILE_ID })
    );
    const [, payload] = mockPublishNotificationEvent.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(payload.expertProfileId).not.toBe(OTHER_EXPERT_PROFILE_ID);
  });

  // ── S2 regression: the window is the SERVER'S ────────────────────────────

  it('reports the SERVER window and duration, not the submitted slot (S2)', async () => {
    const result = await bookConsultationAction(NEW_CASE_INPUT);
    // The input slot is 04:00→04:30 (30 min); the api answered 06:00→06:45 (45 min).
    expect(result).toMatchObject({
      ok: true,
      scheduledStartIso: SERVER_START,
      scheduledEndIso: SERVER_END,
      durationMinutes: 45,
    });
    expect(mockPublishNotificationEvent).toHaveBeenCalledWith(
      'booking.confirmed',
      expect.objectContaining({ scheduledStartIso: SERVER_START, durationMinutes: 45 })
    );
  });

  it('never notifies the submitted slot, even though it was what was asked for (S2)', async () => {
    await bookConsultationAction(NEW_CASE_INPUT);
    const [, payload] = mockPublishNotificationEvent.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(payload.scheduledStartIso).not.toBe('2026-09-01T04:00:00.000Z');
    expect(payload.durationMinutes).not.toBe(30);
  });

  it('a concurrent double-submit (23505) re-reads by key — THROUGH the gate — instead of failing', async () => {
    mockCreate.mockRejectedValue(new Error('duplicate key value'));
    mockIsUniqueViolation.mockReturnValue(true);
    mockFindByBookingIdempotencyKey
      .mockResolvedValueOnce(undefined) // first read: not found, so we attempt create
      .mockResolvedValueOnce({
        id: ENGAGEMENT_ID,
        companyId: COMPANY_ID,
        expertProfileId: EXPERT_PROFILE_ID,
        title: 'Raced case',
      });
    mockAuthorizeCaseAttach.mockResolvedValue({
      ok: true,
      engagementId: ENGAGEMENT_ID,
      companyId: COMPANY_ID,
      expertProfileId: EXPERT_PROFILE_ID,
      title: 'Raced case',
    });
    const result = await bookConsultationAction(NEW_CASE_INPUT);
    expect(result).toMatchObject({
      ok: true,
      engagementId: ENGAGEMENT_ID,
      caseTitle: 'Raced case',
    });
    // S1 — the racer's row is no more trusted than any other row found by key.
    expect(mockAuthorizeCaseAttach).toHaveBeenCalled();
  });

  it('the 23505 re-read DENIES when the raced row fails the gate', async () => {
    mockCreate.mockRejectedValue(new Error('duplicate key value'));
    mockIsUniqueViolation.mockReturnValue(true);
    mockFindByBookingIdempotencyKey.mockResolvedValueOnce(undefined).mockResolvedValueOnce({
      id: ENGAGEMENT_ID,
      companyId: COMPANY_ID,
      expertProfileId: EXPERT_PROFILE_ID,
      title: 'Raced case',
    });
    mockAuthorizeCaseAttach.mockResolvedValue({ ok: false, code: 'case_not_available' });
    const result = await bookConsultationAction(NEW_CASE_INPUT);
    expect(result).toEqual({ ok: false, stage: 'case', code: 'case_not_available' });
  });

  // ── S4 / S5 / S6 ─────────────────────────────────────────────────────────

  it('rejects an unbounded descriptionHtml (S4 — the DoS guard, not the UX limit)', async () => {
    const input: BookConsultationInput = {
      ...NEW_CASE_INPUT,
      caseChoice: {
        kind: 'new',
        title: 'Need help with a flow',
        descriptionHtml: `<p>${'x'.repeat(20_001)}</p>`,
        productIds: [],
      },
    };
    const result = await bookConsultationAction(input);
    expect(result).toEqual({ ok: false, stage: 'validation', code: 'invalid_request' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('rejects unknown product ids before the insert, never silently dropping them (S5)', async () => {
    const input: BookConsultationInput = {
      ...NEW_CASE_INPUT,
      caseChoice: {
        kind: 'new',
        title: 'Need help with a flow',
        descriptionHtml: '<p>A real problem statement.</p>',
        productIds: ['88888888-8888-4888-8888-888888888888'],
      },
    };
    const result = await bookConsultationAction(input);
    expect(result).toEqual({ ok: false, stage: 'validation', code: 'invalid_request' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('accepts product ids that ARE in the taxonomy (S5)', async () => {
    const input: BookConsultationInput = {
      ...NEW_CASE_INPUT,
      caseChoice: {
        kind: 'new',
        title: 'Need help with a flow',
        descriptionHtml: '<p>A real problem statement.</p>',
        productIds: [PRODUCT_ID],
      },
    };
    const result = await bookConsultationAction(input);
    expect(result).toMatchObject({ ok: true });
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ productIds: [PRODUCT_ID] }));
  });

  it('skips the taxonomy read entirely when no products were chosen (S5)', async () => {
    await bookConsultationAction(NEW_CASE_INPUT);
    expect(mockGetSalesforceVertical).not.toHaveBeenCalled();
  });

  it('fails CLOSED when the taxonomy read throws (S5)', async () => {
    mockGetSalesforceVertical.mockRejectedValue(new Error('db down'));
    const input: BookConsultationInput = {
      ...NEW_CASE_INPUT,
      caseChoice: {
        kind: 'new',
        title: 'Need help with a flow',
        descriptionHtml: '<p>A real problem statement.</p>',
        productIds: [PRODUCT_ID],
      },
    };
    const result = await bookConsultationAction(input);
    expect(result).toEqual({ ok: false, stage: 'validation', code: 'booking_failed' });
    expect(mockLogError).toHaveBeenCalledWith(
      'Product taxonomy read failed during booking',
      expect.objectContaining({ userId: 'user-1' })
    );
  });

  it('rate limits hop 1 once the actor is at their hourly cap (S6)', async () => {
    mockCountByActorAndActionSince.mockResolvedValue(30);
    const result = await bookConsultationAction(NEW_CASE_INPUT);
    expect(result).toEqual({ ok: false, stage: 'case', code: 'rate_limited' });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockCountByActorAndActionSince).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: 'user-1', action: 'engagement.created' })
    );
  });

  it('scopes the hop-1 budget to CASE creates only, so project kickoffs cannot exhaust it (N2)', async () => {
    // A client who has approved 30 project kickoffs this hour must still be able to book a
    // case: `engagement.created` is emitted by both products, so without the `engagementType`
    // filter this count would wrongly include those project rows and refuse the booking.
    mockCountByActorAndActionSince.mockResolvedValue(0);
    const result = await bookConsultationAction(NEW_CASE_INPUT);
    expect(result).toMatchObject({ ok: true });
    expect(mockCountByActorAndActionSince).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: 'user-1',
        action: 'engagement.created',
        engagementType: 'case',
      })
    );
  });

  it('fails CLOSED when the hop-1 rate-limit read throws (S6)', async () => {
    mockCountByActorAndActionSince.mockRejectedValue(new Error('db down'));
    const result = await bookConsultationAction(NEW_CASE_INPUT);
    expect(result).toEqual({ ok: false, stage: 'case', code: 'booking_failed' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('never rate limits a REPLAY or an ATTACH — only the create path (S6)', async () => {
    mockCountByActorAndActionSince.mockResolvedValue(999);
    const attached = await bookConsultationAction(EXISTING_CASE_INPUT);
    expect(attached).toMatchObject({ ok: true });

    mockFindByBookingIdempotencyKey.mockResolvedValue({
      id: ENGAGEMENT_ID,
      companyId: COMPANY_ID,
      expertProfileId: EXPERT_PROFILE_ID,
      title: 'Already created case',
    });
    const replayed = await bookConsultationAction(NEW_CASE_INPUT);
    expect(replayed).toMatchObject({ ok: true });
    expect(mockCountByActorAndActionSince).not.toHaveBeenCalled();
  });

  it('hop-2 failure returns stage:meeting with engagementId, does NOT soft-delete, does NOT publish', async () => {
    mockPostBookMeeting.mockResolvedValue({ ok: false, status: 500, code: 'internal_error' });
    const result = await bookConsultationAction(NEW_CASE_INPUT);
    expect(result).toEqual({
      ok: false,
      stage: 'meeting',
      code: 'booking_failed',
      engagementId: ENGAGEMENT_ID,
      caseTitle: 'Need help with a flow',
    });
    expect(mockLogError).toHaveBeenCalledWith(
      'Booking meeting hop failed after case create',
      expect.objectContaining({ engagementId: ENGAGEMENT_ID })
    );
    expect(mockPublishNotificationEvent).not.toHaveBeenCalled();
  });

  describe('funding pre-condition (BAL-478)', () => {
    /**
     * B1 (external review of PR #333) — the gate's minutes input was spoofable: nothing tied
     * `slot.durationMinutes` to `slot.startIso`/`slot.endIso`, and the two are consumed by
     * DIFFERENT downstream steps (the gate sizes its estimate from `durationMinutes`; the
     * meeting is booked from the raw window). A crafted `durationMinutes: 15` against a 3-hour
     * window passed the balance arm on a fraction of the funds, then booked the full window.
     *
     * This is the property worth pinning now: a mismatched pair is refused AT VALIDATION and
     * never reaches the gate at all — replacing the old R3 pin's implicit assumption that a
     * mismatched fixture could even reach `bookConsultationAction` in the first place.
     */
    it('B1 — a slot window that disagrees with durationMinutes is rejected at validation, before the gate', async () => {
      const spoofed: BookConsultationInput = {
        ...NEW_CASE_INPUT,
        slot: {
          // A 3-hour window declaring the cheapest rung on the duration ladder.
          startIso: '2026-09-01T04:00:00.000Z',
          endIso: '2026-09-01T07:00:00.000Z',
          durationMinutes: 15,
        },
      };

      const result = await bookConsultationAction(spoofed);

      expect(result).toEqual({ ok: false, stage: 'validation', code: 'invalid_request' });
      expect(mockEnforceBookingFunding).not.toHaveBeenCalled();
      expect(mockCreate).not.toHaveBeenCalled();
      expect(mockPostBookMeeting).not.toHaveBeenCalled();
    });

    /**
     * B1 — an unparseable instant must fail as a NAMED validation error, not fall through to
     * `NaN` arithmetic in the duration cross-check (`NaN !== anything` happens to be `true`,
     * so the check would still reject it, but only as an unnamed side effect). `.datetime()`
     * (mirroring `book-intro-call.ts`'s shipped fix for the identical shape) catches this
     * before the cross-check ever runs.
     */
    it('B1 — an unparseable startIso is rejected at validation, never reaches NaN arithmetic', async () => {
      const malformed: BookConsultationInput = {
        ...NEW_CASE_INPUT,
        slot: {
          startIso: 'not-a-real-instant',
          endIso: '2026-09-01T04:30:00.000Z',
          durationMinutes: 30,
        },
      };

      const result = await bookConsultationAction(malformed);

      expect(result).toEqual({ ok: false, stage: 'validation', code: 'invalid_request' });
      expect(mockEnforceBookingFunding).not.toHaveBeenCalled();
    });

    it('new-case arm: a zero-arm refusal writes NOTHING', async () => {
      mockEnforceBookingFunding.mockResolvedValue({
        ok: false,
        reason: 'unfunded',
        canManageBilling: false,
      });

      const result = await bookConsultationAction(NEW_CASE_INPUT);

      expect(result).toEqual({ ok: false, stage: 'funding', code: 'funding_admins_notified' });
      expect(mockCreate).not.toHaveBeenCalled();
      expect(mockPostBookMeeting).not.toHaveBeenCalled();
      expect(mockPublishNotificationEvent).not.toHaveBeenCalled();
    });

    /**
     * The anti-vacuity pin for the case above: identical input, gate passes ⇒ `mockCreate` WAS
     * called exactly once. Without this, the previous test's "not called" assertions would pass
     * for the wrong reason (memory `feedback_mutation_proof_is_per_assertion_not_per_suite`).
     */
    it('positive control: the SAME new-case input creates the case when the gate passes', async () => {
      mockEnforceBookingFunding.mockResolvedValue({ ok: true });

      const result = await bookConsultationAction(NEW_CASE_INPUT);

      expect(result).toMatchObject({ ok: true });
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    /**
     * REV-1 (fix round) — the ORIGINAL version of this test was VACUOUS: the default
     * `mockAuthorizeCaseAttach` (`beforeEach`) echoes back the SAME `COMPANY_ID` /
     * `EXPERT_PROFILE_ID` the request already carries, so asserting the gate received those
     * proved nothing about which one it actually reads from. Mutating `resolveCase`'s
     * `planFundingSubject` call to read `input.expertProfileId` (the request's CLAIM) instead of
     * the row's own field left this test green.
     *
     * Fixed by making the attach mock return a DISTINCT company AND expert from what the request
     * claims, then asserting the gate received THOSE — a value only reachable by reading the
     * row, never the claim. Re-run against the described mutation: RED (the gate then reports
     * `expertProfileId: EXPERT_PROFILE_ID`, not `OTHER_EXPERT_PROFILE_ID`).
     */
    it('existing-case (attach) arm: the gate is fed from the ROW, not the request claim', async () => {
      mockAuthorizeCaseAttach.mockResolvedValue({
        ok: true,
        engagementId: ENGAGEMENT_ID,
        companyId: OTHER_COMPANY_ID,
        expertProfileId: OTHER_EXPERT_PROFILE_ID,
        title: 'Existing case',
      });
      mockEnforceBookingFunding.mockResolvedValue({
        ok: false,
        reason: 'unfunded',
        canManageBilling: false,
      });

      const result = await bookConsultationAction(EXISTING_CASE_INPUT);

      expect(result).toEqual({ ok: false, stage: 'funding', code: 'funding_admins_notified' });
      expect(mockEnforceBookingFunding).toHaveBeenCalledWith(
        expect.objectContaining({
          companyId: OTHER_COMPANY_ID,
          expertProfileId: OTHER_EXPERT_PROFILE_ID,
        })
      );
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('replay arm: a zero-arm refusal on a replayed case does NOT re-book the meeting', async () => {
      mockFindByBookingIdempotencyKey.mockResolvedValue({
        id: ENGAGEMENT_ID,
        companyId: COMPANY_ID,
        expertProfileId: EXPERT_PROFILE_ID,
        title: 'Already created case',
      });
      mockEnforceBookingFunding.mockResolvedValue({
        ok: false,
        reason: 'unfunded',
        canManageBilling: false,
      });

      const result = await bookConsultationAction(NEW_CASE_INPUT);

      expect(result).toEqual({ ok: false, stage: 'funding', code: 'funding_admins_notified' });
      expect(mockPostBookMeeting).not.toHaveBeenCalled();
    });

    it('canManageBilling:true maps to funding_setup_required', async () => {
      mockEnforceBookingFunding.mockResolvedValue({
        ok: false,
        reason: 'unfunded',
        canManageBilling: true,
      });

      const result = await bookConsultationAction(NEW_CASE_INPUT);

      expect(result).toEqual({ ok: false, stage: 'funding', code: 'funding_setup_required' });
    });

    it("reason:'unavailable' maps to the generic case-hop failure, NOT a funding code", async () => {
      mockEnforceBookingFunding.mockResolvedValue({ ok: false, reason: 'unavailable' });

      const result = await bookConsultationAction(NEW_CASE_INPUT);

      expect(result).toEqual({ ok: false, stage: 'case', code: 'booking_failed' });
    });

    it('order pin: a rate-limited submit never reaches the funding gate', async () => {
      mockCountByActorAndActionSince.mockResolvedValue(30);

      const result = await bookConsultationAction(NEW_CASE_INPUT);

      expect(result).toEqual({ ok: false, stage: 'case', code: 'rate_limited' });
      expect(mockEnforceBookingFunding).not.toHaveBeenCalled();
    });

    /**
     * The gate is handed the slot WINDOW — the one input its estimate is derived from
     * (`estimatedMinutesForWindow`, the figure the API and admission compute too) — and NEVER a
     * duration. `NEW_CASE_INPUT.slot` is 30 minutes; the mocked SERVER window
     * (`SERVER_START`..`SERVER_END`) is deliberately 45, so a "fix" that fed the gate the
     * server's window would fail here. Replaces the pre-BAL-474 pin "uses the slot's declared
     * duration (30), never the server's window (45)" — the same property, restated over the
     * window.
     */
    it("hands the gate the slot's own window and the active workspace company, deferring a covered hold", async () => {
      await bookConsultationAction(NEW_CASE_INPUT);

      expect(mockEnforceBookingFunding).toHaveBeenCalledTimes(1);
      const input = mockEnforceBookingFunding.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(input).toEqual({
        actorUserId: USER.id,
        companyId: COMPANY_ID,
        expertProfileId: EXPERT_PROFILE_ID,
        slot: { startIso: NEW_CASE_INPUT.slot.startIso, endIso: NEW_CASE_INPUT.slot.endIso },
        activeCompanyId: ACTIVE_COMPANY_ID,
        onCoveredHold: 'defer',
      });
      expect(Object.keys(input)).not.toContain('estimatedMinutes');
    });

    describe('the balance refusals — D6.1 hold and D6.5 reservation', () => {
      const BILLING_COMPANY = { id: COMPANY_ID, name: 'Northwind', isActive: true };

      it.each([
        [true, 'hold_top_up_required'],
        [false, 'hold_admins_notified'],
      ] as const)(
        'on_hold (canManageBilling %s) ⇒ %s, with the figure and the company, and writes NOTHING',
        async (canManageBilling, code) => {
          mockEnforceBookingFunding.mockResolvedValue({
            ok: false,
            reason: 'on_hold',
            canManageBilling,
            billingCompany: BILLING_COMPANY,
            topUpNeededMinor: 27_500,
          });

          const result = await bookConsultationAction(NEW_CASE_INPUT);

          expect(result).toEqual({
            ok: false,
            stage: 'funding',
            code,
            balance: {
              variant: 'hold',
              topUpNeededMinor: 27_500,
              reservedBookingCount: null,
              company: BILLING_COMPANY,
            },
          });
          expect(mockCreate).not.toHaveBeenCalled();
          expect(mockPostBookMeeting).not.toHaveBeenCalled();
        }
      );

      it('on_hold with NO figure (the failed-heal fallback) carries topUpNeededMinor: null, never 0', async () => {
        mockEnforceBookingFunding.mockResolvedValue({
          ok: false,
          reason: 'on_hold',
          canManageBilling: false,
          billingCompany: BILLING_COMPANY,
          topUpNeededMinor: null,
        });

        const result = await bookConsultationAction(NEW_CASE_INPUT);

        expect(result).toMatchObject({ balance: { variant: 'hold', topUpNeededMinor: null } });
      });

      it.each([
        [true, 'reserved_top_up_required'],
        [false, 'reserved_admins_notified'],
      ] as const)(
        'reserved (canManageBilling %s) ⇒ %s, with the figure and the COUNT',
        async (canManageBilling, code) => {
          mockEnforceBookingFunding.mockResolvedValue({
            ok: false,
            reason: 'reserved',
            canManageBilling,
            billingCompany: { ...BILLING_COMPANY, isActive: false },
            topUpNeededMinor: 7_500,
            reservedBookingCount: 2,
          });

          const result = await bookConsultationAction(NEW_CASE_INPUT);

          expect(result).toEqual({
            ok: false,
            stage: 'funding',
            code,
            balance: {
              variant: 'reserved',
              topUpNeededMinor: 7_500,
              reservedBookingCount: 2,
              company: { ...BILLING_COMPANY, isActive: false },
            },
          });
          expect(mockCreate).not.toHaveBeenCalled();
        }
      );
    });

    describe('a key that already names a meeting skips every web funding gate (D7.7, D8.6)', () => {
      const SAME_WINDOW = {
        scheduledStart: new Date(NEW_CASE_INPUT.slot.startIso),
        scheduledEnd: new Date(NEW_CASE_INPUT.slot.endIso),
      };
      const RESOLVED_CASE_ROW = {
        id: ENGAGEMENT_ID,
        companyId: COMPANY_ID,
        expertProfileId: EXPERT_PROFILE_ID,
        title: 'Already created case',
      };
      const HOLD_REFUSAL = {
        ok: false,
        reason: 'on_hold',
        canManageBilling: false,
        billingCompany: { id: COMPANY_ID, name: 'Northwind', isActive: true },
        topUpNeededMinor: 27_500,
      };

      function namesAMeeting(
        overrides: {
          window?: { scheduledStart: Date; scheduledEnd: Date };
          contextId?: string;
        } = {}
      ): void {
        // The lost-201 retry: hop 1 finds its own case by key…
        mockFindByBookingIdempotencyKey.mockResolvedValue(RESOLVED_CASE_ROW);
        // …and the API's probe already finds the meeting under the same key.
        mockMeetingFindByKey.mockResolvedValue({
          id: MEETING_ID,
          ...(overrides.window ?? SAME_WINDOW),
        });
        mockMeetingFindWithContexts.mockResolvedValue({
          meeting: { id: MEETING_ID },
          contexts: [{ contextType: 'case', contextId: overrides.contextId ?? ENGAGEMENT_ID }],
        });
      }

      it('a MATCH (same key, window and case) never reads a hold or a reservation — even one that would refuse', async () => {
        namesAMeeting();
        mockEnforceBookingFunding.mockResolvedValue(HOLD_REFUSAL);

        const result = await bookConsultationAction(NEW_CASE_INPUT);

        expect(result).toMatchObject({ ok: true, meetingId: MEETING_ID });
        expect(mockEnforceBookingFunding).not.toHaveBeenCalled();
        expect(mockPostBookMeeting).toHaveBeenCalledTimes(1);
        expect(mockLogInfo).toHaveBeenCalledWith(
          'Booking key already names a meeting — web funding gates skipped; the API replays or refuses it',
          expect.objectContaining({ engagementId: ENGAGEMENT_ID, replay: 'match' })
        );
      });

      it('positive control: the SAME retry with NO meeting under the key DOES run the gate and is refused', async () => {
        mockFindByBookingIdempotencyKey.mockResolvedValue(RESOLVED_CASE_ROW);
        mockEnforceBookingFunding.mockResolvedValue(HOLD_REFUSAL);

        const result = await bookConsultationAction(NEW_CASE_INPUT);

        expect(mockEnforceBookingFunding).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({ ok: false, code: 'hold_admins_notified' });
        expect(mockPostBookMeeting).not.toHaveBeenCalled();
      });

      it('a CONFLICT (same key, a different window) also skips the gates — no panel, no fan-out — and the API answers idempotency_key_conflict', async () => {
        namesAMeeting({
          window: {
            scheduledStart: new Date('2026-09-01T05:00:00.000Z'),
            scheduledEnd: new Date('2026-09-01T05:30:00.000Z'),
          },
        });
        mockEnforceBookingFunding.mockResolvedValue(HOLD_REFUSAL);
        mockPostBookMeeting.mockResolvedValue({
          ok: false,
          status: 409,
          code: 'idempotency_key_conflict',
        });

        const result = await bookConsultationAction(NEW_CASE_INPUT);

        expect(mockEnforceBookingFunding).not.toHaveBeenCalled();
        expect(result).toEqual({
          ok: false,
          stage: 'meeting',
          code: 'idempotency_key_conflict',
          engagementId: ENGAGEMENT_ID,
          caseTitle: 'Existing case',
        });
        expect(mockLogInfo).toHaveBeenCalledWith(
          expect.stringContaining('web funding gates skipped'),
          expect.objectContaining({ replay: 'conflict' })
        );
      });

      it('a CONFLICT on the case (same key and window, a different context) skips the gates too', async () => {
        namesAMeeting({ contextId: OTHER_COMPANY_ID });
        mockEnforceBookingFunding.mockResolvedValue(HOLD_REFUSAL);

        await bookConsultationAction(NEW_CASE_INPUT);

        expect(mockEnforceBookingFunding).not.toHaveBeenCalled();
        expect(mockLogInfo).toHaveBeenCalledWith(
          expect.stringContaining('web funding gates skipped'),
          expect.objectContaining({ replay: 'conflict' })
        );
      });

      it('a probe read failure is NONE — fail-closed: the gates run and the failure is logged at warn', async () => {
        mockFindByBookingIdempotencyKey.mockResolvedValue(RESOLVED_CASE_ROW);
        mockMeetingFindByKey.mockRejectedValue(new Error('connection reset'));
        mockEnforceBookingFunding.mockResolvedValue(HOLD_REFUSAL);

        const result = await bookConsultationAction(NEW_CASE_INPUT);

        expect(mockEnforceBookingFunding).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({ ok: false, code: 'hold_admins_notified' });
        expect(mockLogWarn).toHaveBeenCalledWith(
          'Booking key classification read failed — running the funding gates',
          expect.objectContaining({ error: 'connection reset' })
        );
      });

      it('the attach arm probes the key too (an existing case can carry a used key)', async () => {
        mockMeetingFindByKey.mockResolvedValue({ id: MEETING_ID, ...SAME_WINDOW });
        mockMeetingFindWithContexts.mockResolvedValue({
          meeting: { id: MEETING_ID },
          contexts: [{ contextType: 'case', contextId: ENGAGEMENT_ID }],
        });
        mockEnforceBookingFunding.mockResolvedValue(HOLD_REFUSAL);

        const result = await bookConsultationAction(EXISTING_CASE_INPUT);

        expect(result).toMatchObject({ ok: true });
        expect(mockEnforceBookingFunding).not.toHaveBeenCalled();
      });

      it('a NEW case has no case row yet, so its key is never probed (only the existing plan can carry a used key)', async () => {
        await bookConsultationAction(NEW_CASE_INPUT);

        expect(mockMeetingFindByKey).not.toHaveBeenCalled();
        expect(mockEnforceBookingFunding).toHaveBeenCalledTimes(1);
      });
    });

    describe('hop 2 — the API answers a funding refusal after the case row was written (plan §F.3)', () => {
      const BILLING_COMPANY = { id: COMPANY_ID, name: 'Northwind', isActive: false };

      function apiRefuses(code: string, status = 409): void {
        mockPostBookMeeting.mockResolvedValue({ ok: false, status, code });
      }

      /** The FIRST gate call (hop 1) passes; the RE-RUN (hop 2) answers `second`. */
      function gateThen(second: unknown): void {
        mockEnforceBookingFunding.mockResolvedValueOnce({ ok: true });
        mockEnforceBookingFunding.mockResolvedValueOnce(second);
      }

      it('booking_reserved ⇒ the gate is re-run FRESH ⇒ stage:meeting + reserved_* + the case title and figures', async () => {
        apiRefuses('booking_reserved');
        gateThen({
          ok: false,
          reason: 'reserved',
          canManageBilling: true,
          billingCompany: BILLING_COMPANY,
          topUpNeededMinor: 7_500,
          reservedBookingCount: 1,
        });

        const result = await bookConsultationAction(NEW_CASE_INPUT);

        expect(result).toEqual({
          ok: false,
          stage: 'meeting',
          code: 'reserved_top_up_required',
          engagementId: ENGAGEMENT_ID,
          caseTitle: 'Need help with a flow',
          balance: {
            variant: 'reserved',
            topUpNeededMinor: 7_500,
            reservedBookingCount: 1,
            company: BILLING_COMPANY,
          },
        });
        expect(mockEnforceBookingFunding).toHaveBeenCalledTimes(2);
        expect(mockEnforceBookingFunding.mock.calls[1]?.[0]).toEqual({
          actorUserId: USER.id,
          companyId: COMPANY_ID,
          expertProfileId: EXPERT_PROFILE_ID,
          slot: { startIso: NEW_CASE_INPUT.slot.startIso, endIso: NEW_CASE_INPUT.slot.endIso },
          activeCompanyId: ACTIVE_COMPANY_ID,
          onCoveredHold: 'defer',
        });
        // No meeting exists, so nothing is announced.
        expect(mockPublishNotificationEvent).not.toHaveBeenCalled();
      });

      it("account_on_hold re-runs the gate with onCoveredHold 'refuse' (a still-covered hold means the API's heal failed)", async () => {
        apiRefuses('account_on_hold');
        gateThen({
          ok: false,
          reason: 'on_hold',
          canManageBilling: false,
          billingCompany: BILLING_COMPANY,
          topUpNeededMinor: null,
        });

        const result = await bookConsultationAction(NEW_CASE_INPUT);

        expect(mockEnforceBookingFunding.mock.calls[1]?.[0]).toMatchObject({
          onCoveredHold: 'refuse',
        });
        expect(result).toEqual({
          ok: false,
          stage: 'meeting',
          code: 'hold_admins_notified',
          engagementId: ENGAGEMENT_ID,
          caseTitle: 'Need help with a flow',
          balance: {
            variant: 'hold',
            topUpNeededMinor: null,
            reservedBookingCount: null,
            company: BILLING_COMPANY,
          },
        });
      });

      it('booking_unfunded ⇒ the re-run unfunded ⇒ the BAL-478 code at stage:meeting, naming the saved case', async () => {
        apiRefuses('booking_unfunded');
        gateThen({ ok: false, reason: 'unfunded', canManageBilling: true });

        const result = await bookConsultationAction(NEW_CASE_INPUT);

        expect(result).toEqual({
          ok: false,
          stage: 'meeting',
          code: 'funding_setup_required',
          engagementId: ENGAGEMENT_ID,
          caseTitle: 'Need help with a flow',
        });
      });

      it.each([
        ['passes', { ok: true }],
        ['is unavailable', { ok: false, reason: 'unavailable' }],
      ])(
        'a refusal that does NOT reproduce at the web gate (re-run %s) ⇒ generic booking_failed, warned, no figure invented',
        async (_label, second) => {
          apiRefuses('booking_reserved');
          gateThen(second);

          const result = await bookConsultationAction(NEW_CASE_INPUT);

          expect(result).toEqual({
            ok: false,
            stage: 'meeting',
            code: 'booking_failed',
            engagementId: ENGAGEMENT_ID,
            caseTitle: 'Need help with a flow',
          });
          expect(mockLogWarn).toHaveBeenCalledWith(
            'Hop-2 funding refusal did not reproduce at the web gate — generic retry',
            expect.objectContaining({ code: 'booking_reserved', engagementId: ENGAGEMENT_ID })
          );
        }
      );

      it('503 booking_funding_unavailable ⇒ generic booking_failed at stage:meeting, the gate is NOT re-run, nothing notified', async () => {
        apiRefuses('booking_funding_unavailable', 503);

        const result = await bookConsultationAction(NEW_CASE_INPUT);

        expect(result).toEqual({
          ok: false,
          stage: 'meeting',
          code: 'booking_failed',
          engagementId: ENGAGEMENT_ID,
          caseTitle: 'Need help with a flow',
        });
        expect(mockEnforceBookingFunding).toHaveBeenCalledTimes(1);
        expect(mockLogError).toHaveBeenCalledWith(
          'Booking meeting hop failed after case create',
          expect.objectContaining({ code: 'booking_funding_unavailable' })
        );
      });

      it('an ordinary 409 is not treated as a funding refusal (positive control: the gate is not re-run)', async () => {
        apiRefuses('something_else');

        await bookConsultationAction(NEW_CASE_INPUT);

        expect(mockEnforceBookingFunding).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('session_expired (dead WorkOS credential, not a booking refusal)', () => {
    it('PRE-FLIGHT: refuses before the case hop and writes NOTHING', async () => {
      mockViewerApiCredentialIsLive.mockResolvedValue(false);
      const result = await bookConsultationAction(NEW_CASE_INPUT);
      expect(result).toEqual({ ok: false, stage: 'validation', code: 'session_expired' });
      // ⚠ THE POINT OF THE GATE. Before it existed the case row was written first and the
      // meeting hop then 401'd, stranding an orphaned case behind a panel about the SLOT.
      expect(mockCreate).not.toHaveBeenCalled();
      expect(mockPostBookMeeting).not.toHaveBeenCalled();
    });

    it('MID-SUBMIT: a hop-2 401 maps to session_expired, still naming the case that was written', async () => {
      mockPostBookMeeting.mockResolvedValue({ ok: false, status: 401, code: 'Unauthorized' });
      const result = await bookConsultationAction(NEW_CASE_INPUT);
      expect(result).toEqual({
        ok: false,
        stage: 'meeting',
        code: 'session_expired',
        engagementId: ENGAGEMENT_ID,
        caseTitle: 'Need help with a flow',
      });
    });

    it.each(['account_suspended', 'account_deleted'])(
      'does NOT claim session_expired for a 401 carrying %s — signing in again cannot fix it',
      async (code) => {
        mockPostBookMeeting.mockResolvedValue({ ok: false, status: 401, code });
        const result = await bookConsultationAction(NEW_CASE_INPUT);
        expect(result).toMatchObject({ stage: 'meeting', code: 'booking_failed' });
      }
    );
  });

  it('maps a 409 window_not_available to slot_unavailable, preserving the case', async () => {
    mockPostBookMeeting.mockResolvedValue({ ok: false, status: 409, code: 'window_not_available' });
    const result = await bookConsultationAction(NEW_CASE_INPUT);
    expect(result).toEqual({
      ok: false,
      stage: 'meeting',
      code: 'slot_unavailable',
      engagementId: ENGAGEMENT_ID,
      caseTitle: 'Need help with a flow',
    });
  });

  it('maps a 409 idempotency_key_conflict through', async () => {
    mockPostBookMeeting.mockResolvedValue({
      ok: false,
      status: 409,
      code: 'idempotency_key_conflict',
    });
    const result = await bookConsultationAction(NEW_CASE_INPUT);
    expect(result).toEqual({
      ok: false,
      stage: 'meeting',
      code: 'idempotency_key_conflict',
      engagementId: ENGAGEMENT_ID,
      caseTitle: 'Need help with a flow',
    });
  });

  it('returns company_selection_required when >1 eligible company and none chosen', async () => {
    mockListCapabilityEligibleCompanies.mockResolvedValue([
      { id: COMPANY_ID, name: 'Northwind', logoUrl: null },
      { id: 'company-2', name: 'Acme', logoUrl: null },
    ]);
    const result = await bookConsultationAction(NEW_CASE_INPUT);
    expect(result).toEqual({ ok: false, stage: 'company', code: 'company_selection_required' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('returns company_not_eligible when the chosen companyId is outside the eligible set', async () => {
    const otherCompanyId = '55555555-5555-4555-8555-555555555555';
    mockListCapabilityEligibleCompanies.mockResolvedValue([
      { id: COMPANY_ID, name: 'Northwind', logoUrl: null },
      { id: 'company-2', name: 'Acme', logoUrl: null },
    ]);
    const input: BookConsultationInput = {
      ...NEW_CASE_INPUT,
      caseChoice: {
        kind: 'new',
        title: NEW_CASE_INPUT.caseChoice.kind === 'new' ? NEW_CASE_INPUT.caseChoice.title : '',
        descriptionHtml:
          NEW_CASE_INPUT.caseChoice.kind === 'new' ? NEW_CASE_INPUT.caseChoice.descriptionHtml : '',
        productIds: [],
        companyId: otherCompanyId,
      },
    };
    const result = await bookConsultationAction(input);
    expect(result).toEqual({ ok: false, stage: 'company', code: 'company_not_eligible' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('returns no_eligible_company when the actor has zero eligible companies', async () => {
    mockListCapabilityEligibleCompanies.mockResolvedValue([]);
    const result = await bookConsultationAction(NEW_CASE_INPUT);
    expect(result).toEqual({ ok: false, stage: 'company', code: 'no_eligible_company' });
  });

  it('a guest invite failure does NOT fail the overall booking', async () => {
    mockPostInviteGuests.mockResolvedValue({ ok: false, status: 500, code: 'request_failed' });
    const input: BookConsultationInput = { ...NEW_CASE_INPUT, guests: [{ email: 'a@b.com' }] };
    const result = await bookConsultationAction(input);
    expect(result).toMatchObject({ ok: true, guestInviteFailed: true, guestsInvited: 0 });
    expect(mockLogWarn).toHaveBeenCalledWith(
      'Guest invite failed after booking',
      expect.objectContaining({ meetingId: MEETING_ID })
    );
  });

  it('treats a 409 guest_already_invited as success (retry-safe)', async () => {
    mockPostInviteGuests.mockResolvedValue({
      ok: false,
      status: 409,
      code: 'guest_already_invited',
    });
    const input: BookConsultationInput = { ...NEW_CASE_INPUT, guests: [{ email: 'a@b.com' }] };
    const result = await bookConsultationAction(input);
    expect(result).toMatchObject({ ok: true, guestInviteFailed: false, guestsInvited: 1 });
  });

  it('publishes booking.confirmed ONLY on ok:true — never on a validation failure', async () => {
    const badInput = { ...NEW_CASE_INPUT, expertProfileId: 'not-a-uuid' } as BookConsultationInput;
    const result = await bookConsultationAction(badInput);
    expect(result).toEqual({ ok: false, stage: 'validation', code: 'invalid_request' });
    expect(mockPublishNotificationEvent).not.toHaveBeenCalled();
  });

  it('rejects malformed input (invalid_request) before touching any repository', async () => {
    const badInput = { ...NEW_CASE_INPUT, bookingNonce: 'not-a-uuid' } as BookConsultationInput;
    const result = await bookConsultationAction(badInput);
    expect(result).toEqual({ ok: false, stage: 'validation', code: 'invalid_request' });
    expect(mockFindByBookingIdempotencyKey).not.toHaveBeenCalled();
  });

  it('rejects a description that sanitises to empty content', async () => {
    mockSanitizeCaseDescription.mockReturnValue({ ok: false });
    const result = await bookConsultationAction(NEW_CASE_INPUT);
    expect(result).toEqual({ ok: false, stage: 'validation', code: 'invalid_request' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  // ── M3 regression: a post-201 display-name read must never lose an already-committed booking ──
  it('degrades to a neutral company label and still returns ok:true + publishes when findNameById throws', async () => {
    mockFindNameById.mockRejectedValue(new Error('pg: connection reset'));
    const result = await bookConsultationAction(NEW_CASE_INPUT);
    expect(result).toMatchObject({ ok: true, engagementId: ENGAGEMENT_ID, meetingId: MEETING_ID });
    expect(mockLogWarn).toHaveBeenCalledWith(
      'Company name read failed after booking; degrading to a neutral label',
      expect.objectContaining({ companyId: COMPANY_ID, meetingId: MEETING_ID })
    );
    expect(mockPublishNotificationEvent).toHaveBeenCalledWith(
      'booking.confirmed',
      expect.objectContaining({ clientCompanyName: 'your company' })
    );
  });
});

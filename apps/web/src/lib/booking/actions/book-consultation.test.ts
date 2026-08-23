import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRequireOnboardedUser = vi.fn();
const mockFindByBookingIdempotencyKey = vi.fn();
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
const mockPostInviteGuests = vi.fn();
const mockPublishNotificationEvent = vi.fn();
const mockLogInfo = vi.fn();
const mockLogWarn = vi.fn();
const mockLogError = vi.fn();

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
vi.mock('../load-booking-context', () => ({
  resolveBookingExpertDisplay: (...args: unknown[]) => mockResolveBookingExpertDisplay(...args),
}));
vi.mock('../booking-api-client', () => ({
  postBookMeeting: (...args: unknown[]) => mockPostBookMeeting(...args),
  postInviteGuests: (...args: unknown[]) => mockPostInviteGuests(...args),
}));

import { bookConsultationAction } from './book-consultation';
import type { BookConsultationInput } from './types';

const USER = { id: 'user-1', onboardingCompleted: true };
const KEY = 'a'.repeat(64);
const EXPERT_PROFILE_ID = '11111111-1111-4111-8111-111111111111';
const MEETING_ID = '22222222-2222-4222-8222-222222222222';
const COMPANY_ID = '33333333-3333-4333-8333-333333333333';
const ENGAGEMENT_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_EXPERT_PROFILE_ID = '99999999-9999-4999-8999-999999999999';
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
      joinPath: `/join/m/${MEETING_ID}`,
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
      joinPath: `/join/m/${MEETING_ID}`,
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

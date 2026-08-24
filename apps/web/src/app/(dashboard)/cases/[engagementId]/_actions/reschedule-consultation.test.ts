import { describe, it, expect, vi, beforeEach } from 'vitest';

// ⚠ EVERY CHARACTER MUST BE VALID HEX (0-9a-f) — `z.uuid()` rejects anything else, and a
// mnemonic prefix like `m0000000…` silently 400s the whole fixture on `meetingId`.
const ENGAGEMENT_ID = 'e0000000-0000-4000-8000-000000000001';
const MEETING_ID = 'a0000000-0000-4000-8000-000000000002';
/** The `meeting.rescheduled` audit row id — the fan-out's per-MOVE dedup key. */
const AUDIT_ID = 'd0000000-0000-4000-8000-00000000000a';
const USER_ID = 'a0000000-0000-4000-8000-000000000003';
const COMPANY_ID = 'a0000000-0000-4000-8000-000000000004';
const EXPERT_PROFILE_ID = 'a0000000-0000-4000-8000-000000000005';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const mockFindWithContexts = vi.fn();
const mockFindCompany = vi.fn();
const mockFindProfile = vi.fn();
const mockFindUser = vi.fn();
const mockFindAgency = vi.fn();

vi.mock('@balo/db', () => ({
  meetingsRepository: { findWithContexts: (...a: unknown[]) => mockFindWithContexts(...a) },
  companiesRepository: { findNameById: (...a: unknown[]) => mockFindCompany(...a) },
  expertsRepository: { findDisplayProfileById: (...a: unknown[]) => mockFindProfile(...a) },
  usersRepository: { findDisplayById: (...a: unknown[]) => mockFindUser(...a) },
  agenciesRepository: { getSummaryById: (...a: unknown[]) => mockFindAgency(...a) },
}));

const mockRequireOnboardedUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  requireOnboardedUser: () => mockRequireOnboardedUser(),
}));

const mockAuthorizeCaseMutation = vi.fn();
vi.mock('../_lib/authorize-case-mutation', () => ({
  authorizeCaseMutation: (...a: unknown[]) => mockAuthorizeCaseMutation(...a),
}));

const mockHasCapability = vi.fn();
vi.mock('@/lib/authz', () => ({
  hasCapability: (...a: unknown[]) => mockHasCapability(...a),
  CAPABILITIES: { PARTICIPATE: 'participate' },
}));

const mockPostRescheduleMeeting = vi.fn();
vi.mock('@/lib/meetings/reschedule-api-client', () => ({
  postRescheduleMeeting: (...a: unknown[]) => mockPostRescheduleMeeting(...a),
}));

const mockPublishNotificationEvent = vi.fn();
vi.mock('@/lib/notifications/publish', () => ({
  publishNotificationEvent: (...a: unknown[]) => mockPublishNotificationEvent(...a),
}));

import { revalidatePath } from 'next/cache';
import { rescheduleConsultationAction } from './reschedule-consultation';

// N9 — DELIBERATELY NOT 30 MINUTES. A hard-coded `+ 30 minutes` in the action would pass
// identically against a 30-minute fixture; 45 minutes catches that class of bug.
function meetingRow(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: MEETING_ID,
    scheduledStart: new Date('2026-09-01T09:00:00.000Z'),
    scheduledEnd: new Date('2026-09-01T09:45:00.000Z'), // 45-minute meeting
    ...overrides,
  };
}

function meetingWithContexts(overrides: Record<string, unknown> = {}): unknown {
  return {
    meeting: meetingRow(),
    contexts: [{ contextType: 'case', contextId: ENGAGEMENT_ID }],
    ...overrides,
  };
}

function gateOk(overrides: Record<string, unknown> = {}): unknown {
  return {
    ok: true,
    user: { id: USER_ID },
    engagementId: ENGAGEMENT_ID,
    companyId: COMPANY_ID,
    expertProfileId: EXPERT_PROFILE_ID,
    lens: 'client',
    caseRow: { title: 'Salesforce integration' },
    ...overrides,
  };
}

const VALID_INPUT = {
  engagementId: ENGAGEMENT_ID,
  meetingId: MEETING_ID,
  startIso: '2026-09-01T10:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireOnboardedUser.mockResolvedValue({ id: USER_ID });
  mockAuthorizeCaseMutation.mockResolvedValue(gateOk());
  mockHasCapability.mockResolvedValue(true);
  mockFindWithContexts.mockResolvedValue(meetingWithContexts());
  mockPostRescheduleMeeting.mockResolvedValue({
    ok: true,
    data: {
      meetingId: MEETING_ID,
      scheduledStart: '2026-09-01T10:00:00.000Z',
      scheduledEnd: '2026-09-01T10:45:00.000Z',
      previousScheduledStart: '2026-09-01T09:00:00.000Z',
      previousScheduledEnd: '2026-09-01T09:45:00.000Z',
      changed: true,
      rescheduleAuditId: AUDIT_ID,
    },
  });
  mockFindCompany.mockResolvedValue({ name: 'Northwind Industrial' });
  mockFindProfile.mockResolvedValue({ userId: USER_ID, type: 'freelancer', agencyId: null });
  mockFindUser.mockResolvedValue({ firstName: 'Amara', lastName: 'Okafor' });
  mockPublishNotificationEvent.mockResolvedValue(undefined);
});

describe('rescheduleConsultationAction — T-WEB-ACT', () => {
  it('calls requireOnboardedUser() FIRST — it throws for an un-onboarded session', async () => {
    mockRequireOnboardedUser.mockRejectedValue(new Error('not onboarded'));

    const result = await rescheduleConsultationAction(VALID_INPUT);

    expect(result).toEqual({
      success: false,
      code: 'unauthenticated',
      error: 'You are not signed in.',
    });
    expect(mockAuthorizeCaseMutation).not.toHaveBeenCalled();
  });

  it('rejects a bad payload before touching the gate', async () => {
    const result = await rescheduleConsultationAction({
      engagementId: 'not-a-uuid',
      meetingId: MEETING_ID,
      startIso: '2026-09-01T10:00:00.000Z',
    });

    expect(result).toEqual({ success: false, code: 'invalid_request', error: 'Invalid request.' });
    expect(mockAuthorizeCaseMutation).not.toHaveBeenCalled();
  });

  it('the case gate denial short-circuits', async () => {
    mockAuthorizeCaseMutation.mockResolvedValue({
      ok: false,
      error: 'This case is no longer available.',
    });

    const result = await rescheduleConsultationAction(VALID_INPUT);

    expect(result).toEqual({
      success: false,
      code: 'not_permitted',
      error: 'This case is no longer available.',
    });
    expect(mockPostRescheduleMeeting).not.toHaveBeenCalled();
  });

  it('denies the expert lens — reschedule is client-initiated only', async () => {
    mockAuthorizeCaseMutation.mockResolvedValue(gateOk({ lens: 'expert' }));

    const result = await rescheduleConsultationAction(VALID_INPUT);

    expect(result.success).toBe(false);
    expect(mockPostRescheduleMeeting).not.toHaveBeenCalled();
    expect(mockHasCapability).not.toHaveBeenCalled();
  });

  // N1 — `lens === 'client'` alone is not authorization; CLAUDE.md bans gating on `lens ===`.
  it('N1 — denies when hasCapability(PARTICIPATE) refuses, even with lens === "client"', async () => {
    mockHasCapability.mockResolvedValue(false);

    const result = await rescheduleConsultationAction(VALID_INPUT);

    expect(result).toEqual({
      success: false,
      code: 'not_permitted',
      error: "You don't have permission to reschedule this consultation.",
    });
    expect(mockHasCapability).toHaveBeenCalledWith(
      { id: USER_ID },
      'participate',
      expect.objectContaining({ companyId: COMPANY_ID })
    );
    expect(mockPostRescheduleMeeting).not.toHaveBeenCalled();
  });

  // B3 — `meetingId` must be PROVEN to belong to `engagementId`. `authorizeCaseMutation`
  // authorizes the CASE; without this check a client could submit any two independently
  // reachable `{engagementId, meetingId}` pairs and both gates would pass.
  it('B3 — refuses when the meeting has no live "case" context matching engagementId', async () => {
    mockFindWithContexts.mockResolvedValue(
      meetingWithContexts({ contexts: [{ contextType: 'case', contextId: 'some-other-case' }] })
    );

    const result = await rescheduleConsultationAction(VALID_INPUT);

    expect(result).toEqual({
      success: false,
      code: 'meeting_not_found',
      error: "We couldn't find that consultation.",
    });
    expect(mockPostRescheduleMeeting).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(mockPublishNotificationEvent).not.toHaveBeenCalled();
  });

  it('B3 — refuses when the meeting has no contexts at all', async () => {
    mockFindWithContexts.mockResolvedValue(meetingWithContexts({ contexts: [] }));

    const result = await rescheduleConsultationAction(VALID_INPUT);

    expect(result).toEqual({
      success: false,
      code: 'meeting_not_found',
      error: "We couldn't find that consultation.",
    });
    expect(mockPostRescheduleMeeting).not.toHaveBeenCalled();
  });

  it('B3 — 404s when the meeting itself does not resolve', async () => {
    mockFindWithContexts.mockResolvedValue(undefined);

    const result = await rescheduleConsultationAction(VALID_INPUT);

    expect(result).toEqual({
      success: false,
      code: 'meeting_not_found',
      error: "We couldn't find that consultation.",
    });
  });

  it('the api hop receives the SERVER-COMPUTED scheduledEnd (start + current duration), never the client’s', async () => {
    await rescheduleConsultationAction(VALID_INPUT);

    expect(mockPostRescheduleMeeting).toHaveBeenCalledWith(MEETING_ID, {
      scheduledStart: '2026-09-01T10:00:00.000Z',
      // The meeting's CURRENT duration is 45 minutes (09:00–09:45) — the computed end is
      // start + 45min, regardless of anything the client might have sent.
      scheduledEnd: '2026-09-01T10:45:00.000Z',
    });
  });

  it('revalidatePath(/cases/{id}) fires on success', async () => {
    await rescheduleConsultationAction(VALID_INPUT);
    expect(revalidatePath).toHaveBeenCalledWith(`/cases/${ENGAGEMENT_ID}`);
  });

  it('returns the SERVER’s committed window, not the client’s submitted slot', async () => {
    const result = await rescheduleConsultationAction(VALID_INPUT);
    expect(result).toEqual({
      success: true,
      scheduledStart: '2026-09-01T10:00:00.000Z',
      scheduledEnd: '2026-09-01T10:45:00.000Z',
    });
  });

  // N4 — the api's own no-op guard reports `changed: false` for a same-window resubmit; this
  // action must not treat that as a real move.
  it('N4 — skips revalidatePath/publish when the api reports changed: false (no-op)', async () => {
    mockPostRescheduleMeeting.mockResolvedValue({
      ok: true,
      data: {
        meetingId: MEETING_ID,
        scheduledStart: '2026-09-01T09:00:00.000Z',
        scheduledEnd: '2026-09-01T09:45:00.000Z',
        previousScheduledStart: '2026-09-01T09:00:00.000Z',
        previousScheduledEnd: '2026-09-01T09:45:00.000Z',
        changed: false,
      },
    });

    const result = await rescheduleConsultationAction(VALID_INPUT);

    expect(result).toEqual({
      success: true,
      scheduledStart: '2026-09-01T09:00:00.000Z',
      scheduledEnd: '2026-09-01T09:45:00.000Z',
    });
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(mockPublishNotificationEvent).not.toHaveBeenCalled();
  });

  it('publishes booking.rescheduled ONLY on ok: true, and does not await it', async () => {
    let resolvePublish: (() => void) | undefined;
    mockPublishNotificationEvent.mockReturnValue(
      new Promise<void>((resolve) => {
        resolvePublish = resolve;
      })
    );

    const result = await rescheduleConsultationAction(VALID_INPUT);

    // The action already resolved even though the publish promise has not.
    expect(result.success).toBe(true);
    expect(mockPublishNotificationEvent).toHaveBeenCalledWith(
      'booking.rescheduled',
      expect.objectContaining({
        meetingId: MEETING_ID,
        engagementId: ENGAGEMENT_ID,
        recipientId: USER_ID,
        expertProfileId: EXPERT_PROFILE_ID,
        initiatedBy: 'client',
        // ⚠ The dedup key is the `meeting.rescheduled` AUDIT ROW ID, never the target window.
        // A window-derived key is unique per DESTINATION, not per WRITE, so a move BACK to a
        // previously-used window (A→B→C→B) regenerates a key BullMQ has already seen and the
        // publish is silently dropped — both party emails lost on a move that did happen.
        correlationId: `${MEETING_ID}:${AUDIT_ID}`,
      })
    );
    resolvePublish?.();
  });

  it('does NOT publish when the api hop fails', async () => {
    mockPostRescheduleMeeting.mockResolvedValue({
      ok: false,
      status: 409,
      code: 'window_not_available',
    });

    const result = await rescheduleConsultationAction(VALID_INPUT);

    expect(result).toEqual({
      success: false,
      code: 'slot_unavailable',
      error: 'That time was just taken. Pick another.',
    });
    expect(mockPublishNotificationEvent).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('maps meeting_not_reschedulable to its own copy', async () => {
    mockPostRescheduleMeeting.mockResolvedValue({
      ok: false,
      status: 409,
      code: 'meeting_not_reschedulable',
    });

    const result = await rescheduleConsultationAction(VALID_INPUT);

    expect(result).toEqual({
      success: false,
      code: 'meeting_not_reschedulable',
      error: 'This consultation can no longer be moved.',
    });
  });
});

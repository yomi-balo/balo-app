import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dailyRoomNameForMeeting } from '@balo/shared/meetings';

const {
  mockFindIdByMeetingId,
  mockMarkSessionless,
  mockOpenAndSettle,
  mockMeetingFindById,
  mockListByMeeting,
  mockClientPartyIdentities,
  mockFindUserIdByProfileId,
  mockCompute,
  mockComplete,
  mockBuildFields,
  mockSettleMeetingIfBillable,
  mockResolveOnBehalf,
  mockReportRefused,
  mockResolveSubject,
  mockLogInfo,
  mockLogWarn,
  mockLogError,
} = vi.hoisted(() => ({
  mockFindIdByMeetingId: vi.fn(),
  mockMarkSessionless: vi.fn(),
  mockOpenAndSettle: vi.fn(),
  mockMeetingFindById: vi.fn(),
  mockListByMeeting: vi.fn(),
  mockClientPartyIdentities: vi.fn(),
  mockFindUserIdByProfileId: vi.fn(),
  mockCompute: vi.fn(),
  mockComplete: vi.fn(),
  mockBuildFields: vi.fn(),
  mockSettleMeetingIfBillable: vi.fn(),
  mockResolveOnBehalf: vi.fn(),
  mockReportRefused: vi.fn(),
  mockResolveSubject: vi.fn(),
  mockLogInfo: vi.fn(),
  mockLogWarn: vi.fn(),
  mockLogError: vi.fn(),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: mockLogInfo,
    warn: mockLogWarn,
    error: mockLogError,
  }),
}));
vi.mock('@balo/db', () => ({
  creditSessionsRepository: {
    findIdByMeetingId: mockFindIdByMeetingId,
    markSessionlessCaseMeeting: mockMarkSessionless,
    openAndSettleFromPresence: mockOpenAndSettle,
  },
  meetingsRepository: { findById: mockMeetingFindById },
  meetingContextsRepository: { listByMeeting: mockListByMeeting },
  meetingPresenceRepository: { clientPartyIdentities: mockClientPartyIdentities },
  expertsRepository: { findUserIdByProfileId: mockFindUserIdByProfileId },
}));
vi.mock('./settle-from-presence.js', () => ({
  computeMeetingPresenceSettlement: mockCompute,
  completePresenceSettlement: mockComplete,
  buildSettlementRepoFields: mockBuildFields,
  settleMeetingIfBillable: mockSettleMeetingIfBillable,
}));
vi.mock('./open-on-behalf-of-booker.js', () => ({ resolveOnBehalfOpenInput: mockResolveOnBehalf }));
vi.mock('./report-session-open-refused.js', () => ({
  reportSessionOpenRefused: mockReportRefused,
}));
vi.mock('./case-billing-subject.js', () => ({ resolveCaseBillingSubject: mockResolveSubject }));
// ⚠ `@balo/shared/meetings` is NOT mocked — the real `selectPrimaryMeetingContext` decides "is this a
// Case", and the finder's SQL mirror of it is pinned against the same function by an integration test.

import {
  SESSIONLESS_BACKSTOP_BATCH_LIMIT,
  SESSIONLESS_BACKSTOP_GRACE_MINUTES,
  SESSIONLESS_BACKSTOP_RETRY_HOURS,
  SESSIONLESS_BACKSTOP_WINDOW_HOURS,
  backstopWindowClosing,
  exhaustSessionlessCaseMeeting,
  settleSessionlessCaseMeeting,
  withinBackstopWindow,
} from './settle-sessionless-case-meeting.js';

const MEETING_ID = 'meeting-1';
const NOW = new Date('2026-09-25T12:00:00.000Z');
const HOUR = 60 * 60_000;

function meeting(overrides: Record<string, unknown> = {}) {
  return {
    id: MEETING_ID,
    status: 'ended',
    scheduledStart: new Date(NOW.getTime() - 2 * HOUR),
    scheduledEnd: new Date(NOW.getTime() - HOUR),
    endedAt: new Date(NOW.getTime() - HOUR),
    // A READY venue by default (BAL-581): the stamped name is the derived one.
    dailyRoomName: dailyRoomNameForMeeting(MEETING_ID),
    joinUrl: `https://balo.daily.co/${dailyRoomNameForMeeting(MEETING_ID)}`,
    venueProvisionedAt: new Date(NOW.getTime() - 3 * HOUR),
    createdAt: new Date(NOW.getTime() - 4 * HOUR),
    ...overrides,
  };
}

function settlement(shape: string, outcome = 'no_show_client') {
  return { shape, outcome, billableMinutes: 15, actualMinutes: 15 };
}

const SUBJECT = {
  engagementId: 'engagement-1',
  companyId: 'company-1',
  expertProfileId: 'expert-1',
};
const OPEN_INPUT = {
  walletId: 'wallet-1',
  companyId: 'company-1',
  expertProfileId: 'expert-1',
  initiatingMemberId: 'booker-1',
  estimatedMinutes: 30,
  meetingId: MEETING_ID,
  engagementId: 'engagement-1',
  durationSource: 'presence',
  fundingPolicy: 'overdraft_tolerant',
  openedBy: 'system',
};
const REPO_RESULT = {
  session: { id: 'session-1' },
  overdraftMinor: 10_500,
  alreadySettled: false,
};

const INPUT = {
  meetingId: MEETING_ID,
  trigger: 'lifecycle_sweep',
  actorUserId: null,
  now: NOW,
} as const;

describe('settleSessionlessCaseMeeting (BAL-474, ADR-1040 Amendment 7 §C.6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindIdByMeetingId.mockResolvedValue(undefined);
    mockMeetingFindById.mockResolvedValue(meeting());
    mockListByMeeting.mockResolvedValue([{ contextType: 'case', contextId: 'engagement-1' }]);
    mockCompute.mockResolvedValue(settlement('no_show_client'));
    mockBuildFields.mockReturnValue({ billableMinutes: 15, __fields: true });
    mockResolveOnBehalf.mockResolvedValue({ ok: true, open: OPEN_INPUT, subject: SUBJECT });
    mockOpenAndSettle.mockResolvedValue({
      ok: true,
      toleratedGates: ['negative_balance'],
      settled: REPO_RESULT,
    });
    mockComplete.mockResolvedValue({
      ok: true,
      settlement: settlement('no_show_client'),
      result: {},
    });
    mockMarkSessionless.mockResolvedValue({ markerId: 'marker-1', outcomeWritten: true });
    mockSettleMeetingIfBillable.mockResolvedValue({ ok: false, code: 'already_settled' });
    mockClientPartyIdentities.mockResolvedValue({ memberUserIds: [], guestInviterIds: [] });
    mockFindUserIdByProfileId.mockResolvedValue({ user: { id: 'expert-user-1' } });
    mockReportRefused.mockResolvedValue(undefined);
  });

  it('pins the backstop constants (the finder window, the retry exhaustion point, the grace and the batch)', () => {
    expect(SESSIONLESS_BACKSTOP_GRACE_MINUTES).toBe(2);
    expect(SESSIONLESS_BACKSTOP_WINDOW_HOURS).toBe(72);
    expect(SESSIONLESS_BACKSTOP_RETRY_HOURS).toBe(25);
    expect(SESSIONLESS_BACKSTOP_BATCH_LIMIT).toBe(100);
  });

  describe('withinBackstopWindow / backstopWindowClosing (D10.2)', () => {
    it('a deferral is retryable only while the finder has a tick left: the LAST hour of the 72h window is closing (the boundary at now − 71h is inclusive)', () => {
      const edge = new Date(NOW.getTime() - 71 * HOUR);
      expect(withinBackstopWindow({ scheduledStart: new Date(edge.getTime() + 1) }, NOW)).toBe(
        true
      );
      expect(backstopWindowClosing({ scheduledStart: new Date(edge.getTime() + 1) }, NOW)).toBe(
        false
      );
      expect(withinBackstopWindow({ scheduledStart: edge }, NOW)).toBe(false);
      expect(backstopWindowClosing({ scheduledStart: edge }, NOW)).toBe(true);
    });

    it('a meeting past the finder’s 72h window is closing too', () => {
      const past = { scheduledStart: new Date(NOW.getTime() - 72 * HOUR - 1) };
      expect(backstopWindowClosing(past, NOW)).toBe(true);
      expect(withinBackstopWindow(past, NOW)).toBe(false);
    });
  });

  describe('a session already exists', () => {
    it('settles THAT session through the ordinary presence settlement, with the trigger’s actor and `now`', async () => {
      mockFindIdByMeetingId.mockResolvedValue({ id: 'session-existing' });
      const outcome = { ok: true, settlement: settlement('held'), result: {} };
      mockSettleMeetingIfBillable.mockResolvedValue(outcome);

      await expect(
        settleSessionlessCaseMeeting({ ...INPUT, trigger: 'human_end', actorUserId: 'ender-1' })
      ).resolves.toEqual({ kind: 'settled_existing_session', outcome });

      expect(mockSettleMeetingIfBillable).toHaveBeenCalledTimes(1);
      expect(mockSettleMeetingIfBillable).toHaveBeenCalledWith({
        meetingId: MEETING_ID,
        actorUserId: 'ender-1',
        now: NOW,
        trigger: 'human_end',
      });
      expect(mockOpenAndSettle).not.toHaveBeenCalled();
      expect(mockMeetingFindById).not.toHaveBeenCalled();
    });
  });

  describe('nothing to open', () => {
    it('a missing meeting is not billable, and writes no marker', async () => {
      mockMeetingFindById.mockResolvedValue(undefined);
      await expect(settleSessionlessCaseMeeting(INPUT)).resolves.toEqual({
        kind: 'not_billable',
        reason: 'meeting_not_found',
      });
      expect(mockMarkSessionless).not.toHaveBeenCalled();
    });

    it('a meeting that is not ENDED is not billable, and writes no marker', async () => {
      mockMeetingFindById.mockResolvedValue(meeting({ status: 'in_progress' }));
      await expect(settleSessionlessCaseMeeting(INPUT)).resolves.toEqual({
        kind: 'not_billable',
        reason: 'meeting_not_terminal',
      });
      expect(mockMarkSessionless).not.toHaveBeenCalled();
      expect(mockCompute).not.toHaveBeenCalled();
    });

    it.each([
      ['a non-Case primary context', [{ contextType: 'project_discovery', contextId: 'req-1' }]],
      ['an unresolvable primary context (none)', []],
    ])('%s is silent — no marker, no shape read, no alarm', async (_label, contexts) => {
      mockListByMeeting.mockResolvedValue(contexts);
      await expect(settleSessionlessCaseMeeting(INPUT)).resolves.toEqual({
        kind: 'not_billable',
        reason: 'not_a_case_meeting',
      });
      expect(mockMarkSessionless).not.toHaveBeenCalled();
      expect(mockCompute).not.toHaveBeenCalled();
      expect(mockReportRefused).not.toHaveBeenCalled();
    });
  });

  describe('the ZERO shapes owe nothing (D5.3) — marked so the row leaves the finder, and silent', () => {
    it.each([
      ['missed_call', 'missed_call'],
      ['abandoned_wait', 'completed'],
    ])(
      '%s ⇒ a not_billable marker with the shape and the outcome, and NO subject / booker / wallet read',
      async (shape, outcome) => {
        mockCompute.mockResolvedValue(settlement(shape, outcome));

        await expect(settleSessionlessCaseMeeting(INPUT)).resolves.toEqual({
          kind: 'not_billable',
          reason: 'zero_shape',
        });

        expect(mockMarkSessionless).toHaveBeenCalledWith({
          meetingId: MEETING_ID,
          disposition: 'not_billable',
          reason: shape,
          trigger: 'lifecycle_sweep',
          shape,
          outcome,
        });
        expect(mockResolveOnBehalf).not.toHaveBeenCalled();
        expect(mockOpenAndSettle).not.toHaveBeenCalled();
        expect(mockReportRefused).not.toHaveBeenCalled();
      }
    );

    it.each([
      ['never provisioned', { dailyRoomName: null, joinUrl: null, venueProvisionedAt: null }],
      ['stamped with a foreign room name', { dailyRoomName: 'balo-someone-else' }],
    ])(
      '⚠ BAL-581 — a missed_call shape on a meeting whose room was %s resolves venue_unavailable, never missed_call',
      async (_label, venue) => {
        mockMeetingFindById.mockResolvedValue(meeting(venue));
        mockCompute.mockResolvedValue(settlement('missed_call', 'missed_call'));

        await expect(settleSessionlessCaseMeeting(INPUT)).resolves.toEqual({
          kind: 'not_billable',
          reason: 'zero_shape',
        });

        expect(mockMarkSessionless).toHaveBeenCalledTimes(1);
        expect(mockMarkSessionless).toHaveBeenCalledWith({
          meetingId: MEETING_ID,
          disposition: 'not_billable',
          reason: 'missed_call',
          trigger: 'lifecycle_sweep',
          shape: 'missed_call',
          outcome: 'venue_unavailable',
        });
        expect(mockOpenAndSettle).not.toHaveBeenCalled();
        expect(mockReportRefused).not.toHaveBeenCalled();
      }
    );

    it('an abandoned_wait shape keeps its own outcome whatever the venue — the expert was in a room', async () => {
      mockMeetingFindById.mockResolvedValue(meeting({ dailyRoomName: null, joinUrl: null }));
      mockCompute.mockResolvedValue(settlement('abandoned_wait', 'completed'));

      await settleSessionlessCaseMeeting(INPUT);

      expect(mockMarkSessionless).toHaveBeenCalledWith(
        expect.objectContaining({ shape: 'abandoned_wait', outcome: 'completed' })
      );
    });

    it('⚠ R1-F5 — the SHAPE is computed BEFORE any refusal branch: a zero shape whose engagement is gone is a marker, never an alarm', async () => {
      mockCompute.mockResolvedValue(settlement('missed_call', 'missed_call'));
      mockResolveOnBehalf.mockResolvedValue({
        ok: false,
        code: 'meeting_not_bookable',
        companyId: null,
      });

      await expect(settleSessionlessCaseMeeting(INPUT)).resolves.toMatchObject({
        kind: 'not_billable',
      });
      expect(mockReportRefused).not.toHaveBeenCalled();
    });

    it('computes the shape from a FROM-ZERO settlement of the ended meeting', async () => {
      await settleSessionlessCaseMeeting(INPUT);
      expect(mockCompute).toHaveBeenCalledWith({
        meeting: expect.objectContaining({ id: MEETING_ID }),
        sessionId: null,
        minutesAlreadyDrawn: 0,
        now: NOW,
        resolveExpertProfileId: expect.any(Function),
      });
    });

    it('R6F-4a — hands the settlement a LAZY resolver for the delivering expert, read from the case’s own engagement row', async () => {
      mockResolveSubject.mockResolvedValue(SUBJECT);
      await settleSessionlessCaseMeeting(INPUT);
      const [{ resolveExpertProfileId }] = mockCompute.mock.calls[0] as [
        { resolveExpertProfileId: () => Promise<string | null> },
      ];
      // Lazy: nothing is read until the repository asks (only when a client-party guest row exists).
      expect(mockResolveSubject).not.toHaveBeenCalled();
      await expect(resolveExpertProfileId()).resolves.toBe('expert-1');
      expect(mockResolveSubject).toHaveBeenCalledWith(MEETING_ID, { requireActive: false });
      mockResolveSubject.mockResolvedValue(undefined);
      await expect(resolveExpertProfileId()).resolves.toBeNull();
    });
  });

  describe('a BILLABLE shape opens and settles in ONE transaction (AD-3)', () => {
    it.each(['no_show_client', 'held'])(
      '%s ⇒ openAndSettleFromPresence with the system opener, then the SAME post-commit tail',
      async (shape) => {
        mockCompute.mockResolvedValue(settlement(shape, 'completed'));

        const result = await settleSessionlessCaseMeeting({
          ...INPUT,
          trigger: 'human_end',
          actorUserId: 'ender-1',
        });

        expect(mockBuildFields).toHaveBeenCalledWith(settlement(shape, 'completed'), {
          minutesAlreadyDrawn: 0,
          actorUserId: 'ender-1',
          now: NOW,
        });
        expect(mockOpenAndSettle).toHaveBeenCalledWith({
          open: { ...OPEN_INPUT, openedBy: 'system' },
          settlement: { billableMinutes: 15, __fields: true },
        });
        expect(mockComplete).toHaveBeenCalledWith({
          repoResult: REPO_RESULT,
          settlement: settlement(shape, 'completed'),
          meetingId: MEETING_ID,
          sessionId: 'session-1',
          now: NOW,
        });
        expect(result).toEqual({
          kind: 'opened_and_settled',
          sessionId: 'session-1',
          toleratedGates: ['negative_balance'],
          outcome: { ok: true, settlement: settlement('no_show_client'), result: {} },
        });
        expect(mockMarkSessionless).not.toHaveBeenCalled();
        expect(mockLogInfo).toHaveBeenCalledWith(
          expect.objectContaining({
            meetingId: MEETING_ID,
            sessionId: 'session-1',
            trigger: 'human_end',
            shape,
            overdraftMinor: 10_500,
          }),
          'Sessionless Case meeting opened and settled on behalf of the booker'
        );
      }
    );

    it('resolves the subject, booker and wallet ONCE, with the trigger and the meeting’s own window', async () => {
      await settleSessionlessCaseMeeting(INPUT);
      expect(mockResolveOnBehalf).toHaveBeenCalledTimes(1);
      expect(mockResolveOnBehalf).toHaveBeenCalledWith(
        expect.objectContaining({
          meetingId: MEETING_ID,
          openedBy: 'system',
          trigger: 'lifecycle_sweep',
          window: expect.objectContaining({ id: MEETING_ID }),
        })
      );
    });

    it.each([
      ['no_show_client', false],
      ['held', true],
    ])(
      '⚠ D12.1(c) — the %s shape is opened with attended=%s: a closure voids only the UNATTENDED floor no-show, never a held call',
      async (shape, attended) => {
        mockCompute.mockResolvedValue(settlement(shape));
        await settleSessionlessCaseMeeting(INPUT);
        expect(mockResolveOnBehalf).toHaveBeenCalledWith(expect.objectContaining({ attended }));
      }
    );

    it('a thrown open PROPAGATES — the callers’ per-row catches log it and the backstop retries', async () => {
      mockOpenAndSettle.mockRejectedValue(new Error('db unavailable'));
      await expect(settleSessionlessCaseMeeting(INPUT)).rejects.toThrow('db unavailable');
      expect(mockComplete).not.toHaveBeenCalled();
    });

    it('a thrown post-commit tail propagates too (the backstop re-reads before it exhausts — V4-F3)', async () => {
      mockComplete.mockRejectedValue(new Error('finalize failed'));
      await expect(settleSessionlessCaseMeeting(INPUT)).rejects.toThrow('finalize failed');
    });
  });

  describe('D5.9 — a held call attended only by guests the delivering expert invited is not billed on the client', () => {
    /** Runs the guard `resolveOnBehalfOpenInput` was handed, exactly as the real resolver would. */
    function runTheGuard() {
      mockResolveOnBehalf.mockImplementation(
        async (input: { guard?: (s: typeof SUBJECT) => Promise<string | undefined> }) => {
          const verdict = input.guard === undefined ? undefined : await input.guard(SUBJECT);
          return verdict === undefined
            ? { ok: true, open: OPEN_INPUT, subject: SUBJECT }
            : { ok: false, code: verdict, companyId: 'company-1' };
        }
      );
    }

    beforeEach(() => {
      mockCompute.mockResolvedValue(settlement('held', 'completed'));
      runTheGuard();
    });

    it('marks it not_billable (expert_invited_guest_only), warns, and opens nothing — no alarm', async () => {
      mockClientPartyIdentities.mockResolvedValue({
        memberUserIds: [],
        guestInviterIds: ['expert-user-1', 'expert-user-1'],
      });

      await expect(settleSessionlessCaseMeeting(INPUT)).resolves.toEqual({
        kind: 'not_billable',
        reason: 'expert_invited_guest_only',
      });
      expect(mockMarkSessionless).toHaveBeenCalledWith({
        meetingId: MEETING_ID,
        disposition: 'not_billable',
        reason: 'expert_invited_guest_only',
        trigger: 'lifecycle_sweep',
        shape: 'held',
        outcome: 'completed',
      });
      expect(mockLogWarn).toHaveBeenCalled();
      expect(mockOpenAndSettle).not.toHaveBeenCalled();
      expect(mockReportRefused).not.toHaveBeenCalled();
    });

    it.each([
      [
        'a client MEMBER was present',
        { memberUserIds: ['member-1'], guestInviterIds: ['expert-user-1'] },
      ],
      ['no client-party guest was present', { memberUserIds: [], guestInviterIds: [] }],
      [
        'ONE guest was invited by someone else',
        { memberUserIds: [], guestInviterIds: ['expert-user-1', 'booker-1'] },
      ],
      ['a guest has no inviter', { memberUserIds: [], guestInviterIds: [null] }],
    ])('does NOT skip when %s — the call is billed', async (_label, identities) => {
      mockClientPartyIdentities.mockResolvedValue(identities);
      await expect(settleSessionlessCaseMeeting(INPUT)).resolves.toMatchObject({
        kind: 'opened_and_settled',
      });
    });

    it('does NOT skip when the delivering expert has no user (fail closed toward billing the booked call)', async () => {
      mockClientPartyIdentities.mockResolvedValue({ memberUserIds: [], guestInviterIds: ['x'] });
      mockFindUserIdByProfileId.mockResolvedValue(undefined);
      await expect(settleSessionlessCaseMeeting(INPUT)).resolves.toMatchObject({
        kind: 'opened_and_settled',
      });
    });

    it('the guard is applied ONLY to a `held` shape — a floor no-show never consults it', async () => {
      mockCompute.mockResolvedValue(settlement('no_show_client'));
      await settleSessionlessCaseMeeting(INPUT);
      expect(mockClientPartyIdentities).not.toHaveBeenCalled();
      expect(mockResolveOnBehalf).toHaveBeenCalledWith(
        expect.objectContaining({ guard: undefined })
      );
    });
  });

  describe('permanent refusals: a marker, ONE alarm, and a `refused` result', () => {
    it.each(['meeting_not_bookable', 'booker_unattributable'] as const)(
      'the subject / booker refusal %s ⇒ refused marker + alarm with the billing company',
      async (code) => {
        mockResolveOnBehalf.mockResolvedValue({ ok: false, code, companyId: 'company-1' });

        await expect(settleSessionlessCaseMeeting(INPUT)).resolves.toEqual({
          kind: 'refused',
          reason: code,
        });

        expect(mockMarkSessionless).toHaveBeenCalledWith({
          meetingId: MEETING_ID,
          disposition: 'refused',
          reason: code,
          trigger: 'lifecycle_sweep',
          shape: 'no_show_client',
          outcome: 'no_show_client',
        });
        expect(mockReportRefused).toHaveBeenCalledTimes(1);
        expect(mockReportRefused).toHaveBeenCalledWith(code, {
          meetingId: MEETING_ID,
          companyId: 'company-1',
          userId: null,
          openedBy: 'system',
        });
        expect(mockOpenAndSettle).not.toHaveBeenCalled();
      }
    );

    it.each(['no_show_client', 'held'])(
      '⚠ D10.5 — a case closed BEFORE the meeting started (%s shape) ⇒ a not_billable marker, NO alarm, nothing opened',
      async (shape) => {
        mockCompute.mockResolvedValue(settlement(shape, 'completed'));
        mockResolveOnBehalf.mockResolvedValue({
          ok: false,
          code: 'case_closed_before_start',
          companyId: 'company-1',
        });

        await expect(settleSessionlessCaseMeeting(INPUT)).resolves.toEqual({
          kind: 'not_billable',
          reason: 'case_closed_before_start',
        });

        expect(mockMarkSessionless).toHaveBeenCalledWith({
          meetingId: MEETING_ID,
          disposition: 'not_billable',
          reason: 'case_closed_before_start',
          trigger: 'lifecycle_sweep',
          shape,
          outcome: 'completed',
        });
        expect(mockReportRefused).not.toHaveBeenCalled();
        expect(mockOpenAndSettle).not.toHaveBeenCalled();
        expect(mockLogInfo).toHaveBeenCalledWith(
          expect.objectContaining({ meetingId: MEETING_ID }),
          expect.stringContaining('closed before the meeting started')
        );
      }
    );

    it('an unresolved company alarms with a null company', async () => {
      mockResolveOnBehalf.mockResolvedValue({
        ok: false,
        code: 'meeting_not_bookable',
        companyId: null,
      });
      await settleSessionlessCaseMeeting(INPUT);
      expect(mockReportRefused).toHaveBeenCalledWith(
        'meeting_not_bookable',
        expect.objectContaining({ companyId: null })
      );
    });

    it('expert_rate_missing (from the open) ⇒ refused marker + alarm', async () => {
      mockOpenAndSettle.mockResolvedValue({ ok: false, code: 'expert_rate_missing' });
      await expect(settleSessionlessCaseMeeting(INPUT)).resolves.toEqual({
        kind: 'refused',
        reason: 'expert_rate_missing',
      });
      expect(mockMarkSessionless).toHaveBeenCalledWith(
        expect.objectContaining({ disposition: 'refused', reason: 'expert_rate_missing' })
      );
      expect(mockReportRefused).toHaveBeenCalledWith(
        'expert_rate_missing',
        expect.objectContaining({ companyId: 'company-1', openedBy: 'system' })
      );
      expect(mockComplete).not.toHaveBeenCalled();
    });
  });

  describe('transient refusals', () => {
    it('meeting_session_exists (a racing path won) ⇒ settle THAT session — never a second', async () => {
      mockOpenAndSettle.mockResolvedValue({
        ok: false,
        code: 'meeting_session_exists',
        existingSessionId: 'session-winner',
      });
      const outcome = { ok: false, code: 'already_settled' };
      mockSettleMeetingIfBillable.mockResolvedValue(outcome);

      await expect(
        settleSessionlessCaseMeeting({ ...INPUT, trigger: 'backstop' })
      ).resolves.toEqual({ kind: 'settled_existing_session', outcome });
      expect(mockSettleMeetingIfBillable).toHaveBeenCalledWith({
        meetingId: MEETING_ID,
        actorUserId: null,
        now: NOW,
        trigger: 'backstop',
      });
      expect(mockMarkSessionless).not.toHaveBeenCalled();
    });

    it('session_in_progress INSIDE the backstop window ⇒ deferred (a warn) — no marker, no alarm', async () => {
      mockOpenAndSettle.mockResolvedValue({ ok: false, code: 'session_in_progress' });
      await expect(settleSessionlessCaseMeeting(INPUT)).resolves.toEqual({
        kind: 'deferred',
        reason: 'session_in_progress',
        outcome: 'no_show_client',
      });
      expect(mockLogWarn).toHaveBeenCalledWith(
        expect.objectContaining({ meetingId: MEETING_ID }),
        expect.stringContaining('deferred')
      );
      expect(mockMarkSessionless).not.toHaveBeenCalled();
      expect(mockReportRefused).not.toHaveBeenCalled();
    });

    it('⚠ session_in_progress OUTSIDE the window ⇒ EXHAUSTED at once (no backstop will ever select it): marker + retry_exhausted alarm', async () => {
      mockMeetingFindById.mockResolvedValue(
        meeting({ scheduledStart: new Date(NOW.getTime() - 100 * HOUR) })
      );
      mockOpenAndSettle.mockResolvedValue({ ok: false, code: 'session_in_progress' });

      await expect(settleSessionlessCaseMeeting(INPUT)).resolves.toEqual({
        kind: 'refused',
        reason: 'retry_exhausted',
      });
      expect(mockMarkSessionless).toHaveBeenCalledWith({
        meetingId: MEETING_ID,
        disposition: 'retry_exhausted',
        reason: 'session_in_progress',
        trigger: 'lifecycle_sweep',
        shape: 'no_show_client',
        outcome: 'no_show_client',
      });
      expect(mockReportRefused).toHaveBeenCalledWith('retry_exhausted', {
        meetingId: MEETING_ID,
        companyId: 'company-1',
        userId: null,
        openedBy: 'system',
      });
    });

    it('⚠ D10.2 — session_in_progress in the finder’s LAST hour (a late-ended meeting) is exhausted at once — the backstop has no further tick', async () => {
      mockMeetingFindById.mockResolvedValue(
        meeting({ scheduledStart: new Date(NOW.getTime() - 71.5 * HOUR) })
      );
      mockOpenAndSettle.mockResolvedValue({ ok: false, code: 'session_in_progress' });

      await expect(settleSessionlessCaseMeeting(INPUT)).resolves.toEqual({
        kind: 'refused',
        reason: 'retry_exhausted',
      });
      expect(mockMarkSessionless).toHaveBeenCalledWith(
        expect.objectContaining({ disposition: 'retry_exhausted', reason: 'session_in_progress' })
      );
    });

    it.each(['account_hold', 'settlement_pending', 'insufficient_no_mandate'] as const)(
      'a GATED refusal (%s) is unreachable under the tolerant policy — it THROWS, never a silent skip',
      async (code) => {
        mockOpenAndSettle.mockResolvedValue({ ok: false, code });
        await expect(settleSessionlessCaseMeeting(INPUT)).rejects.toThrow(
          `sessionless open returned a gated refusal: ${code}`
        );
        expect(mockLogError).toHaveBeenCalled();
      }
    );
  });

  describe('`now` defaults to the wall clock', () => {
    it('uses a fresh Date when the caller passes none', async () => {
      mockFindIdByMeetingId.mockResolvedValue({ id: 'session-existing' });
      await settleSessionlessCaseMeeting({
        meetingId: MEETING_ID,
        trigger: 'backstop',
        actorUserId: null,
      });
      const [call] = mockSettleMeetingIfBillable.mock.calls[0] as [{ now: Date }];
      expect(call.now).toBeInstanceOf(Date);
    });
  });
});

describe('exhaustSessionlessCaseMeeting (D5.5 / D7.5 — the backstop pass’s exhaustion)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveSubject.mockResolvedValue(SUBJECT);
    mockMarkSessionless.mockResolvedValue({ markerId: 'marker-1', outcomeWritten: false });
    mockReportRefused.mockResolvedValue(undefined);
  });

  it('writes the retry_exhausted marker and raises ONE alarm with the resolved billing company', async () => {
    await exhaustSessionlessCaseMeeting({
      meetingId: MEETING_ID,
      reason: 'session_in_progress',
      trigger: 'backstop',
    });

    expect(mockResolveSubject).toHaveBeenCalledWith(MEETING_ID, { requireActive: false });
    expect(mockMarkSessionless).toHaveBeenCalledWith({
      meetingId: MEETING_ID,
      disposition: 'retry_exhausted',
      reason: 'session_in_progress',
      trigger: 'backstop',
    });
    expect(mockReportRefused).toHaveBeenCalledTimes(1);
    expect(mockReportRefused).toHaveBeenCalledWith('retry_exhausted', {
      meetingId: MEETING_ID,
      companyId: 'company-1',
      userId: null,
      openedBy: 'system',
    });
  });

  it('forwards the deferred attempt’s `outcome` to the marker, so meetings.outcome is resolved with it', async () => {
    await exhaustSessionlessCaseMeeting({
      meetingId: MEETING_ID,
      reason: 'session_in_progress',
      trigger: 'backstop',
      outcome: 'no_show_client',
    });
    expect(mockMarkSessionless).toHaveBeenCalledWith({
      meetingId: MEETING_ID,
      disposition: 'retry_exhausted',
      reason: 'session_in_progress',
      trigger: 'backstop',
      outcome: 'no_show_client',
    });
  });

  it('a throwing company lookup is logged as a warn WITH its stack — never swallowed silently', async () => {
    mockResolveSubject.mockRejectedValue(new Error('db down'));
    await exhaustSessionlessCaseMeeting({
      meetingId: MEETING_ID,
      reason: 'error',
      trigger: 'backstop',
    });
    expect(mockLogWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        meetingId: MEETING_ID,
        error: 'db down',
        stack: expect.stringContaining('db down'),
      }),
      expect.stringContaining('could not resolve the billing company')
    );
  });

  it('an `error` exhaustion carries its own reason', async () => {
    await exhaustSessionlessCaseMeeting({
      meetingId: MEETING_ID,
      reason: 'error',
      trigger: 'backstop',
    });
    expect(mockMarkSessionless).toHaveBeenCalledWith(
      expect.objectContaining({ disposition: 'retry_exhausted', reason: 'error' })
    );
  });

  it.each([
    ['throws', () => mockResolveSubject.mockRejectedValue(new Error('db down'))],
    ['resolves nothing', () => mockResolveSubject.mockResolvedValue(undefined)],
  ])(
    'an unresolvable billing company (the lookup %s) never blocks the marker or the alarm',
    async (_label, arrange) => {
      arrange();
      await exhaustSessionlessCaseMeeting({
        meetingId: MEETING_ID,
        reason: 'session_in_progress',
        trigger: 'backstop',
      });
      expect(mockMarkSessionless).toHaveBeenCalledTimes(1);
      expect(mockReportRefused).toHaveBeenCalledWith(
        'retry_exhausted',
        expect.objectContaining({ companyId: null })
      );
    }
  );
});

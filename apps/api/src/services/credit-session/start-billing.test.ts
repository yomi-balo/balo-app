import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockFindIdByMeetingId,
  mockFindById,
  mockOpen,
  mockResolveOnBehalf,
  mockConnect,
  mockGuardFor,
  mockGuard,
  mockTrackServer,
  mockCaptureException,
  mockLogInfo,
  mockLogWarn,
  mockLogError,
  mockLogDebug,
  mockOnlyGuests,
  mockListContexts,
  InvalidSessionTransitionErrorStub,
} = vi.hoisted(() => {
  const guard = vi.fn();
  return {
    mockFindIdByMeetingId: vi.fn(),
    mockFindById: vi.fn(),
    mockOpen: vi.fn(),
    mockResolveOnBehalf: vi.fn(),
    mockConnect: vi.fn(),
    mockGuard: guard,
    mockGuardFor: vi.fn(() => guard),
    mockTrackServer: vi.fn(),
    mockCaptureException: vi.fn(),
    mockLogInfo: vi.fn(),
    mockLogWarn: vi.fn(),
    mockLogError: vi.fn(),
    mockLogDebug: vi.fn(),
    mockOnlyGuests: vi.fn(),
    mockListContexts: vi.fn(),
    // The real class is what `start-billing.ts` tests with `instanceof` (R6F-7).
    InvalidSessionTransitionErrorStub: class InvalidSessionTransitionError extends Error {},
  };
});

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({
    debug: mockLogDebug,
    info: mockLogInfo,
    warn: mockLogWarn,
    error: mockLogError,
  }),
}));
vi.mock('@sentry/node', () => ({ captureException: mockCaptureException }));
vi.mock('@balo/db', () => ({
  InvalidSessionTransitionError: InvalidSessionTransitionErrorStub,
  creditSessionsRepository: {
    findIdByMeetingId: mockFindIdByMeetingId,
    findById: mockFindById,
    open: mockOpen,
  },
  meetingContextsRepository: { listByMeeting: mockListContexts },
}));
vi.mock('@balo/analytics/server', () => ({
  trackServer: mockTrackServer,
  SESSION_SERVER_EVENTS: { SESSION_STARTED: 'session_started' },
}));
vi.mock('./open-on-behalf-of-booker.js', () => ({ resolveOnBehalfOpenInput: mockResolveOnBehalf }));
vi.mock('./expert-invited-guest-guard.js', () => ({
  expertInvitedGuestGuard: mockGuardFor,
  onlyExpertInvitedGuestsAttended: mockOnlyGuests,
}));
vi.mock('./connect-session.js', () => ({ connectSessionAsSystem: mockConnect }));
// ⚠ `@balo/shared/meetings` is NOT mocked — `currentCoPresenceStartedAt`, `isTerminalMeetingStatus` and
// `selectPrimaryMeetingContext` ARE the anchor, the terminal rule and the Case rule this seam is about.

import { startBillingIfDue, BILLING_START_TRIGGER } from './start-billing.js';

const MEETING_ID = 'meeting-1';
const START = new Date('2026-09-27T10:00:00.000Z');
const at = (minutes: number): Date => new Date(START.getTime() + minutes * 60_000);

const MEETING = {
  id: MEETING_ID,
  status: 'in_progress',
  scheduledStart: START,
  scheduledEnd: at(60),
} as never;

const row = (
  party: 'expert' | 'client' | 'observer',
  fromMinutes: number,
  userId: string | null = null
) => ({ party, joinedAt: at(fromMinutes), leftAt: null, userId });

const CO_PRESENT = [row('expert', -10, 'expert-user'), row('client', -10, 'member-1')];

const CONNECTED = {
  id: 'session-1',
  companyId: 'company-1',
  expertProfileId: 'expert-1',
  clientRateMinorPerMinute: 700,
  status: 'active',
};

const CASE_CONTEXT = [{ contextType: 'case', contextId: 'engagement-1' }];

describe('startBillingIfDue (BAL-474, Rule A — the start-billing seam)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindIdByMeetingId.mockResolvedValue({ id: 'session-1' });
    mockFindById.mockResolvedValue({
      id: 'session-1',
      status: 'pending',
      expertProfileId: 'expert-1',
    });
    mockConnect.mockResolvedValue({ session: CONNECTED, transitioned: true });
    mockListContexts.mockResolvedValue(CASE_CONTEXT);
    mockOnlyGuests.mockResolvedValue(false);
    mockResolveOnBehalf.mockResolvedValue({
      ok: true,
      open: { walletId: 'wallet-1', meetingId: MEETING_ID, openedBy: 'system' },
      subject: { companyId: 'company-1' },
    });
    mockOpen.mockResolvedValue({ ok: true, session: { id: 'session-1' }, toleratedGates: [] });
  });

  describe('not due — with ZERO reads', () => {
    it('before the scheduled start (the meter never starts before T)', async () => {
      await expect(
        startBillingIfDue({ meeting: MEETING, openRows: CO_PRESENT, now: at(-1) })
      ).resolves.toEqual({ kind: 'not_due' });
      expect(mockFindIdByMeetingId).not.toHaveBeenCalled();
      expect(mockConnect).not.toHaveBeenCalled();
    });

    it.each(['ended', 'cancelled'])('a %s meeting', async (status) => {
      await expect(
        startBillingIfDue({
          meeting: { ...(MEETING as object), status } as never,
          openRows: CO_PRESENT,
          now: at(5),
        })
      ).resolves.toEqual({ kind: 'not_due' });
      expect(mockFindIdByMeetingId).not.toHaveBeenCalled();
    });

    it('EXACTLY at the start it IS due (the boundary is inclusive)', async () => {
      await expect(
        startBillingIfDue({ meeting: MEETING, openRows: CO_PRESENT, now: START })
      ).resolves.toMatchObject({ kind: 'started' });
    });
  });

  describe('not co-present — with zero reads', () => {
    it.each([
      ['an empty room', []],
      ['only the expert', [row('expert', -10)]],
      ['only a client', [row('client', -10)]],
      ['an observer beside the expert', [row('expert', -10), row('observer', -10)]],
    ])('%s', async (_label, openRows) => {
      await expect(startBillingIfDue({ meeting: MEETING, openRows, now: at(5) })).resolves.toEqual({
        kind: 'not_co_present',
      });
      expect(mockFindIdByMeetingId).not.toHaveBeenCalled();
      expect(mockListContexts).not.toHaveBeenCalled();
    });
  });

  describe('is it a Case? — the PRIMARY-context rule, the same one admission and the sessionless path use (R6F-10a)', () => {
    it.each([
      ['no context at all', []],
      ['a project discovery call', [{ contextType: 'project_discovery', contextId: 'request-1' }]],
      ['an admin meeting (never primary)', [{ contextType: 'admin', contextId: null }]],
      [
        'two distinct top-precedence contexts (ambiguous)',
        [
          { contextType: 'case', contextId: 'engagement-1' },
          { contextType: 'case', contextId: 'engagement-2' },
        ],
      ],
    ])(
      '%s ⇒ deferred meeting_not_bookable, at debug, with no session read',
      async (_label, contexts) => {
        mockListContexts.mockResolvedValue(contexts);

        await expect(
          startBillingIfDue({ meeting: MEETING, openRows: CO_PRESENT, now: at(1) })
        ).resolves.toEqual({ kind: 'deferred', reason: 'meeting_not_bookable' });

        expect(mockLogDebug).toHaveBeenCalled();
        expect(mockFindIdByMeetingId).not.toHaveBeenCalled();
        expect(mockConnect).not.toHaveBeenCalled();
      }
    );

    it('a Case context proceeds; the contexts are read for THIS meeting, after the due and co-presence checks', async () => {
      await expect(
        startBillingIfDue({ meeting: MEETING, openRows: CO_PRESENT, now: at(1) })
      ).resolves.toMatchObject({ kind: 'started' });
      expect(mockListContexts).toHaveBeenCalledWith(MEETING_ID);
    });

    it('a Case plus a lower-precedence context still resolves to the Case', async () => {
      mockListContexts.mockResolvedValue([
        { contextType: 'admin', contextId: null },
        { contextType: 'case', contextId: 'engagement-1' },
      ]);
      await expect(
        startBillingIfDue({ meeting: MEETING, openRows: CO_PRESENT, now: at(1) })
      ).resolves.toMatchObject({ kind: 'started' });
    });
  });

  describe('the ANCHOR — max(scheduled start, the start of the running co-presence)', () => {
    it('⚠ a co-presence that began BEFORE the start connects at EXACTLY T — never earlier, never at `now`', async () => {
      const outcome = await startBillingIfDue({
        meeting: MEETING,
        openRows: CO_PRESENT,
        now: at(0.5),
      });
      expect(mockConnect).toHaveBeenCalledWith('session-1', { now: START });
      expect(outcome).toEqual({
        kind: 'started',
        sessionId: 'session-1',
        opened: false,
        connectedAt: START,
      });
    });

    it('a co-presence that began AFTER the start connects at that instant (the later of the two joins)', async () => {
      await startBillingIfDue({
        meeting: MEETING,
        openRows: [row('expert', 2, 'e'), row('client', 5, 'c')],
        now: at(5),
      });
      expect(mockConnect).toHaveBeenCalledWith('session-1', { now: at(5) });
    });
  });

  describe('a session already exists', () => {
    it('a `pending` one is CONNECTED with the anchor, and `session_started` fires with the company as the distinct id and the CLIENT rate', async () => {
      await startBillingIfDue({ meeting: MEETING, openRows: CO_PRESENT, now: at(1) });

      expect(mockOpen).not.toHaveBeenCalled();
      expect(mockConnect).toHaveBeenCalledTimes(1);
      expect(mockTrackServer).toHaveBeenCalledTimes(1);
      expect(mockTrackServer).toHaveBeenCalledWith('session_started', {
        session_id: 'session-1',
        meeting_id: MEETING_ID,
        expert_profile_id: 'expert-1',
        rate_per_minute_minor: 700,
        distinct_id: 'company-1',
      });
    });

    it('⚠⚠ R6F-4b — an EXISTING pending session is NOT connected when only guests the delivering expert invited are present: deferred expert_invited_guest, at debug', async () => {
      mockOnlyGuests.mockResolvedValue(true);

      await expect(
        startBillingIfDue({ meeting: MEETING, openRows: CO_PRESENT, now: at(1) })
      ).resolves.toEqual({ kind: 'deferred', reason: 'expert_invited_guest' });

      expect(mockOnlyGuests).toHaveBeenCalledWith(MEETING_ID, 'expert-1');
      expect(mockConnect).not.toHaveBeenCalled();
      expect(mockTrackServer).not.toHaveBeenCalled();
      expect(mockLogDebug).toHaveBeenCalledWith(
        expect.objectContaining({ meetingId: MEETING_ID, sessionId: 'session-1' }),
        expect.stringContaining('guests the delivering expert invited')
      );
      expect(mockCaptureException).not.toHaveBeenCalled();
    });

    it('a pending session with a real client attendee IS connected — the guard says no', async () => {
      mockOnlyGuests.mockResolvedValue(false);
      await expect(
        startBillingIfDue({ meeting: MEETING, openRows: CO_PRESENT, now: at(1) })
      ).resolves.toMatchObject({ kind: 'started' });
      expect(mockConnect).toHaveBeenCalledTimes(1);
    });

    it.each(['active', 'grace'])(
      'an %s session is a NO-OP — the first anchor wins, no second event',
      async (status) => {
        mockFindById.mockResolvedValue({ id: 'session-1', status });
        await expect(
          startBillingIfDue({ meeting: MEETING, openRows: CO_PRESENT, now: at(1) })
        ).resolves.toEqual({ kind: 'already_metering', sessionId: 'session-1' });
        expect(mockConnect).not.toHaveBeenCalled();
        expect(mockTrackServer).not.toHaveBeenCalled();
        // The guard is not consulted for a session that is already metering.
        expect(mockOnlyGuests).not.toHaveBeenCalled();
      }
    );

    it.each(['ended', 'cancelled'])(
      'an %s session (an End or cancel raced) logs at info — no Sentry, no connect',
      async (status) => {
        mockFindById.mockResolvedValue({ id: 'session-1', status });
        await expect(
          startBillingIfDue({ meeting: MEETING, openRows: CO_PRESENT, now: at(1) })
        ).resolves.toEqual({ kind: 'deferred', reason: 'session_not_pending' });
        expect(mockLogInfo).toHaveBeenCalledWith(
          expect.objectContaining({ sessionId: 'session-1', status }),
          expect.stringContaining('no longer pending')
        );
        expect(mockCaptureException).not.toHaveBeenCalled();
        expect(mockConnect).not.toHaveBeenCalled();
      }
    );
  });

  describe('no session yet — it OPENS one, then connects', () => {
    beforeEach(() => {
      mockFindIdByMeetingId.mockResolvedValue(undefined);
    });

    it('resolves the open with attended=true, the `billing_start` trigger, the meeting window and the expert-invited-guest guard', async () => {
      const outcome = await startBillingIfDue({
        meeting: MEETING,
        openRows: CO_PRESENT,
        now: at(1),
      });

      expect(mockResolveOnBehalf).toHaveBeenCalledTimes(1);
      expect(mockResolveOnBehalf).toHaveBeenCalledWith({
        meetingId: MEETING_ID,
        openedBy: 'system',
        trigger: BILLING_START_TRIGGER,
        window: MEETING,
        attended: true,
        onBehalfOfUserId: 'member-1',
        guard: mockGuard,
      });
      expect(BILLING_START_TRIGGER).toBe('billing_start');
      expect(mockGuardFor).toHaveBeenCalledWith(MEETING_ID);
      expect(mockOpen).toHaveBeenCalledTimes(1);
      expect(outcome).toMatchObject({ kind: 'started', opened: true });
      expect(mockConnect).toHaveBeenCalledWith('session-1', { now: START });
    });

    it('attributes the EARLIEST-joined present client MEMBER — a guest row has no user id and is never chosen', async () => {
      await startBillingIfDue({
        meeting: MEETING,
        openRows: [
          row('expert', -10, 'e'),
          row('client', -8, null),
          row('client', -6, 'later-member'),
          row('client', -9, 'earliest-member'),
        ],
        now: at(1),
      });
      expect(mockResolveOnBehalf).toHaveBeenCalledWith(
        expect.objectContaining({ onBehalfOfUserId: 'earliest-member' })
      );
    });

    it('with ONLY guests present the booker is used (no `onBehalfOfUserId` key at all)', async () => {
      await startBillingIfDue({
        meeting: MEETING,
        openRows: [row('expert', -10, 'e'), row('client', -10, null)],
        now: at(1),
      });
      const [call] = mockResolveOnBehalf.mock.calls[0] as [Record<string, unknown>];
      expect('onBehalfOfUserId' in call).toBe(false);
    });

    it('a racing path that opened it first (`meeting_session_exists`) — its id is USED, never a re-read', async () => {
      mockOpen.mockResolvedValue({
        ok: false,
        code: 'meeting_session_exists',
        existingSessionId: 'winner-1',
      });
      mockFindById.mockResolvedValue({ id: 'winner-1', status: 'pending' });

      await startBillingIfDue({ meeting: MEETING, openRows: CO_PRESENT, now: at(1) });

      expect(mockFindIdByMeetingId).toHaveBeenCalledTimes(1);
      expect(mockConnect).toHaveBeenCalledWith('winner-1', { now: START });
    });

    // R6F-9 — these four are PERMANENT, and the finder re-selects the meeting every minute while it stays
    // co-present, so each repeat is `debug`. The terminal path's alarm is the signal; nothing here warns.
    it.each([
      ['expert_invited_guest', 'expert_invited_guest'],
      ['meeting_not_bookable', 'meeting_not_bookable'],
      ['booker_unattributable', 'booker_unattributable'],
    ])(
      'the resolver refusing %s ⇒ deferred, logged at DEBUG only, no open, no connect, no throw',
      async (code, reason) => {
        mockResolveOnBehalf.mockResolvedValue({ ok: false, code, companyId: 'company-1' });

        await expect(
          startBillingIfDue({ meeting: MEETING, openRows: CO_PRESENT, now: at(1) })
        ).resolves.toEqual({ kind: 'deferred', reason });

        expect(mockLogDebug).toHaveBeenCalled();
        expect(mockLogInfo).not.toHaveBeenCalledWith(
          expect.anything(),
          expect.stringContaining('Billing not started')
        );
        expect(mockLogWarn).not.toHaveBeenCalled();
        expect(mockOpen).not.toHaveBeenCalled();
        expect(mockConnect).not.toHaveBeenCalled();
      }
    );

    it('session_in_progress is TRANSIENT (another live session holds the wallet) — info, the next pass retries', async () => {
      mockOpen.mockResolvedValue({ ok: false, code: 'session_in_progress' });

      await expect(
        startBillingIfDue({ meeting: MEETING, openRows: CO_PRESENT, now: at(1) })
      ).resolves.toEqual({ kind: 'deferred', reason: 'session_in_progress' });

      expect(mockLogInfo).toHaveBeenCalled();
      expect(mockConnect).not.toHaveBeenCalled();
    });

    it('expert_rate_missing is PERMANENT — debug, never a warn (the terminal path refuses and alarms it once)', async () => {
      mockOpen.mockResolvedValue({ ok: false, code: 'expert_rate_missing' });

      await expect(
        startBillingIfDue({ meeting: MEETING, openRows: CO_PRESENT, now: at(1) })
      ).resolves.toEqual({ kind: 'deferred', reason: 'expert_rate_missing' });

      expect(mockLogDebug).toHaveBeenCalled();
      expect(mockLogWarn).not.toHaveBeenCalled();
      expect(mockConnect).not.toHaveBeenCalled();
    });

    it.each(['account_hold', 'settlement_pending', 'insufficient_no_mandate'])(
      'a GATED refusal (%s) is unreachable under the tolerant policy — it fails LOUD (error + Sentry) and never throws out',
      async (code) => {
        mockOpen.mockResolvedValue({ ok: false, code });

        await expect(
          startBillingIfDue({ meeting: MEETING, openRows: CO_PRESENT, now: at(1) })
        ).resolves.toEqual({ kind: 'failed' });

        expect(mockCaptureException).toHaveBeenCalledTimes(1);
        expect(mockLogError).toHaveBeenCalled();
      }
    );
  });

  describe('it NEVER throws', () => {
    it('a thrown read is logged at error with its stack, captured in Sentry, and answers `failed` — settlement bills from presence regardless', async () => {
      const failure = new Error('db down');
      mockFindIdByMeetingId.mockRejectedValue(failure);

      await expect(
        startBillingIfDue({ meeting: MEETING, openRows: CO_PRESENT, now: at(1) })
      ).resolves.toEqual({ kind: 'failed' });

      expect(mockLogError).toHaveBeenCalledWith(
        expect.objectContaining({ meetingId: MEETING_ID, error: 'db down' }),
        expect.stringContaining('not metering yet')
      );
      expect(mockCaptureException).toHaveBeenCalledWith(failure, expect.anything());
    });

    it('a failing connect (any error other than the transition race) is contained the same way, and fires no event', async () => {
      mockConnect.mockRejectedValue(new Error('db down mid-connect'));

      await expect(
        startBillingIfDue({ meeting: MEETING, openRows: CO_PRESENT, now: at(1) })
      ).resolves.toEqual({ kind: 'failed' });

      expect(mockTrackServer).not.toHaveBeenCalled();
      expect(mockCaptureException).toHaveBeenCalledTimes(1);
    });
  });

  describe('R6F-7 — an End or cancel landing between the status read and the connect is an expected race', () => {
    it('⚠ InvalidSessionTransitionError from the connect ⇒ deferred session_not_pending at INFO, no Sentry, no event, no error log', async () => {
      mockConnect.mockRejectedValue(new InvalidSessionTransitionErrorStub('ended → active'));

      await expect(
        startBillingIfDue({ meeting: MEETING, openRows: CO_PRESENT, now: at(1) })
      ).resolves.toEqual({ kind: 'deferred', reason: 'session_not_pending' });

      expect(mockLogInfo).toHaveBeenCalledWith(
        expect.objectContaining({ meetingId: MEETING_ID, sessionId: 'session-1' }),
        expect.stringContaining('left `pending`')
      );
      expect(mockCaptureException).not.toHaveBeenCalled();
      expect(mockLogError).not.toHaveBeenCalled();
      expect(mockTrackServer).not.toHaveBeenCalled();
    });
  });

  describe('R6F-6 — `session_started` is emitted exactly once, by the caller that performed the transition', () => {
    it('⚠ a caller that finds the session ALREADY active (transitioned: false) emits nothing, logs no "Billing started", and answers already_metering', async () => {
      mockConnect.mockResolvedValue({ session: CONNECTED, transitioned: false });

      await expect(
        startBillingIfDue({ meeting: MEETING, openRows: CO_PRESENT, now: at(1) })
      ).resolves.toEqual({ kind: 'already_metering', sessionId: 'session-1' });

      expect(mockTrackServer).not.toHaveBeenCalled();
      expect(mockLogInfo).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining('Billing started')
      );
    });

    it('⚠⚠ THE DOUBLE-CALLER RACE: the writer and the pass both read `pending` and both connect — ONE event, ONE "Billing started", ONE start', async () => {
      // Both callers read `pending`; the repository's row lock lets exactly one of them perform the
      // transition. The loser gets the already-active row back.
      mockConnect
        .mockResolvedValueOnce({ session: CONNECTED, transitioned: true })
        .mockResolvedValueOnce({ session: CONNECTED, transitioned: false });

      const [first, second] = await Promise.all([
        startBillingIfDue({ meeting: MEETING, openRows: CO_PRESENT, now: at(1) }),
        startBillingIfDue({ meeting: MEETING, openRows: CO_PRESENT, now: at(1) }),
      ]);

      expect([first.kind, second.kind].sort((a, b) => a.localeCompare(b))).toEqual([
        'already_metering',
        'started',
      ]);
      expect(mockTrackServer).toHaveBeenCalledTimes(1);
      expect(
        mockLogInfo.mock.calls.filter(([, message]) => String(message).includes('Billing started'))
      ).toHaveLength(1);
    });
  });
});

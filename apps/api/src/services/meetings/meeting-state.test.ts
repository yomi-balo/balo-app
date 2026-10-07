import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockAuthorizeParticipation,
  mockFindById,
  mockListByMeeting,
  mockResolveSubject,
  mockDeliveringUserId,
  mockFindNamesByIds,
  mockFindCompanyName,
  mockWarn,
  mockOmitGuestRows,
  mockHasOpenAdmittedLinkGuest,
} = vi.hoisted(() => ({
  mockAuthorizeParticipation: vi.fn(),
  mockFindById: vi.fn(),
  mockListByMeeting: vi.fn(),
  mockResolveSubject: vi.fn(),
  mockDeliveringUserId: vi.fn(),
  mockFindNamesByIds: vi.fn(),
  mockFindCompanyName: vi.fn(),
  mockWarn: vi.fn(),
  mockOmitGuestRows: vi.fn(),
  mockHasOpenAdmittedLinkGuest: vi.fn(),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: mockWarn, error: vi.fn() }),
}));
vi.mock('@balo/db', () => ({
  meetingsRepository: { findById: mockFindById },
  meetingPresenceRepository: {
    listByMeeting: mockListByMeeting,
    omitExpertInvitedGuestRows: mockOmitGuestRows,
    hasOpenAdmittedLinkGuest: mockHasOpenAdmittedLinkGuest,
  },
  usersRepository: { findNamesByIds: mockFindNamesByIds },
  companiesRepository: { findNameById: mockFindCompanyName },
}));
vi.mock('../credit-session/case-billing-subject.js', () => ({
  resolveCaseBillingSubject: mockResolveSubject,
}));
vi.mock('./delivering-party.js', () => ({ deliveringExpertUserId: mockDeliveringUserId }));
vi.mock('./authorize-meeting-participation.js', () => ({
  authorizeMeetingParticipation: mockAuthorizeParticipation,
}));
// ⚠ `@balo/shared/meetings` is NOT mocked — `resolveWaitingPhase` and `computeMeetingClocks` are
// exactly what this read is a thin wrapper over, and mocking them would assert nothing.

import {
  DEFAULT_MEETING_TIMERS,
  dailyRoomNameForMeeting,
  isMeetingVenueReady,
  type MeetingTimers,
} from '@balo/shared/meetings';
import { getMeetingState } from './meeting-state.js';

const MEETING_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const START = new Date('2026-08-14T10:00:00.000Z');
const MINUTE = 60_000;

function at(minutes: number): Date {
  return new Date(START.getTime() + minutes * MINUTE);
}

const ROOM = dailyRoomNameForMeeting(MEETING_ID);

/**
 * ⚠⚠ BAL-581 — VENUE-COMPLETE BY DEFAULT, AND THAT IS THE CANARY. `meetingVenueReadyAt` needs
 * `dailyRoomName`/`joinUrl` (matching `dailyRoomNameForMeeting(id)`) AND `venueProvisionedAt`.
 * Without them this fixture reads as NOT READY and `resolveWaitingPhase`'s expert-missing arm
 * would fall to its defensive `?? scheduledStart` fallback instead of exercising the real anchor.
 */
function meeting(overrides: Record<string, unknown> = {}) {
  return {
    id: MEETING_ID,
    status: 'waiting_for_participants',
    scheduledStart: START,
    scheduledEnd: at(60),
    dailyRoomName: ROOM,
    joinUrl: `https://balo.daily.co/${ROOM}`,
    createdAt: at(-1440),
    venueProvisionedAt: at(-1440),
    endedAt: null,
    endedBy: null,
    outcome: null,
    ...overrides,
  };
}

function stateAt(minutes: number, timers: MeetingTimers = DEFAULT_MEETING_TIMERS) {
  return getMeetingState({
    meetingId: MEETING_ID,
    userId: USER_ID,
    timers,
    now: at(minutes),
  });
}

describe('getMeetingState (BAL-134 §7.1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthorizeParticipation.mockResolvedValue({ ok: true, side: 'expert', meeting: meeting() });
    mockFindById.mockResolvedValue(meeting());
    mockListByMeeting.mockResolvedValue([]);
    mockHasOpenAdmittedLinkGuest.mockResolvedValue(false);
    // BAL-474 (R6-C3) — an ACTIVE case by default: nothing was closed.
    mockResolveSubject.mockResolvedValue({
      engagementId: 'engagement-1',
      companyId: 'company-1',
      expertProfileId: 'expert-1',
      isActive: true,
      closedAt: null,
      closedByUserId: null,
    });
    mockDeliveringUserId.mockResolvedValue(USER_ID);
    // R6F-4a — by default nothing is dropped from the together term.
    mockOmitGuestRows.mockImplementation(async (rows: readonly unknown[]) => [...rows]);
    mockFindNamesByIds.mockResolvedValue([{ id: 'closer-1', firstName: 'Dana', lastName: 'Lee' }]);
    mockFindCompanyName.mockResolvedValue({ id: 'company-1', name: 'Northwind Industrial' });
  });

  it('collapses every denial to `meeting_not_found` — no 403 on this family', async () => {
    mockAuthorizeParticipation.mockResolvedValue({ ok: false, code: 'meeting_not_found' });

    await expect(stateAt(5)).resolves.toEqual({ ok: false, code: 'meeting_not_found' });
    expect(mockListByMeeting).not.toHaveBeenCalled();
  });

  it('reports the GATE`s own viewerRole, never a lens and never request input', async () => {
    const result = await stateAt(5);

    expect(result.ok && result.state.viewerRole).toBe('expert');
  });

  /**
   * ⚠⚠ THE PHASE IS COMPUTED HERE, SERVER-SIDE, AND SENT AS A LABEL. That is the AC verbatim
   * ("all timing is server-authoritative; the client renders a mirror") and it structurally
   * prevents a browser bundle carrying default thresholds from disagreeing with an overridden
   * server.
   */
  it('⚠⚠ computes the waiting phase SERVER-SIDE from the injected timers', async () => {
    mockListByMeeting.mockResolvedValue([{ party: 'expert', joinedAt: START, leftAt: null }]);

    // 4 minutes into the expert-present clock — before the nudge threshold.
    await expect(stateAt(4)).resolves.toMatchObject({ state: { phase: 'running' } });
    // 5 minutes in — at it.
    await expect(stateAt(5)).resolves.toMatchObject({ state: { phase: 'near' } });
  });

  /** ⚠⚠ THE CANARY — if this ever goes red every "phase" assertion below it is silently
   * exercising `resolveWaitingPhase`'s defensive `?? scheduledStart` fallback. */
  it('⚠⚠ the default fixture is venue-READY — the canary for every other row in this file', () => {
    expect(isMeetingVenueReady(meeting())).toBe(true);
  });

  /**
   * BAL-581 — the expert-missing arm is anchored on `venueAbsenceAnchor`, the SAME instant the
   * ops alert fires from, so `near`'s "we've flagged this to the Balo team" renders exactly when
   * that alert fires — even for a room repaired AFTER the scheduled start.
   */
  it('⚠ BAL-581 — a LATE-ready venue anchors the expert-missing phase on ITS OWN readiness, not the start', async () => {
    mockFindById.mockResolvedValue(meeting({ venueProvisionedAt: at(3) }));

    // Before the room existed: still running — nobody could have joined yet.
    await expect(stateAt(2)).resolves.toMatchObject({ state: { phase: 'running' } });
    // 5 minutes AFTER the room became ready is inside the alert window still.
    await expect(stateAt(5)).resolves.toMatchObject({ state: { phase: 'running' } });
    // anchor (start+3) + the 5-minute alert window = start+8.
    await expect(stateAt(8)).resolves.toMatchObject({ state: { phase: 'near' } });
  });

  it('a terminal meeting is `settled`', async () => {
    mockFindById.mockResolvedValue(
      meeting({ status: 'ended', endedAt: at(20), endedBy: 'client_principal' })
    );

    const result = await stateAt(30);

    expect(result.ok && result.state).toMatchObject({
      status: 'ended',
      phase: 'settled',
      endedBy: 'client_principal',
    });
  });

  /**
   * ⚠ FOR A TERMINAL MEETING THE CEILING IS `ended_at`, NOT THE WALL CLOCK. Measuring a closed
   * meeting against `now` is the 16-hour over-bill `resolveClockCeiling` exists to prevent — and
   * this read is polled, so it would drift further every tick.
   */
  it('⚠ measures a TERMINAL meeting to `ended_at`, never to the wall clock', async () => {
    mockFindById.mockResolvedValue(meeting({ status: 'ended', endedAt: at(30) }));
    mockListByMeeting.mockResolvedValue([
      { party: 'expert', joinedAt: START, leftAt: null },
      { party: 'client', joinedAt: at(5), leftAt: null },
    ]);

    // Read hours later — the clocks must not have grown.
    const result = await stateAt(600);

    expect(result.ok && result.state.clocks.expertPresentMs).toBe(30 * MINUTE);
    expect(result.ok && result.state.clocks.billableMs).toBe(25 * MINUTE);
  });

  /**
   * ⚠ `asOf` AND THE CLOCKS MUST AGREE BY CONSTRUCTION — the browser's ticker interpolates from
   * `asOf`, so a clock read at a different instant would let the mirror start ahead of the value
   * it was given.
   */
  it('⚠ `asOf` is the SAME instant the clocks were measured at', async () => {
    mockListByMeeting.mockResolvedValue([{ party: 'expert', joinedAt: START, leftAt: null }]);

    const result = await stateAt(10);

    expect(result.ok && result.state.asOf).toBe(at(10).toISOString());
    expect(result.ok && result.state.clocks.expertPresentMs).toBe(10 * MINUTE);
  });

  it('carries no token, no roomUrl and no participantId', async () => {
    const result = await stateAt(5);

    expect(result.ok && Object.keys(result.state).sort((a, b) => a.localeCompare(b))).toEqual([
      'asOf',
      // BAL-474 (Rule A) — the billing chip's figure: no money, no token.
      'billingClock',
      // BAL-474 (R6-C3) — the closed-case read: two first names, no id.
      'caseClosure',
      'clocks',
      'endedBy',
      'noShowFloorMinutes',
      'noShowHeld',
      'outcome',
      'phase',
      'presence',
      'status',
      'viewerRole',
    ]);
  });

  /**
   * BAL-474 (Rule A, D13) — `clocks` stays over presence CLAMPED to the start (an older web build shows
   * exactly today's values), while `billingClock.soFarMs` is the figure the bill will use, pre-floor:
   * the time TOGETHER before the start plus the from-start figure. `running` freezes the chip when the
   * room is not producing time.
   */
  describe('billingClock (Rule A)', () => {
    const together = (from: number, to: number | null) => [
      { party: 'expert', joinedAt: at(from), leftAt: to === null ? null : at(to) },
      { party: 'client', joinedAt: at(from), leftAt: to === null ? null : at(to) },
    ];

    it('example 1 — together from 09:50, at 10:20 the chip reads 30 (10 before the start + 20 from it), running', async () => {
      mockFindById.mockResolvedValue(meeting({ status: 'in_progress' }));
      mockListByMeeting.mockResolvedValue(together(-10, null));

      const result = await stateAt(20);

      expect(result.ok && result.state.billingClock).toEqual({
        soFarMs: 30 * MINUTE,
        running: true,
      });
      // The clocks are the CLAMPED, unchanged figures: 20 minutes from the start.
      expect(result.ok && result.state.clocks.billableMs).toBe(20 * MINUTE);
      expect(result.ok && result.state.clocks.expertPresentMs).toBe(20 * MINUTE);
    });

    it('before the start, together for 6 minutes: soFarMs is the 6 (pre-start time only), running while both are here', async () => {
      mockFindById.mockResolvedValue(meeting({ status: 'in_progress' }));
      mockListByMeeting.mockResolvedValue(together(-10, null));

      const result = await stateAt(-4);

      expect(result.ok && result.state.billingClock).toEqual({
        soFarMs: 6 * MINUTE,
        running: true,
      });
    });

    it('example 2 — together 09:00–09:01, the expert waits alone, the client is back at 10:00: at 10:30, 1 + 30 = 31', async () => {
      mockFindById.mockResolvedValue(meeting({ status: 'in_progress' }));
      mockListByMeeting.mockResolvedValue([
        { party: 'expert', joinedAt: at(-60), leftAt: null },
        { party: 'client', joinedAt: at(-60), leftAt: at(-59) },
        { party: 'client', joinedAt: at(0), leftAt: null },
      ]);

      const result = await stateAt(30);

      expect(result.ok && result.state.billingClock).toEqual({
        soFarMs: 31 * MINUTE,
        running: true,
      });
    });

    it('example 2, while the expert waits ALONE before the client returns (09:30): 1 minute, and NOT running (no client here, before the start)', async () => {
      mockFindById.mockResolvedValue(meeting({ status: 'waiting_for_participants' }));
      mockListByMeeting.mockResolvedValue([
        { party: 'expert', joinedAt: at(-60), leftAt: null },
        { party: 'client', joinedAt: at(-60), leftAt: at(-59) },
      ]);

      const result = await stateAt(-30);

      expect(result.ok && result.state.billingClock).toEqual({
        soFarMs: 1 * MINUTE,
        running: false,
      });
    });

    it('example 5 — together 09:30–09:31, the client never returns, the expert waits until 10:10: 1 + 10 = 11, running (the expert is open past the start)', async () => {
      mockFindById.mockResolvedValue(meeting({ status: 'waiting_for_participants' }));
      mockListByMeeting.mockResolvedValue([
        { party: 'expert', joinedAt: at(-30), leftAt: at(-29) },
        { party: 'client', joinedAt: at(-30), leftAt: at(-29) },
        { party: 'expert', joinedAt: at(0), leftAt: null },
      ]);

      const result = await stateAt(10);

      expect(result.ok && result.state.billingClock).toEqual({
        soFarMs: 11 * MINUTE,
        running: true,
      });
    });

    it('a lone expert who has NEVER had a client: the chip is the expert’s own wait FROM the start (the amber counted figure), with nothing together before it', async () => {
      mockListByMeeting.mockResolvedValue([{ party: 'expert', joinedAt: at(-5), leftAt: null }]);

      const result = await stateAt(8);

      expect(result.ok && result.state.billingClock).toEqual({
        soFarMs: 8 * MINUTE,
        running: true,
      });
    });

    it('a solo early client is not together: soFarMs is 0 and the chip is not running before the start', async () => {
      mockListByMeeting.mockResolvedValue([{ party: 'client', joinedAt: at(-30), leftAt: null }]);

      const result = await stateAt(-10);

      expect(result.ok && result.state.billingClock).toEqual({ soFarMs: 0, running: false });
    });

    it('⚠⚠ D15.3 — together 09:00–09:30, both back 10:10: at 11:00 the chip reads 30 + 50 = 80, while `clocks` keep the clamped figure (60)', async () => {
      mockFindById.mockResolvedValue(meeting({ status: 'in_progress' }));
      mockListByMeeting.mockResolvedValue([
        { party: 'expert', joinedAt: at(-60), leftAt: at(-30) },
        { party: 'client', joinedAt: at(-60), leftAt: at(-30) },
        { party: 'expert', joinedAt: at(10), leftAt: null },
        { party: 'client', joinedAt: at(10), leftAt: null },
      ]);

      const result = await stateAt(60);

      expect(result.ok && result.state.billingClock).toEqual({
        soFarMs: 80 * MINUTE,
        running: true,
      });
      expect(result.ok && result.state.clocks.expertPresentMs).toBe(60 * MINUTE);
    });

    it('⚠ R6F-4a — the together term is read AFTER dropping the delivering expert’s own invited guests (the chip agrees with the bill)', async () => {
      mockFindById.mockResolvedValue(meeting({ status: 'in_progress' }));
      const member = { party: 'client', joinedAt: at(0), leftAt: null, meetingGuestId: null };
      const ownGuest = { party: 'client', joinedAt: at(-10), leftAt: null, meetingGuestId: 'g-1' };
      const expertRow = { party: 'expert', joinedAt: at(-10), leftAt: null, meetingGuestId: null };
      mockListByMeeting.mockResolvedValue([expertRow, ownGuest, member]);
      mockOmitGuestRows.mockResolvedValue([expertRow, member]);

      const result = await stateAt(20);

      // Without the exclusion the guest would add 10 minutes before the start: 10 + 20 = 30.
      expect(result.ok && result.state.billingClock).toEqual({
        soFarMs: 20 * MINUTE,
        running: true,
      });
      const [rowsArg, resolver] = mockOmitGuestRows.mock.calls[0] as [
        unknown[],
        () => Promise<string | null>,
      ];
      expect(rowsArg).toHaveLength(3);
      // The resolver is lazy and answers with the case's expert.
      await expect(resolver()).resolves.toBe('expert-1');
    });

    it('a TERMINAL meeting is measured to `ended_at` and is not running', async () => {
      mockFindById.mockResolvedValue(meeting({ status: 'ended', endedAt: at(40) }));
      mockListByMeeting.mockResolvedValue(together(-10, 40));

      const result = await stateAt(600);

      expect(result.ok && result.state.billingClock).toEqual({
        soFarMs: 50 * MINUTE,
        running: false,
      });
    });
  });

  /**
   * BAL-474 (R6-C3, owner-approved) — the expert's "this case was closed" read. It is sent ONLY when the case was
   * closed BEFORE the start AND nobody from the client side was ever present, to the DELIVERING expert, in a
   * pre-in_progress state or after the voided no-show — and it is never read on a live `in_progress` poll.
   */
  describe('caseClosure (R6-C3)', () => {
    const CLOSED_BEFORE = {
      engagementId: 'engagement-1',
      companyId: 'company-1',
      expertProfileId: 'expert-1',
      isActive: false,
      closedAt: at(-30),
      closedByUserId: 'closer-1',
    };
    const closure = async (minutes = 5) => {
      const result = await stateAt(minutes);
      return result.ok ? result.state.caseClosure : 'denied';
    };

    beforeEach(() => {
      mockResolveSubject.mockResolvedValue(CLOSED_BEFORE);
    });

    it('⚠ BOTH conditions hold (closed before the start, no client side ever present): the closer’s FIRST name and the company', async () => {
      await expect(closure()).resolves.toEqual({
        closedByFirstName: 'Dana',
        companyName: 'Northwind Industrial',
      });
      expect(mockFindNamesByIds).toHaveBeenCalledWith(['closer-1']);
      expect(mockFindCompanyName).toHaveBeenCalledWith('company-1');
    });

    it('a case closed AFTER the start is not shown (the no-show is still owed)', async () => {
      mockResolveSubject.mockResolvedValue({ ...CLOSED_BEFORE, closedAt: at(3) });
      await expect(closure()).resolves.toBeNull();
      expect(mockFindNamesByIds).not.toHaveBeenCalled();
    });

    it('a case closed EXACTLY at the start is not shown either (the boundary is not "before")', async () => {
      mockResolveSubject.mockResolvedValue({ ...CLOSED_BEFORE, closedAt: at(0) });
      await expect(closure()).resolves.toBeNull();
    });

    it.each([
      [
        'a client MEMBER who joined and left',
        { party: 'client', joinedAt: at(-20), leftAt: at(-19) },
      ],
      ['a client who is still in the room', { party: 'client', joinedAt: at(-2), leftAt: null }],
    ])(
      '⚠ after ANY client-side presence (%s) it is not shown — that call is billed',
      async (_label, row) => {
        mockListByMeeting.mockResolvedValue([
          { party: 'expert', joinedAt: at(-5), leftAt: null },
          row,
        ]);
        await expect(closure()).resolves.toBeNull();
        expect(mockResolveSubject).not.toHaveBeenCalled();
      }
    );

    it('an OBSERVER is not client-side presence: it is still shown', async () => {
      mockListByMeeting.mockResolvedValue([{ party: 'observer', joinedAt: at(-5), leftAt: null }]);
      await expect(closure()).resolves.toMatchObject({ closedByFirstName: 'Dana' });
    });

    it('⚠ NEVER read on an in_progress poll — zero reads', async () => {
      mockFindById.mockResolvedValue(meeting({ status: 'in_progress' }));
      await expect(closure()).resolves.toBeNull();
      expect(mockResolveSubject).not.toHaveBeenCalled();
    });

    it('a `scheduled` meeting (nobody in yet) is shown; the server gate does not require the expert to be in the room', async () => {
      mockFindById.mockResolvedValue(meeting({ status: 'scheduled' }));
      await expect(closure(-10)).resolves.toMatchObject({ closedByFirstName: 'Dana' });
    });

    it.each([
      ['no_show_client', true],
      ['completed', false],
      ['missed_call', false],
      [null, false],
    ])('an ENDED meeting with outcome %s ⇒ shown: %s', async (outcome, shown) => {
      mockFindById.mockResolvedValue(meeting({ status: 'ended', endedAt: at(15), outcome }));
      const result = await closure(30);
      expect(result !== null).toBe(shown);
    });

    it('⚠ the CLIENT lens never gets it, and nothing is read for them', async () => {
      mockAuthorizeParticipation.mockResolvedValue({
        ok: true,
        side: 'client',
        meeting: meeting(),
      });
      await expect(closure()).resolves.toBeNull();
      expect(mockResolveSubject).not.toHaveBeenCalled();
    });

    it('an expert-side viewer who is NOT the delivering expert (an agency admin) does not get it', async () => {
      mockDeliveringUserId.mockResolvedValue('someone-else');
      await expect(closure()).resolves.toBeNull();
    });

    it('an ACTIVE case is not shown', async () => {
      mockResolveSubject.mockResolvedValue({ ...CLOSED_BEFORE, isActive: true, closedAt: null });
      await expect(closure()).resolves.toBeNull();
    });

    it('no human closer (the inactivity sweep) ⇒ `closedByFirstName: null`, no user read', async () => {
      mockResolveSubject.mockResolvedValue({ ...CLOSED_BEFORE, closedByUserId: null });
      await expect(closure()).resolves.toEqual({
        closedByFirstName: null,
        companyName: 'Northwind Industrial',
      });
      expect(mockFindNamesByIds).not.toHaveBeenCalled();
    });

    it('a blank first name, or a company that cannot be read, degrade each to null on its own', async () => {
      mockFindNamesByIds.mockResolvedValue([{ id: 'closer-1', firstName: '  ', lastName: 'Lee' }]);
      mockFindCompanyName.mockResolvedValue(undefined);
      await expect(closure()).resolves.toEqual({ closedByFirstName: null, companyName: null });
    });

    it('a failing read degrades to null — it never fails the poll — and is LOGGED (R6F-3)', async () => {
      mockResolveSubject.mockRejectedValue(new Error('db down'));
      await expect(closure()).resolves.toBeNull();
      expect(mockWarn).toHaveBeenCalledTimes(1);
      expect(mockWarn).toHaveBeenCalledWith(
        expect.objectContaining({
          meetingId: MEETING_ID,
          userId: expect.any(String),
          error: 'db down',
          stack: expect.any(String),
        }),
        'Case-closure read failed — rendering the ordinary waiting copy'
      );
    });

    it('a successful read logs nothing', async () => {
      await closure();
      expect(mockWarn).not.toHaveBeenCalled();
    });

    it('never carries an id, a last name or an email', async () => {
      const value = await closure();
      expect(JSON.stringify(value)).not.toMatch(/closer-1|Lee|company-1|@/);
    });
  });

  /**
   * ⚠⚠ THE FLOOR COMES FROM THE **INJECTED (ENV-RESOLVED)** TIMERS, NOT THE SHIPPED DEFAULT.
   *
   * This field exists solely so the browser stops hard-coding "15" in its no-show sentence. If it
   * were derived from `DEFAULT_MEETING_TIMERS` it would re-introduce the exact drift D8 exists to
   * prevent — one layer further in, and invisible everywhere except the environment that actually
   * set `MEETING_NO_SHOW_FLOOR_MINUTES`. **A test that only asserted `15` would pass against that
   * bug**, which is why the override case is the one that carries the weight.
   */
  describe('noShowHeld', () => {
    const expertAlone = [{ party: 'expert', joinedAt: START, leftAt: null }];
    const withLinkGuest = [
      ...expertAlone,
      { party: 'observer', joinedAt: at(1), leftAt: null, meetingGuestId: 'guest-1' },
    ];

    it('is true BEFORE the floor when the expert waits with an admitted link guest and no client was ever present', async () => {
      mockListByMeeting.mockResolvedValue(withLinkGuest);
      mockHasOpenAdmittedLinkGuest.mockResolvedValue(true);

      const result = await stateAt(12);

      expect(result.ok && result.state.noShowHeld).toBe(true);
      expect(mockHasOpenAdmittedLinkGuest).toHaveBeenCalledWith(MEETING_ID);
    });

    it('is false when the open guest observer is not an admitted link guest', async () => {
      mockListByMeeting.mockResolvedValue(withLinkGuest);

      const result = await stateAt(12);

      expect(result.ok && result.state.noShowHeld).toBe(false);
      expect(mockHasOpenAdmittedLinkGuest).toHaveBeenCalledTimes(1);
    });

    it('runs no query when the expert waits alone', async () => {
      mockListByMeeting.mockResolvedValue(expertAlone);

      const result = await stateAt(12);

      expect(result.ok && result.state.noShowHeld).toBe(false);
      expect(mockHasOpenAdmittedLinkGuest).not.toHaveBeenCalled();
    });

    it('is false past the overrun ceiling, where the hold lapses', async () => {
      mockListByMeeting.mockResolvedValue(withLinkGuest);
      mockHasOpenAdmittedLinkGuest.mockResolvedValue(true);

      const result = await stateAt(60 * 24);

      expect(result.ok && result.state.noShowHeld).toBe(false);
    });

    it.each([
      {
        label: 'the expert is not in the room',
        rows: [{ party: 'observer', joinedAt: at(1), leftAt: null }],
        status: 'waiting_for_participants',
      },
      {
        label: 'a client-side participant has been present',
        rows: [...expertAlone, { party: 'client', joinedAt: at(1), leftAt: at(2) }],
        status: 'waiting_for_participants',
      },
      { label: 'the meeting is in progress', rows: expertAlone, status: 'in_progress' },
      { label: 'the meeting has ended', rows: expertAlone, status: 'ended' },
    ])('is false with NO extra query when $label', async ({ rows, status }) => {
      mockListByMeeting.mockResolvedValue(rows);
      mockFindById.mockResolvedValue(meeting({ status }));

      const result = await stateAt(12);

      expect(result.ok && result.state.noShowHeld).toBe(false);
      expect(mockHasOpenAdmittedLinkGuest).not.toHaveBeenCalled();
    });

    it('degrades to false and warns when the read fails', async () => {
      mockListByMeeting.mockResolvedValue(withLinkGuest);
      mockHasOpenAdmittedLinkGuest.mockRejectedValue(new Error('db down'));

      const result = await stateAt(12);

      expect(result.ok && result.state.noShowHeld).toBe(false);
      expect(mockWarn).toHaveBeenCalled();
    });
  });

  describe('noShowFloorMinutes', () => {
    it('⚠⚠ reflects an ENV OVERRIDE, not the 15-minute default', async () => {
      const overridden: MeetingTimers = { ...DEFAULT_MEETING_TIMERS, noShowFloorMs: 25 * MINUTE };

      const result = await stateAt(5, overridden);

      expect(result.ok && result.state.noShowFloorMinutes).toBe(25);
    });

    it('is the default when nothing is overridden', async () => {
      const result = await stateAt(5);

      expect(result.ok && result.state.noShowFloorMinutes).toBe(
        DEFAULT_MEETING_TIMERS.noShowFloorMs / MINUTE
      );
    });

    /**
     * ⚠ A SUB-MINUTE FLOOR MUST NOT ROUND TO `0`. The web parser validates this as
     * `int().positive()` and a failed field fails the WHOLE parse — blanking the mirror for every
     * participant in the call rather than just this one sentence.
     */
    it('⚠ never emits a non-positive minute count', async () => {
      const tiny: MeetingTimers = { ...DEFAULT_MEETING_TIMERS, noShowFloorMs: 20_000 };

      const result = await stateAt(5, tiny);

      expect(result.ok && result.state.noShowFloorMinutes).toBe(1);
    });
  });

  /**
   * ⚠⚠ `expertOpen` IS "OPEN **RIGHT NOW**", NOT "EVER JOINED" — AND THE `false`-AFTER-JOINING
   * CASE IS THE WHOLE REASON THIS FIELD SHIPS.
   *
   * The browser's fallback is `expertFirstJoinedAt !== null`, a fact about the past that never
   * becomes false again. An expert who joined and then DROPPED has a FROZEN `expertPresentMs`
   * server-side while the chip keeps ticking an interpolated duration — over-stating credited
   * time. A test that only covered "never joined" would agree with the buggy fallback and catch
   * nothing.
   */
  describe('presence.expertOpen', () => {
    it('is TRUE while an expert interval is open', async () => {
      mockListByMeeting.mockResolvedValue([{ party: 'expert', joinedAt: START, leftAt: null }]);

      const result = await stateAt(10);

      expect(result.ok && result.state.presence.expertOpen).toBe(true);
    });

    it('⚠⚠ is FALSE for an expert who JOINED and then dropped — the case the fallback gets wrong', async () => {
      mockListByMeeting.mockResolvedValue([
        { party: 'expert', joinedAt: START, leftAt: at(6) },
        { party: 'client', joinedAt: at(2), leftAt: null },
      ]);

      const result = await stateAt(10);

      expect(result.ok && result.state.presence.expertOpen).toBe(false);
      // ⚠ THE EXPERT DEMONSTRABLY DID JOIN — so `expertFirstJoinedAt !== null` would say `true`
      // here. That divergence is the entire point of sending this field.
      expect(result.ok && result.state.clocks.expertFirstJoinedAt).not.toBeNull();
      // …and the server has FROZEN the duration at the drop, which is what the ticking chip
      // was contradicting.
      expect(result.ok && result.state.clocks.expertPresentMs).toBe(6 * MINUTE);
    });

    it('is FALSE when no expert has joined at all', async () => {
      mockListByMeeting.mockResolvedValue([{ party: 'client', joinedAt: START, leftAt: null }]);

      const result = await stateAt(10);

      expect(result.ok && result.state.presence.expertOpen).toBe(false);
    });

    /**
     * ⚠ PROJECTED, NOT SPREAD. `PresenceFacts` also carries `anyOpen`, `clientOpen` and
     * `expertFirstJoinedAt`; spreading it would silently widen a payload a browser polls every
     * ten seconds.
     */
    it('⚠ carries ONLY `expertOpen` — the internal PresenceFacts shape is not the wire shape', async () => {
      mockListByMeeting.mockResolvedValue([{ party: 'expert', joinedAt: START, leftAt: null }]);

      const result = await stateAt(10);

      expect(result.ok && Object.keys(result.state.presence)).toEqual(['expertOpen']);
    });
  });

  it('falls back to the gate`s meeting row if the re-read finds nothing', async () => {
    mockFindById.mockResolvedValue(undefined);

    const result = await stateAt(5);

    expect(result.ok && result.state.status).toBe('waiting_for_participants');
  });
});

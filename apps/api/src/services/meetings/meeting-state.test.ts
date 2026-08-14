import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockAuthorizeParticipation, mockFindById, mockListByMeeting } = vi.hoisted(() => ({
  mockAuthorizeParticipation: vi.fn(),
  mockFindById: vi.fn(),
  mockListByMeeting: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  meetingsRepository: { findById: mockFindById },
  meetingPresenceRepository: { listByMeeting: mockListByMeeting },
}));
vi.mock('./authorize-meeting-participation.js', () => ({
  authorizeMeetingParticipation: mockAuthorizeParticipation,
}));
// ⚠ `@balo/shared/meetings` is NOT mocked — `resolveWaitingPhase` and `computeMeetingClocks` are
// exactly what this read is a thin wrapper over, and mocking them would assert nothing.

import { DEFAULT_MEETING_TIMERS, type MeetingTimers } from '@balo/shared/meetings';
import { getMeetingState } from './meeting-state.js';

const MEETING_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const START = new Date('2026-08-14T10:00:00.000Z');
const MINUTE = 60_000;

function at(minutes: number): Date {
  return new Date(START.getTime() + minutes * MINUTE);
}

function meeting(overrides: Record<string, unknown> = {}) {
  return {
    id: MEETING_ID,
    status: 'waiting_for_participants',
    scheduledStart: START,
    scheduledEnd: at(60),
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
      'clocks',
      'endedBy',
      'noShowFloorMinutes',
      'outcome',
      'phase',
      'presence',
      'status',
      'viewerRole',
    ]);
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

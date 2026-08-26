import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockAuthorizeParticipation,
  mockResolveEndAuthority,
  mockLogDenied,
  mockEndMeeting,
  mockListByMeeting,
  mockTrackServer,
  mockError,
  mockSettleMeetingIfBillable,
  mockEnqueueRecordingStop,
} = vi.hoisted(() => ({
  mockAuthorizeParticipation: vi.fn(),
  mockResolveEndAuthority: vi.fn(),
  mockLogDenied: vi.fn(),
  mockEndMeeting: vi.fn(),
  mockListByMeeting: vi.fn(),
  mockTrackServer: vi.fn(),
  mockError: vi.fn(),
  mockSettleMeetingIfBillable: vi.fn(),
  mockEnqueueRecordingStop: vi.fn(),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: mockError }),
}));
vi.mock('@balo/db', () => ({
  meetingsRepository: { endMeeting: mockEndMeeting },
  meetingPresenceRepository: { listByMeeting: mockListByMeeting },
}));
vi.mock('@balo/analytics/server', () => ({
  trackServer: mockTrackServer,
  MEETING_SERVER_EVENTS: { MEETING_ENDED: 'meeting_ended' },
}));
vi.mock('./authorize-meeting-participation.js', () => ({
  authorizeMeetingParticipation: mockAuthorizeParticipation,
}));
vi.mock('./authorize-end-meeting.js', () => ({
  resolveEndAuthority: mockResolveEndAuthority,
  logEndAuthorityDenied: mockLogDenied,
}));
// BAL-412 — INERT on main (D10). Mocked so this suite stays focused on the human-end sequence;
// the settlement wrapper's own behaviour is covered in `settle-from-presence.test.ts`.
vi.mock('../credit-session/settle-from-presence.js', () => ({
  settleMeetingIfBillable: mockSettleMeetingIfBillable,
}));
// BAL-473 — the recording-stop enqueue at the RECORDING_FINALIZATION_SEAM. Mocked so this
// suite stays focused on the human-end sequence; the job's own behaviour is covered in
// `jobs/recording-capture.test.ts`.
vi.mock('../../jobs/recording-capture.js', () => ({
  enqueueRecordingStop: mockEnqueueRecordingStop,
}));
// ⚠ `@balo/shared/meetings` is NOT mocked — the real `computeMeetingClocks` is what the
// analytics numbers below assert, and it is the one definition of both spans.

import { endMeeting } from './end-meeting.js';
import type { RoomTeardown } from '../daily/rooms.js';

const MEETING_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const ROOM_NAME = 'balo-22222222222242228222222222222222';
const NOW = new Date('2026-08-14T11:00:00.000Z');
const START = new Date('2026-08-14T10:00:00.000Z');

function meetingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: MEETING_ID,
    status: 'in_progress',
    scheduledStart: START,
    scheduledEnd: new Date(START.getTime() + 3_600_000),
    startedAt: START,
    endedAt: null,
    endedBy: null,
    outcome: null,
    dailyRoomName: ROOM_NAME,
    joinUrl: `https://balo.daily.co/${ROOM_NAME}`,
    deletedAt: null,
    ...overrides,
  };
}

/** A teardown port that records its calls — no network, no Daily account. */
function fakeTeardown(behaviour: 'ok' | 'throws' = 'ok'): RoomTeardown & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    deleteRoom: async (name: string) => {
      calls.push(name);
      if (behaviour === 'throws') {
        throw new Error('daily is down');
      }
      return 'deleted';
    },
  };
}

describe('endMeeting (BAL-134 §5.4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthorizeParticipation.mockResolvedValue({
      ok: true,
      side: 'client',
      meeting: meetingRow(),
      subject: { contextType: 'case', contextId: 'ctx-1' },
      companyId: 'company-1',
      expertProfileId: null,
    });
    mockResolveEndAuthority.mockResolvedValue({
      canEndMeeting: true,
      endedBy: 'client_principal',
      isExpertHost: false,
      isClientPrincipal: true,
    });
    mockEndMeeting.mockResolvedValue({
      meeting: meetingRow({ status: 'ended', endedAt: NOW, endedBy: 'client_principal' }),
      closedIntervals: 2,
    });
    mockListByMeeting.mockResolvedValue([
      { party: 'expert', joinedAt: START, leftAt: NOW },
      { party: 'client', joinedAt: new Date(START.getTime() + 300_000), leftAt: NOW },
    ]);
    // BAL-412 — INERT on main (D10): every meeting today resolves `no_meeting`.
    mockSettleMeetingIfBillable.mockResolvedValue({ ok: false, code: 'no_meeting' });
  });

  // ── AUTHORIZATION ───────────────────────────────────────────────────────────────────────

  it('⚠ the TENANCY gate runs FIRST — a denial never reaches end authority', async () => {
    mockAuthorizeParticipation.mockResolvedValue({ ok: false, code: 'meeting_not_found' });

    await expect(endMeeting({ meetingId: MEETING_ID, userId: USER_ID })).resolves.toEqual({
      ok: false,
      code: 'meeting_not_found',
    });
    expect(mockResolveEndAuthority).not.toHaveBeenCalled();
    expect(mockEndMeeting).not.toHaveBeenCalled();
  });

  /**
   * ⚠ 404, NOT 403. There is no `403` anywhere on `/meetings/*` and this surface must not
   * become the exception; the denial SHAPE goes to `log.warn`, never to the wire.
   */
  it('⚠ NO END AUTHORITY collapses to `meeting_not_found` and logs the shape', async () => {
    mockResolveEndAuthority.mockResolvedValue({
      canEndMeeting: false,
      endedBy: null,
      isExpertHost: false,
      isClientPrincipal: false,
    });

    await expect(endMeeting({ meetingId: MEETING_ID, userId: USER_ID })).resolves.toEqual({
      ok: false,
      code: 'meeting_not_found',
    });
    expect(mockLogDenied).toHaveBeenCalledTimes(1);
    expect(mockEndMeeting).not.toHaveBeenCalled();
  });

  // ── ⚠⚠ S2 — LIVENESS. ENDING A MEETING THAT NEVER OPENED IS A CANCELLATION. ─────────────

  /**
   * ⚠⚠ THE REPOSITORY'S CAS CANNOT STOP THIS, AND THAT IS THE POINT. It is an EXCLUSION
   * (`status NOT IN ('ended','cancelled')`), so `scheduled` is endable — that is deliberate,
   * because the missed-call path ends a `scheduled` meeting nobody joined. But it means an end-
   * authority holder could POST against a consultation DAYS IN THE FUTURE and destroy it in one
   * request, and `CONSUME_CREDITS` sits in `MEMBER_BUNDLE`, so that is any plain company member.
   *
   * The damage is total and irreversible: `status='ended'`, the Daily room deleted, rejoin
   * refused, and `MEETING_TRANSITIONS.ended === []` so there is no way back. It also bypasses
   * `meetingsRepository.cancel` entirely — no counterparty notification, no `cancelled` outcome,
   * and the expert's slot stays blocked, because `consultationStatusForMeeting` maps every
   * non-`cancelled` label to `confirmed`.
   *
   * Every SWEEP rule carries a wall-clock precondition anchored on `scheduledStart` for exactly
   * this reason. The human path had none.
   */
  it('⚠⚠ REFUSES to end a consultation that has not started — 409, and nothing is written', async () => {
    const teardown = fakeTeardown();
    const future = new Date(START.getTime() + 3 * 24 * 3_600_000);
    mockAuthorizeParticipation.mockResolvedValue({
      ok: true,
      side: 'client',
      meeting: meetingRow({ status: 'scheduled', scheduledStart: future, startedAt: null }),
      subject: { contextType: 'case', contextId: 'ctx-1' },
      companyId: 'company-1',
      expertProfileId: null,
    });

    await expect(
      endMeeting({ meetingId: MEETING_ID, userId: USER_ID, teardown, now: NOW })
    ).resolves.toEqual({ ok: false, code: 'meeting_not_started' });

    expect(mockEndMeeting).not.toHaveBeenCalled();
    expect(teardown.calls).toEqual([]);
    expect(mockTrackServer).not.toHaveBeenCalled();
  });

  /**
   * ⚠ THE GATE IS THE MINIMUM HONEST ONE — `now >= scheduledStart` — so it still admits the whole
   * in-window life of the meeting, INCLUDING the missed-call window where `scheduled` is a
   * perfectly legitimate thing to end. Narrowing it to "must be `in_progress`" would break the
   * expert-never-showed case the End button exists for.
   */
  it('⚠ still ends a `scheduled` meeting once its start has passed — nobody joined', async () => {
    mockAuthorizeParticipation.mockResolvedValue({
      ok: true,
      side: 'client',
      meeting: meetingRow({ status: 'scheduled', startedAt: null }),
      subject: { contextType: 'case', contextId: 'ctx-1' },
      companyId: 'company-1',
      expertProfileId: null,
    });

    await expect(
      endMeeting({ meetingId: MEETING_ID, userId: USER_ID, teardown: fakeTeardown(), now: NOW })
    ).resolves.toMatchObject({ ok: true, alreadyEnded: false });
    expect(mockEndMeeting).toHaveBeenCalledTimes(1);
  });

  it('⚠ ends a meeting at exactly its scheduled start — the boundary is inclusive', async () => {
    mockAuthorizeParticipation.mockResolvedValue({
      ok: true,
      side: 'client',
      meeting: meetingRow({ status: 'scheduled', startedAt: null }),
      subject: { contextType: 'case', contextId: 'ctx-1' },
      companyId: 'company-1',
      expertProfileId: null,
    });

    await expect(
      endMeeting({ meetingId: MEETING_ID, userId: USER_ID, teardown: fakeTeardown(), now: START })
    ).resolves.toMatchObject({ ok: true });
  });

  // ── THE TERMINAL WRITE ──────────────────────────────────────────────────────────────────

  /** ⚠ D5 — THE ENDER NEVER SETS THE OUTCOME. BAL-412 resolves it from `meeting_presence`. */
  it('⚠ writes `outcome: null` on the human path — the ender never sets the outcome', async () => {
    await endMeeting({
      meetingId: MEETING_ID,
      userId: USER_ID,
      teardown: fakeTeardown(),
      now: NOW,
    });

    expect(mockEndMeeting).toHaveBeenCalledWith({
      id: MEETING_ID,
      outcome: null,
      endedBy: 'client_principal',
      endedAt: NOW,
      actorUserId: USER_ID,
    });
  });

  it('answers a non-idempotent success with the label it stamped', async () => {
    await expect(
      endMeeting({ meetingId: MEETING_ID, userId: USER_ID, teardown: fakeTeardown(), now: NOW })
    ).resolves.toEqual({
      ok: true,
      status: 'ended',
      alreadyEnded: false,
      endedBy: 'client_principal',
    });
  });

  // ── D10 — THE IDEMPOTENT SECOND END ─────────────────────────────────────────────────────

  /**
   * ⚠⚠ TWO HOLDERS CAN PRESS END IN THE SAME INSTANT. The loser gets a `200`, and — the half
   * that actually matters — **NO SECOND EFFECT OF ANY KIND**: no teardown, no analytics. A
   * `409` here would surface a routine race as a user-facing error on the one control that must
   * always work.
   */
  it('⚠⚠ a SECOND end is an idempotent success with NO second effect', async () => {
    mockEndMeeting.mockResolvedValue(undefined);
    const teardown = fakeTeardown();

    await expect(
      endMeeting({ meetingId: MEETING_ID, userId: USER_ID, teardown, now: NOW })
    ).resolves.toEqual({ ok: true, status: 'ended', alreadyEnded: true, endedBy: null });

    expect(teardown.calls).toEqual([]);
    expect(mockTrackServer).not.toHaveBeenCalled();
    // ⚠ NOT ON THE alreadyEnded PATH — the recording-stop enqueue is step 6, and nothing after
    // step 5 runs on the idempotent branch.
    expect(mockEnqueueRecordingStop).not.toHaveBeenCalled();
  });

  // ── R5 — THE ORDERING ───────────────────────────────────────────────────────────────────

  /**
   * ⚠ THE TERMINAL WRITE COMMITS **BEFORE** THE ROOM IS DELETED. Reversed, a teardown failure
   * would leave a room deleted for a meeting that is still `in_progress` — participants locked
   * out of a live consultation with no record that it ended. The recording-finalization seam
   * sits between these two steps by construction.
   */
  it('⚠ ends in Postgres, THEN enqueues recording-stop, THEN tears the room down', async () => {
    const order: string[] = [];
    mockEndMeeting.mockImplementation(async () => {
      order.push('endMeeting');
      return {
        meeting: meetingRow({ status: 'ended', endedAt: NOW }),
        closedIntervals: 1,
      };
    });
    mockEnqueueRecordingStop.mockImplementation(async () => {
      order.push('enqueueRecordingStop');
    });
    const teardown: RoomTeardown = {
      deleteRoom: async () => {
        order.push('deleteRoom');
        return 'deleted';
      },
    };

    await endMeeting({ meetingId: MEETING_ID, userId: USER_ID, teardown, now: NOW });

    expect(order).toEqual(['endMeeting', 'enqueueRecordingStop', 'deleteRoom']);
  });

  it('enqueues recording-stop for the ended meeting id', async () => {
    const teardown = fakeTeardown();

    await endMeeting({ meetingId: MEETING_ID, userId: USER_ID, teardown, now: NOW });

    expect(mockEnqueueRecordingStop).toHaveBeenCalledWith({ meetingId: MEETING_ID });
  });

  /**
   * ⚠ BEST-EFFORT, LIKE `tearDownRoom` — the meeting is already terminal in Postgres, so an
   * enqueue fault must never fail the End request the person who ended the meeting is waiting
   * on.
   */
  it('the enqueue failing does not fail the End — best-effort, like teardown', async () => {
    mockEnqueueRecordingStop.mockRejectedValue(new Error('redis is down'));
    const teardown = fakeTeardown();

    await expect(
      endMeeting({ meetingId: MEETING_ID, userId: USER_ID, teardown, now: NOW })
    ).resolves.toMatchObject({ ok: true, alreadyEnded: false });

    expect(mockError).toHaveBeenCalled();
    // Teardown still runs — the fault is contained to the enqueue.
    expect(teardown.calls).toEqual([ROOM_NAME]);
  });

  it('tears down the room the meeting actually names', async () => {
    const teardown = fakeTeardown();

    await endMeeting({ meetingId: MEETING_ID, userId: USER_ID, teardown, now: NOW });

    expect(teardown.calls).toEqual([ROOM_NAME]);
  });

  it('skips teardown for an UNPROVISIONED meeting — there is no room', async () => {
    mockEndMeeting.mockResolvedValue({
      meeting: meetingRow({ status: 'ended', endedAt: NOW, dailyRoomName: null }),
      closedIntervals: 0,
    });
    const teardown = fakeTeardown();

    await endMeeting({ meetingId: MEETING_ID, userId: USER_ID, teardown, now: NOW });

    expect(teardown.calls).toEqual([]);
  });

  /**
   * ⚠ A VENDOR FAILURE MUST NOT FAIL THE REQUEST. The meeting is ALREADY terminal in Postgres
   * and `MEETING_CLOSED_TO_JOIN` already refuses a Balo-side rejoin, so failing here would
   * report an ended meeting as an error to the person who ended it.
   */
  it('⚠ a TEARDOWN FAILURE still returns success, and logs at error', async () => {
    await expect(
      endMeeting({
        meetingId: MEETING_ID,
        userId: USER_ID,
        teardown: fakeTeardown('throws'),
        now: NOW,
      })
    ).resolves.toMatchObject({ ok: true, alreadyEnded: false });

    expect(mockError).toHaveBeenCalledWith(
      expect.objectContaining({ meetingId: MEETING_ID, roomName: ROOM_NAME }),
      expect.stringContaining('teardown failed')
    );
  });

  // ── ANALYTICS ───────────────────────────────────────────────────────────────────────────

  it('emits `meeting_ended` with the clocks read at `ended_at`', async () => {
    await endMeeting({
      meetingId: MEETING_ID,
      userId: USER_ID,
      teardown: fakeTeardown(),
      now: NOW,
    });

    expect(mockTrackServer).toHaveBeenCalledWith('meeting_ended', {
      meeting_id: MEETING_ID,
      // Expert 10:00→11:00 = 3600s; both present from 10:05 = 3300s.
      billable_seconds: 3300,
      expert_present_seconds: 3600,
      participant_count: 2,
      outcome: null,
      ended_by: 'client_principal',
      // ⚠ THE ACTING USER on a human end.
      distinct_id: USER_ID,
    });
  });

  it('reports zero clocks for a meeting nobody ever joined', async () => {
    mockListByMeeting.mockResolvedValue([]);

    await endMeeting({
      meetingId: MEETING_ID,
      userId: USER_ID,
      teardown: fakeTeardown(),
      now: NOW,
    });

    expect(mockTrackServer).toHaveBeenCalledWith(
      'meeting_ended',
      expect.objectContaining({
        billable_seconds: 0,
        expert_present_seconds: 0,
        participant_count: 0,
      })
    );
  });

  // ── BAL-412 — PRESENCE SETTLEMENT, BEST-EFFORT AND NON-FATAL ────────────────────────────

  it('calls settleMeetingIfBillable with the ended meeting id and the ACTING user (not null)', async () => {
    await endMeeting({
      meetingId: MEETING_ID,
      userId: USER_ID,
      teardown: fakeTeardown(),
      now: NOW,
    });

    expect(mockSettleMeetingIfBillable).toHaveBeenCalledWith({
      meetingId: MEETING_ID,
      actorUserId: USER_ID,
    });
  });

  it('⚠ a SETTLEMENT FAILURE still returns success, and logs at error (never fails the End request)', async () => {
    mockSettleMeetingIfBillable.mockRejectedValue(new Error('settlement boom'));

    await expect(
      endMeeting({ meetingId: MEETING_ID, userId: USER_ID, teardown: fakeTeardown(), now: NOW })
    ).resolves.toMatchObject({ ok: true, alreadyEnded: false });

    expect(mockError).toHaveBeenCalledWith(
      expect.objectContaining({ meetingId: MEETING_ID }),
      expect.stringContaining('Presence settlement failed')
    );
  });

  it('does not call settlement on the idempotent already-ended branch', async () => {
    mockEndMeeting.mockResolvedValue(undefined);

    await endMeeting({
      meetingId: MEETING_ID,
      userId: USER_ID,
      teardown: fakeTeardown(),
      now: NOW,
    });

    expect(mockSettleMeetingIfBillable).not.toHaveBeenCalled();
  });
});

/**
 * ⚠ THE AC "the End endpoint finalizes the recording before teardown" IS NOW SATISFIED FOR
 * REAL (BAL-473, OD-2) — not vacuously. `rooms.ts` enables `enable_recording: 'cloud'` on
 * every provisioned room, and `recording-stop` (`jobs/recording-capture.ts`) is a real BullMQ
 * job enqueued at step 6, the `RECORDING_FINALIZATION_SEAM` position. The tests that pin this:
 * "⚠ ends in Postgres, THEN enqueues recording-stop, THEN tears the room down" (the ordering),
 * "enqueues recording-stop for the ended meeting id" (the call), "the enqueue failing does not
 * fail the End" (the best-effort posture), and the idempotent-second-end test above (NOT on
 * the `alreadyEnded` path).
 *
 * ⚠ THERE IS DELIBERATELY NO TEST OF `RECORDING_FINALIZATION_SEAM`'S TEXT. One used to exist —
 * `expect(RECORDING_FINALIZATION_SEAM).toContain('before teardown')` — and it asserted a string
 * against its own substring: it could never fail for any reason connected to this service's
 * behaviour, while reading in the report as coverage of the AC. A tautology that LOOKS like a
 * guarantee is worse than no test at all, so it is gone rather than reworded.
 */

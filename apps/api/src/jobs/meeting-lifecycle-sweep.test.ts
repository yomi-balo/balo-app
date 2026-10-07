import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockListCandidates,
  mockListStranded,
  mockFindMeetingById,
  mockEndMeeting,
  mockListByMeeting,
  mockListContexts,
  mockResolveOwner,
  mockResolvePresenceEffect,
  mockApplyPresenceEffect,
  mockClosePresenceEffectForRow,
  mockReconcileMeetingStatus,
  mockDeliveringPartyName,
  mockEmitMeetingEnded,
  mockScheduleExpertAbsent,
  mockScheduleClientAbsent,
  mockDeleteRoom,
  mockTrackServer,
  mockWarn,
  mockErrorLog,
  mockInfo,
  mockSettleSessionlessCaseMeeting,
  mockEnqueueRecordingEnsure,
  mockEnqueueRecordingStop,
  mockFindCapturingForMeeting,
  mockCountFailedByStage,
} = vi.hoisted(() => ({
  mockListCandidates: vi.fn(),
  mockListStranded: vi.fn(),
  mockFindMeetingById: vi.fn(),
  mockEndMeeting: vi.fn(),
  mockListByMeeting: vi.fn(),
  mockListContexts: vi.fn(),
  mockResolveOwner: vi.fn(),
  mockResolvePresenceEffect: vi.fn(),
  mockApplyPresenceEffect: vi.fn(),
  mockClosePresenceEffectForRow: vi.fn(),
  mockReconcileMeetingStatus: vi.fn(),
  mockDeliveringPartyName: vi.fn(),
  mockEmitMeetingEnded: vi.fn(),
  mockScheduleExpertAbsent: vi.fn(),
  mockScheduleClientAbsent: vi.fn(),
  mockDeleteRoom: vi.fn(),
  mockTrackServer: vi.fn(),
  mockWarn: vi.fn(),
  mockErrorLog: vi.fn(),
  mockInfo: vi.fn(),
  mockSettleSessionlessCaseMeeting: vi.fn(),
  mockEnqueueRecordingEnsure: vi.fn(),
  mockEnqueueRecordingStop: vi.fn(),
  mockFindCapturingForMeeting: vi.fn(),
  mockCountFailedByStage: vi.fn(),
}));

/** See the `./recording-capture.js` mock below — a stand-in cap, not the real constant. */
const MOCK_MAX_DAILY_FAILURES = vi.hoisted(() => 7);

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: mockInfo, warn: mockWarn, error: mockErrorLog }),
}));
vi.mock('@balo/db', () => ({
  db: {},
  meetingsRepository: {
    listLifecycleCandidates: mockListCandidates,
    listStrandedLifecycleCandidates: mockListStranded,
    findById: mockFindMeetingById,
    endMeeting: mockEndMeeting,
  },
  meetingPresenceRepository: { listByMeeting: mockListByMeeting },
  meetingContextsRepository: { listByMeeting: mockListContexts },
  // BAL-480 — MANDATORY: `needsRecordingEnsure` calls `findCapturingForMeeting` directly. A
  // vitest factory mock throws on any export the import graph touches but the factory omits, so
  // omitting this fails EVERY test in this file at import.
  meetingRecordingsRepository: {
    findCapturingForMeeting: mockFindCapturingForMeeting,
    countFailedByStage: mockCountFailedByStage,
  },
  resolveMeetingContextOwner: mockResolveOwner,
}));
vi.mock('@balo/analytics/server', () => ({
  trackServer: mockTrackServer,
  MEETING_SERVER_EVENTS: {
    MEETING_WAITING_ABANDONED: 'meeting_waiting_abandoned',
    MEETING_MISSED_CALL: 'meeting_missed_call',
    // BAL-581 — MANDATORY: without this the venue arm calls `trackServer(undefined, …)`.
    MEETING_VENUE_UNAVAILABLE: 'meeting_venue_unavailable',
    MEETING_OVERRUN_STOPPED: 'meeting_overrun_stopped',
    MEETING_PRESENCE_RECONCILED: 'meeting_presence_reconciled',
  },
}));
// ⚠⚠ THE FULL MODULE SURFACE, NOT JUST THE TWO FUNCTIONS THIS FILE HAPPENS TO ASSERT ON.
// This factory named only `resolvePresenceEffect` and `applyPresenceEffect`, which meant the
// suite STRUCTURALLY could not observe whether the sweep repaired a meeting's STATUS — the C1
// defect (the reconciler repaired `left` but not `joined`, so a meeting whose join webhooks both
// dropped could never reach a terminal rule) was invisible here by construction, not by
// oversight. A vitest factory mock throws on any export the import graph touches but the factory
// omits, so keeping this list complete is what keeps the omission from recurring silently.
vi.mock('../services/meetings/presence-writer.js', () => ({
  resolvePresenceEffect: mockResolvePresenceEffect,
  applyPresenceEffect: mockApplyPresenceEffect,
  closePresenceEffectForRow: mockClosePresenceEffectForRow,
  reconcileMeetingStatus: mockReconcileMeetingStatus,
}));
vi.mock('../services/meetings/delivering-party.js', () => ({
  deliveringPartyName: mockDeliveringPartyName,
}));
vi.mock('../services/meetings/end-meeting.js', () => ({ emitMeetingEnded: mockEmitMeetingEnded }));
// BAL-412 → BAL-474. Mocked so this suite stays focused on the sweep's own three passes; the
// sessionless settlement service's own behaviour is covered in
// `settle-sessionless-case-meeting.test.ts`, the presence wrapper's in `settle-from-presence.test.ts`.
vi.mock('../services/credit-session/settle-sessionless-case-meeting.js', () => ({
  settleSessionlessCaseMeeting: mockSettleSessionlessCaseMeeting,
}));
vi.mock('../notifications/scheduling/meeting-absence.js', () => ({
  scheduleExpertAbsentAlert: mockScheduleExpertAbsent,
  scheduleClientAbsentNudge: mockScheduleClientAbsent,
}));
vi.mock('../services/daily/rooms.js', () => ({
  dailyRoomTeardown: { deleteRoom: mockDeleteRoom },
  dailyPresenceReader: { getAllPresence: vi.fn(), getRoomPresence: vi.fn() },
}));
// BAL-473 — MANDATORY: `meeting-lifecycle-sweep.ts` now imports `enqueueRecordingEnsure` /
// `enqueueRecordingStop` from `./recording-capture.js`, which in turn imports `../lib/queue.js`
// → `../lib/redis.js`. Left unmocked, a test that actually TRIGGERS either enqueue (a terminal
// rule firing, or a repaired `in_progress` transition) would call the REAL `getQueue()` and
// attempt a real Redis connection — exactly the hang this suite's own comment below warns about.
//
// ⚠⚠ BAL-480 FIX ROUND 1 — `MAX_DAILY_FAILURES_PER_MEETING` MUST BE RE-EXPORTED BY THIS FACTORY.
// `needsRecordingEnsure` now reads it, and a vitest factory mock throws on any export the import
// graph touches but the factory omits — omitting it fails EVERY test in this file at import.
// ⚠ THE VALUE HERE IS A STAND-IN, NOT THE REAL CONSTANT, and the tests below use the SAME
// stand-in, so what they pin is the COMPARISON, never the number. The number itself is pinned
// against the real module in `recording-capture.test.ts` ("the cap is now ATTEMPTS + re-arm
// allowance + reap allowance").
vi.mock('./recording-capture.js', () => ({
  enqueueRecordingEnsure: mockEnqueueRecordingEnsure,
  enqueueRecordingStop: mockEnqueueRecordingStop,
  MAX_DAILY_FAILURES_PER_MEETING: MOCK_MAX_DAILY_FAILURES,
}));
// ⚠ NEITHER `../lib/redis.js` NOR `../lib/queue.js` IS REACHED: only `runMeetingLifecycleSweep`
// is imported, and the Worker/cron constructors are never called. ⚠ `@balo/shared/meetings` is
// NOT mocked — `resolveTerminalRule` and `dailyParticipantIdFor` are what these rows assert.

import {
  dailyParticipantIdFor,
  dailyRoomNameForMeeting,
  isMeetingVenueReady,
  DEFAULT_MEETING_TIMERS,
} from '@balo/shared/meetings';
import {
  MAX_RECONCILER_CLOSES_PER_TICK,
  MAX_RECORDING_ENSURES_PER_SWEEP_TICK,
  MAX_ROOM_PRESENCE_READS_PER_TICK,
  MEETING_LIFECYCLE_BATCH_LIMIT,
  MEETING_LIFECYCLE_SWEEP_CRON,
  MEETING_STRANDED_BATCH_LIMIT,
  roomOccupancy,
  runMeetingLifecycleSweep,
} from './meeting-lifecycle-sweep.js';
import type { PresenceReader } from '../services/daily/rooms.js';
import { DailyApiError } from '../services/daily/errors.js';

const MEETING_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER_ID = '33333333-3333-4333-8333-333333333333';
const ROOM = 'balo-22222222222242228222222222222222';
const START = new Date('2026-08-14T10:00:00.000Z');
const MINUTE = 60_000;

/** `START + n` minutes — the only way an instant is constructed in this file. */
function at(minutes: number): Date {
  return new Date(START.getTime() + minutes * MINUTE);
}

/**
 * ⚠⚠ BAL-581 — VENUE-COMPLETE BY DEFAULT, AND THAT IS THE CANARY. `isMeetingVenueReady` needs
 * `dailyRoomName` AND `joinUrl` AND a name that matches `dailyRoomNameForMeeting(id)`;
 * `meetingVenueReadyAt` also reads `createdAt`/`venueProvisionedAt`. Without `joinUrl` this
 * fixture reads as NOT READY and every existing missed-call/no-show/idle-end row in this file
 * would silently flip to `venue_unavailable` the moment the sweep started passing `venueReadyAt`
 * through. `createdAt`/`venueProvisionedAt` are both 24h BEFORE `START` — "ready at booking",
 * the ordinary case every pre-BAL-581 row means.
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
    startedAt: null,
    endedAt: null,
    outcome: null,
    ...overrides,
  };
}

type Participants = Array<{ userId?: string }>;

/** A stored presence row — an OPEN interval (`leftAt: null`) unless overridden. */
function presenceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'row-1',
    userId: USER_ID,
    meetingGuestId: null,
    party: 'client',
    joinedAt: START,
    leftAt: null,
    ...overrides,
  };
}

/**
 * A per-room read that THROWS — the default, so a test that reaches a per-room read it did not
 * stub reads as UNKNOWN (today's outcome) rather than as a confirmed-empty room.
 */
const UNSTUBBED_ROOM_READ = async (): Promise<Participants> => {
  throw new Error('per-room read not stubbed');
};

/**
 * A presence reader port that answers a fixed platform-wide roster and, optionally, a per-room
 * read — no network, no Daily account.
 */
function reader(
  rooms: Record<string, Participants>,
  getRoomPresence: PresenceReader['getRoomPresence'] = UNSTUBBED_ROOM_READ
): PresenceReader {
  return { getAllPresence: async () => rooms, getRoomPresence };
}

const EMPTY_READER = reader({});

describe('runMeetingLifecycleSweep (BAL-134 §5.6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListCandidates.mockResolvedValue([]);
    mockListStranded.mockResolvedValue([]);
    mockListByMeeting.mockResolvedValue([]);
    mockListContexts.mockResolvedValue([
      { meetingId: MEETING_ID, contextType: 'case', contextId: 'ctx-1' },
    ]);
    mockResolveOwner.mockResolvedValue({ companyId: 'company-1', expertProfileId: 'expert-1' });
    mockEndMeeting.mockResolvedValue({ meeting: meeting({ status: 'ended' }), closedIntervals: 1 });
    mockDeleteRoom.mockResolvedValue('deleted');
    mockApplyPresenceEffect.mockResolvedValue('closed');
    mockResolvePresenceEffect.mockResolvedValue({ action: 'open' });
    mockClosePresenceEffectForRow.mockReturnValue({ action: 'close' });
    mockFindMeetingById.mockResolvedValue(meeting());
    mockReconcileMeetingStatus.mockResolvedValue(null);
    mockDeliveringPartyName.mockResolvedValue('CloudPeak');
    // ⚠ BAL-466 wires the enabling condition; `no_meeting` is still the default here because
    // most fixtures in this file are non-`case` / unfunded meetings, not because settlement is
    // globally inert.
    // BAL-474 — nothing owed by default (a zero shape, or not a Case meeting).
    mockSettleSessionlessCaseMeeting.mockResolvedValue({
      kind: 'not_billable',
      reason: 'not_a_case_meeting',
    });
    // BAL-480 — no capturing segment by default; individual tests override to exercise the
    // level-triggered gate.
    mockFindCapturingForMeeting.mockResolvedValue(undefined);
    // BAL-480 fix round 1 — well under the per-meeting Daily failure cap by default.
    mockCountFailedByStage.mockResolvedValue(0);
  });

  /** ⚠⚠ THE CANARY — if this ever goes red, every missed-call/no-show/idle-end row below it is
   * silently exercising `venue_unavailable` instead of the rule it claims to. */
  it('⚠⚠ the default fixture is venue-READY — the canary for every other row in this file', () => {
    expect(isMeetingVenueReady(meeting())).toBe(true);
  });

  it('scans nothing and does nothing on an empty batch — no vendor call', async () => {
    const getAllPresence = vi.fn();

    await expect(
      runMeetingLifecycleSweep(at(30), () => {}, { getAllPresence, getRoomPresence: vi.fn() })
    ).resolves.toMatchObject({ scanned: 0, stranded: 0, terminated: 0 });
    expect(getAllPresence).not.toHaveBeenCalled();
  });

  it('asks for the three NON-TERMINAL statuses, inside a bounded lookback', async () => {
    await runMeetingLifecycleSweep(at(30), () => {}, EMPTY_READER);

    expect(mockListCandidates).toHaveBeenCalledWith({
      statuses: ['scheduled', 'waiting_for_participants', 'in_progress'],
      scheduledStartAfter: new Date(at(30).getTime() - 24 * 60 * MINUTE),
      limit: MEETING_LIFECYCLE_BATCH_LIMIT,
    });
  });

  /**
   * ⚠ NO SILENT CAPS. A full batch means meetings were DROPPED from this tick, and the sweep is
   * the only layer that can say so — `@balo/db` has no business logging a business event.
   */
  it('⚠ WARNS when the batch FILLS, naming the oldest scheduled start it reached', async () => {
    mockListCandidates.mockResolvedValue(
      Array.from({ length: MEETING_LIFECYCLE_BATCH_LIMIT }, (_unused, index) =>
        meeting({ id: `meeting-${index}`, status: 'scheduled' })
      )
    );

    await runMeetingLifecycleSweep(at(1), () => {}, EMPTY_READER);

    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: MEETING_LIFECYCLE_BATCH_LIMIT,
        oldestScheduledStart: START.toISOString(),
      }),
      expect.stringContaining('FILLED')
    );
  });

  it('⚠ R6F-15 — the full-batch warn names the OLDEST start in the batch, though the batch is ranked by status first', async () => {
    const oldest = new Date(START.getTime() - 3 * 60 * 60_000);
    mockListCandidates.mockResolvedValue([
      // An in_progress call that started EARLY comes first; the oldest meeting is later in the batch.
      meeting({ id: 'early-call', status: 'in_progress', scheduledStart: at(45) }),
      ...Array.from({ length: MEETING_LIFECYCLE_BATCH_LIMIT - 2 }, (_unused, index) =>
        meeting({ id: `meeting-${index}`, status: 'scheduled' })
      ),
      meeting({ id: 'oldest', status: 'scheduled', scheduledStart: oldest }),
    ]);

    await runMeetingLifecycleSweep(at(1), () => {}, EMPTY_READER);

    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({ oldestScheduledStart: oldest.toISOString() }),
      expect.stringContaining('FILLED')
    );
  });

  // ── PASS 1 — RECONCILIATION ─────────────────────────────────────────────────────────────

  /**
   * ⚠ EVERY INTERVAL THIS CLOSES IS A DROPPED `participant.left` WEBHOOK, and the RATE is the
   * health signal for the whole presence model — this warn is the only place it exists.
   */
  it('⚠ closes an open interval the vendor roster does not confirm, and WARNS about it', async () => {
    mockListCandidates.mockResolvedValue([meeting({ status: 'in_progress' })]);
    mockFindMeetingById.mockResolvedValue(meeting({ status: 'in_progress' }));
    mockListByMeeting.mockResolvedValue([presenceRow()]);

    const result = await runMeetingLifecycleSweep(at(30), () => {}, reader({ [ROOM]: [] }));

    expect(result.intervalsClosed).toBe(1);
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({ meetingId: MEETING_ID }),
      expect.stringContaining('dropped webhook')
    );
  });

  /**
   * ⚠⚠ THE CLOSE PATH DERIVES NO PARTY. `close` matches on IDENTITY only, so a full
   * `resolvePresenceEffect` — the participation gate plus a delivery-identity read — would run
   * per open interval, per candidate, per MINUTE (up to 200×N a tick) and change nothing about
   * the write.
   */
  it('⚠⚠ builds the CLOSE effect from the stored row — never through the party derivation', async () => {
    mockListCandidates.mockResolvedValue([meeting({ status: 'in_progress' })]);
    mockFindMeetingById.mockResolvedValue(meeting({ status: 'in_progress' }));
    const row = presenceRow();
    mockListByMeeting.mockResolvedValue([row]);

    await runMeetingLifecycleSweep(at(30), () => {}, reader({ [ROOM]: [] }));

    expect(mockClosePresenceEffectForRow).toHaveBeenCalledWith(
      expect.objectContaining({ id: MEETING_ID }),
      row,
      at(30)
    );
    expect(mockResolvePresenceEffect).not.toHaveBeenCalled();
  });

  it('leaves an interval alone when the vendor CONFIRMS the participant', async () => {
    mockListCandidates.mockResolvedValue([meeting({ status: 'in_progress' })]);
    mockListByMeeting.mockResolvedValue([presenceRow()]);

    const result = await runMeetingLifecycleSweep(
      at(30),
      () => {},
      reader({
        [ROOM]: [{ userId: dailyParticipantIdFor('user', USER_ID) }],
      })
    );

    expect(result.intervalsClosed).toBe(0);
  });

  it('opens an interval for a vendor participant Balo has none for (a dropped `joined`)', async () => {
    mockListCandidates.mockResolvedValue([meeting({ status: 'in_progress' })]);
    mockFindMeetingById.mockResolvedValue(meeting({ status: 'in_progress' }));
    mockApplyPresenceEffect.mockResolvedValue('opened');

    const result = await runMeetingLifecycleSweep(
      at(30),
      () => {},
      reader({
        [ROOM]: [{ userId: dailyParticipantIdFor('user', USER_ID) }],
      })
    );

    expect(result.intervalsOpened).toBe(1);
  });

  // ── ⚠⚠ C1 — THE RECONCILER MUST REPAIR **STATUS**, NOT ONLY PRESENCE ────────────────────

  /**
   * ⚠⚠ THE STRANDING THIS CLOSES, TRACED IN FULL.
   *
   * `reconcileMeetingStatus` owns every FORWARD transition (`scheduled →
   * waiting_for_participants`, and expert ∧ client → `in_progress`), and its only other caller
   * is the Daily webhook — so the webhook was a SINGLE POINT OF FAILURE for all of them, and
   * this job, whose entire purpose is repairing dropped webhooks, repaired `left` but not
   * `joined`. Expert and client both join, both `participant.joined` deliveries drop, the
   * reconciler opens both intervals, and the status stays `scheduled`: `missedCallApplies` is
   * disarmed by `expertEverPresent`, rules 2 and 4 need the room to be EMPTY or the expert to be
   * open on a pre-`in_progress` status, and rule 1 needs `in_progress`. NO rule can ever fire —
   * a non-terminal meeting accruing billable presence with nothing left to terminate it.
   *
   * ⚠ BAL-480 — the sweep now fires `recording-ensure` on the LEVEL (`needsRecordingEnsure`,
   * evaluated from `processCandidate` after `terminateIfDue`), not on the EDGE of this repair —
   * the repaired transition is SUBSUMED by the level gate rather than triggering it directly.
   * The gate reads `state.facts.anyOpen`, which is POST-repair (`loadCandidateState`'s second
   * call, after the reconciler opened both intervals), so this fixture supplies that read.
   */
  it('⚠⚠ C1 — a reconciler-opened expert+client pair drives the STATUS transition too', async () => {
    mockListCandidates.mockResolvedValue([meeting({ status: 'scheduled' })]);
    mockFindMeetingById.mockResolvedValue(meeting({ status: 'scheduled' }));
    mockApplyPresenceEffect.mockResolvedValue('opened');
    mockReconcileMeetingStatus.mockResolvedValue('in_progress');
    // The FIRST `listByMeeting` call is `processCandidate`'s pre-reconciliation snapshot; the
    // SECOND is the post-repair re-read the level gate's `anyOpen` reads.
    mockListByMeeting.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { party: 'expert', joinedAt: START, leftAt: null },
      { party: 'client', joinedAt: at(2), leftAt: null },
    ]);

    await runMeetingLifecycleSweep(
      at(30),
      () => {},
      reader({
        [ROOM]: [
          { userId: dailyParticipantIdFor('user', USER_ID) },
          { userId: dailyParticipantIdFor('user', OTHER_USER_ID) },
        ],
      })
    );

    // ⚠ THE RE-READ ROW, not the batch snapshot — `processCandidate` used to reuse the stale one.
    expect(mockFindMeetingById).toHaveBeenCalledWith(MEETING_ID);
    expect(mockReconcileMeetingStatus).toHaveBeenCalledWith(
      expect.objectContaining({ id: MEETING_ID }),
      at(30)
    );
    // BAL-480 — the LEVEL-triggered self-heal fires for the repaired candidate; monotonic
    // per-minute dedupe token, never the bare meetingId alone.
    expect(mockEnqueueRecordingEnsure).toHaveBeenCalledWith({
      meetingId: MEETING_ID,
      trigger: 'sweep',
      dedupeToken: `sweep-${Math.floor(at(30).getTime() / 60_000)}`,
    });
  });

  it('does NOT enqueue recording-ensure when the reconciler moves to `waiting_for_participants`', async () => {
    mockListCandidates.mockResolvedValue([meeting({ status: 'scheduled' })]);
    mockFindMeetingById.mockResolvedValue(meeting({ status: 'scheduled' }));
    mockApplyPresenceEffect.mockResolvedValue('opened');
    mockReconcileMeetingStatus.mockResolvedValue('waiting_for_participants');

    await runMeetingLifecycleSweep(
      at(30),
      () => {},
      reader({
        [ROOM]: [{ userId: dailyParticipantIdFor('user', USER_ID) }],
      })
    );

    expect(mockEnqueueRecordingEnsure).not.toHaveBeenCalled();
  });

  /**
   * ⚠⚠ AND THE TRANSITION IS THREADED INTO THE TERMINAL EVALUATION. Repairing the status in the
   * database but then judging the rules against the pre-repair snapshot would be the same bug
   * one layer along: the meeting is `in_progress` and its room is empty, so the IDLE END must
   * fire on THIS tick, not on some later one that happens to re-read it.
   */
  it('⚠⚠ C1 — the repaired status is what the terminal rules see', async () => {
    mockListCandidates.mockResolvedValue([meeting({ status: 'scheduled' })]);
    mockFindMeetingById.mockResolvedValue(meeting({ status: 'scheduled' }));
    mockApplyPresenceEffect.mockResolvedValue('opened');
    mockReconcileMeetingStatus.mockResolvedValue('in_progress');
    mockListByMeeting.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { party: 'expert', joinedAt: START, leftAt: at(20) },
      { party: 'client', joinedAt: at(2), leftAt: at(20) },
    ]);

    const result = await runMeetingLifecycleSweep(
      at(30),
      () => {},
      reader({
        [ROOM]: [{ userId: dailyParticipantIdFor('user', USER_ID) }],
      })
    );

    // Only reachable via `in_progress` — a `scheduled` meeting whose expert HAS been present
    // matches the abandoned wait instead, which carries a NULL outcome.
    expect(result.terminated).toBe(1);
    expect(mockEndMeeting).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'completed' }));
  });

  it('does NOT re-read or re-transition when reconciliation changed nothing', async () => {
    mockListCandidates.mockResolvedValue([meeting({ status: 'in_progress' })]);
    mockListByMeeting.mockResolvedValue([
      presenceRow({ party: 'expert' }),
      presenceRow({ id: 'row-2', userId: OTHER_USER_ID, joinedAt: at(1) }),
    ]);

    await runMeetingLifecycleSweep(
      at(20),
      () => {},
      reader({
        [ROOM]: [
          { userId: dailyParticipantIdFor('user', USER_ID) },
          { userId: dailyParticipantIdFor('user', OTHER_USER_ID) },
        ],
      })
    );

    expect(mockFindMeetingById).not.toHaveBeenCalled();
    expect(mockReconcileMeetingStatus).not.toHaveBeenCalled();
  });

  it('a meeting soft-deleted between the batch read and the repair is skipped, not thrown on', async () => {
    mockListCandidates.mockResolvedValue([meeting({ status: 'in_progress' })]);
    mockApplyPresenceEffect.mockResolvedValue('opened');
    mockFindMeetingById.mockResolvedValue(undefined);

    const result = await runMeetingLifecycleSweep(
      at(30),
      () => {},
      reader({
        [ROOM]: [{ userId: dailyParticipantIdFor('user', USER_ID) }],
      })
    );

    expect(result.terminated).toBe(0);
    expect(mockEndMeeting).not.toHaveBeenCalled();
    expect(mockErrorLog).not.toHaveBeenCalled();
  });

  // ── ⚠⚠ BAL-480 — THE LEVEL-TRIGGERED recording-ensure SELF-HEAL ─────────────────────────

  /**
   * ⚠⚠ THE LEVEL TRIGGER FIRES WITH NO REPAIR AT ALL. BAL-473's edge trigger only fired on the
   * tick that REPAIRED a `→ in_progress` transition; a healthy candidate that was ALREADY
   * `in_progress` (no reconciliation needed this tick) never reached it. The level gate reads
   * post-repair state, but when nothing needed repairing that is simply the initial snapshot —
   * `mockReconcileMeetingStatus` never runs, proving this is not the old edge path.
   */
  it('⚠⚠ BAL-480 — the level trigger fires with NO repair on this tick', async () => {
    mockListCandidates.mockResolvedValue([meeting({ status: 'in_progress' })]);
    mockListByMeeting.mockResolvedValue([
      presenceRow({ id: 'row-0', userId: OTHER_USER_ID, party: 'expert' }),
      presenceRow({ joinedAt: at(1) }),
    ]);

    await runMeetingLifecycleSweep(
      at(20),
      () => {},
      reader({
        [ROOM]: [
          { userId: dailyParticipantIdFor('user', USER_ID) },
          { userId: dailyParticipantIdFor('user', OTHER_USER_ID) },
        ],
      })
    );

    expect(mockReconcileMeetingStatus).not.toHaveBeenCalled();
    expect(mockEnqueueRecordingEnsure).toHaveBeenCalledWith({
      meetingId: MEETING_ID,
      trigger: 'sweep',
      dedupeToken: `sweep-${Math.floor(at(20).getTime() / 60_000)}`,
    });
  });

  it('BAL-480 — an empty room does not enqueue recording-ensure (anyOpen === false)', async () => {
    mockListCandidates.mockResolvedValue([meeting({ status: 'in_progress' })]);
    // Both left one minute ago — well under the 5-minute idle-end threshold, so this stays a
    // pure `anyOpen === false` case rather than accidentally exercising termination.
    mockListByMeeting.mockResolvedValue([
      { party: 'expert', joinedAt: START, leftAt: at(19) },
      { party: 'client', joinedAt: at(2), leftAt: at(19) },
    ]);

    await runMeetingLifecycleSweep(at(20), () => {}, EMPTY_READER);

    expect(mockEnqueueRecordingEnsure).not.toHaveBeenCalled();
    // ⚠ THE CHEAP CHECKS COME FIRST — `anyOpen === false` short-circuits before the recordings
    // table is ever read.
    expect(mockFindCapturingForMeeting).not.toHaveBeenCalled();
  });

  it('BAL-480 — a pre-in_progress candidate never reads the recordings table', async () => {
    mockListCandidates.mockResolvedValue([meeting({ status: 'waiting_for_participants' })]);

    await runMeetingLifecycleSweep(at(3), () => {}, EMPTY_READER);

    expect(mockFindCapturingForMeeting).not.toHaveBeenCalled();
  });

  /** ⚠ MC-6 — the ensure must not race the stop the terminal path itself enqueues. */
  it('⚠ BAL-480 — a meeting terminated on this tick does not also enqueue recording-ensure', async () => {
    mockListCandidates.mockResolvedValue([meeting({ status: 'in_progress' })]);
    mockListByMeeting.mockResolvedValue([
      { party: 'expert', joinedAt: START, leftAt: at(30) },
      { party: 'client', joinedAt: at(2), leftAt: at(30) },
    ]);

    await runMeetingLifecycleSweep(at(35), () => {}, EMPTY_READER);

    expect(mockEndMeeting).toHaveBeenCalled();
    expect(mockEnqueueRecordingStop).toHaveBeenCalledWith({ meetingId: MEETING_ID });
    expect(mockEnqueueRecordingEnsure).not.toHaveBeenCalled();
    expect(mockFindCapturingForMeeting).not.toHaveBeenCalled();
  });

  it('BAL-480 — a healthy (Daily-acknowledged) capture suppresses the sweep enqueue', async () => {
    mockListCandidates.mockResolvedValue([meeting({ status: 'in_progress' })]);
    mockListByMeeting.mockResolvedValue([
      { party: 'expert', joinedAt: START, leftAt: null },
      { party: 'client', joinedAt: at(1), leftAt: null },
    ]);
    mockFindCapturingForMeeting.mockResolvedValue({ id: 'rec-1', dailyRecordingId: 'daily-1' });

    await runMeetingLifecycleSweep(at(20), () => {}, EMPTY_READER);

    expect(mockFindCapturingForMeeting).toHaveBeenCalledWith(MEETING_ID);
    expect(mockEnqueueRecordingEnsure).not.toHaveBeenCalled();
  });

  /**
   * ⚠⚠ THE LOAD-BEARING CASE (§10.5). Simplifying the suppression to `capturing !== undefined`
   * would make `handleEnsure`'s stuck-slot reaper permanently unreachable from the sweep,
   * silently — every OTHER test in this file would stay green. This is the one that pins it.
   */
  it('⚠⚠ BAL-480 — an UNACKNOWLEDGED capture is NOT suppressed (the reaper must stay reachable)', async () => {
    mockListCandidates.mockResolvedValue([meeting({ status: 'in_progress' })]);
    mockListByMeeting.mockResolvedValue([
      { party: 'expert', joinedAt: START, leftAt: null },
      { party: 'client', joinedAt: at(1), leftAt: null },
    ]);
    mockFindCapturingForMeeting.mockResolvedValue({ id: 'rec-1', dailyRecordingId: null });

    await runMeetingLifecycleSweep(at(20), () => {}, EMPTY_READER);

    expect(mockEnqueueRecordingEnsure).toHaveBeenCalledWith(
      expect.objectContaining({ meetingId: MEETING_ID, trigger: 'sweep' })
    );
  });

  /**
   * ⚠⚠ BAL-480 FIX ROUND 1 — THE CAP TERM IS WHAT STOPS THE FAN-OUT BUDGET STARVING. A meeting
   * that has exhausted `MAX_DAILY_FAILURES_PER_MEETING` returns from `handleEnsure`'s step 5.5
   * WITHOUT inserting, so it never acquires a capturing row, so the two cheap checks answer
   * `true` for it on EVERY subsequent tick for the rest of its life. `listLifecycleCandidates`
   * orders by status rank first (`in_progress`, then `waiting_for_participants`, then `scheduled`,
   * R6F-15), then `asc(scheduledStart), asc(id)` within each rank — stable — so without this term
   * twenty permanently-capped `in_progress` meetings would occupy the whole per-tick budget
   * forever and no later meeting's self-heal would ever run. Post-outage, that is exactly when the
   * budget must reach the meetings that are still recoverable.
   */
  it('⚠⚠ BAL-480 — a meeting AT the Daily failure cap is not enqueued (no budget starvation)', async () => {
    mockListCandidates.mockResolvedValue([meeting({ status: 'in_progress' })]);
    mockListByMeeting.mockResolvedValue([
      { party: 'expert', joinedAt: START, leftAt: null },
      { party: 'client', joinedAt: at(1), leftAt: null },
    ]);
    mockCountFailedByStage.mockResolvedValue(MOCK_MAX_DAILY_FAILURES);

    await runMeetingLifecycleSweep(at(20), () => {}, EMPTY_READER);

    expect(mockCountFailedByStage).toHaveBeenCalledWith(MEETING_ID, 'daily');
    expect(mockEnqueueRecordingEnsure).not.toHaveBeenCalled();
  });

  it('BAL-480 — one BELOW the cap still enqueues', async () => {
    mockListCandidates.mockResolvedValue([meeting({ status: 'in_progress' })]);
    mockListByMeeting.mockResolvedValue([
      { party: 'expert', joinedAt: START, leftAt: null },
      { party: 'client', joinedAt: at(1), leftAt: null },
    ]);
    mockCountFailedByStage.mockResolvedValue(MOCK_MAX_DAILY_FAILURES - 1);

    await runMeetingLifecycleSweep(at(20), () => {}, EMPTY_READER);

    expect(mockEnqueueRecordingEnsure).toHaveBeenCalledWith(
      expect.objectContaining({ meetingId: MEETING_ID, trigger: 'sweep' })
    );
  });

  /** ⚠ THE COUNT READ IS LAST — a healthy, acknowledged capture never pays for it. */
  it('BAL-480 — a healthy capture short-circuits before the failure count is read', async () => {
    mockListCandidates.mockResolvedValue([meeting({ status: 'in_progress' })]);
    mockListByMeeting.mockResolvedValue([
      { party: 'expert', joinedAt: START, leftAt: null },
      { party: 'client', joinedAt: at(1), leftAt: null },
    ]);
    mockFindCapturingForMeeting.mockResolvedValue({ id: 'rec-1', dailyRecordingId: 'daily-1' });

    await runMeetingLifecycleSweep(at(20), () => {}, EMPTY_READER);

    expect(mockCountFailedByStage).not.toHaveBeenCalled();
  });

  it('⚠ BAL-480 — the fan-out cap defers the excess to later ticks', async () => {
    const total = MAX_RECORDING_ENSURES_PER_SWEEP_TICK + 3;
    mockListCandidates.mockResolvedValue(
      Array.from({ length: total }, (_unused, index) =>
        meeting({ id: `meeting-${index}`, status: 'in_progress' })
      )
    );
    mockListByMeeting.mockResolvedValue([
      { party: 'expert', joinedAt: START, leftAt: null },
      { party: 'client', joinedAt: at(1), leftAt: null },
    ]);

    await runMeetingLifecycleSweep(at(20), () => {}, EMPTY_READER);

    expect(mockEnqueueRecordingEnsure).toHaveBeenCalledTimes(MAX_RECORDING_ENSURES_PER_SWEEP_TICK);
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({ limit: MAX_RECORDING_ENSURES_PER_SWEEP_TICK, deferred: 3 }),
      expect.stringContaining('fan-out cap FILLED')
    );
  });

  it('BAL-480 — a failed recording-ensure enqueue is non-fatal — the sweep tick still succeeds', async () => {
    mockListCandidates.mockResolvedValue([meeting({ status: 'in_progress' })]);
    mockListByMeeting.mockResolvedValue([
      { party: 'expert', joinedAt: START, leftAt: null },
      { party: 'client', joinedAt: at(1), leftAt: null },
    ]);
    mockEnqueueRecordingEnsure.mockRejectedValue(new Error('redis is down'));

    const result = await runMeetingLifecycleSweep(at(20), () => {}, EMPTY_READER);

    expect(result.scanned).toBe(1);
    expect(mockErrorLog).toHaveBeenCalledWith(
      expect.objectContaining({ meetingId: MEETING_ID, error: 'redis is down' }),
      expect.stringContaining('recording-ensure enqueue failed')
    );
  });

  // ── ⚠⚠ THE PER-ROOM FALLBACK (BAL-584) — a room Daily's platform-wide map does not list ──

  const OPEN_ROW = presenceRow();
  const UNMAPPED_ROW = presenceRow({ id: 'row-unmapped', userId: null, party: 'observer' });

  /**
   * ⚠⚠ THE INCIDENT SHAPE. Daily's platform-wide map never lists an EMPTY room, so once nobody is
   * on any Balo call the map is `{}` — exactly when a stale interval needs closing. An empty map
   * therefore proves nothing about any one room, and the per-room read is what confirms it.
   */
  it('⚠⚠ global `{}` + per-room confirmed empty closes the interval THIS tick', async () => {
    mockListCandidates.mockResolvedValue([meeting({ status: 'in_progress' })]);
    mockFindMeetingById.mockResolvedValue(meeting({ status: 'in_progress' }));
    mockListByMeeting.mockResolvedValue([OPEN_ROW]);
    const getRoomPresence = vi.fn().mockResolvedValue([]);

    const result = await runMeetingLifecycleSweep(at(30), () => {}, reader({}, getRoomPresence));

    expect(result.intervalsClosed).toBe(1);
    expect(getRoomPresence).toHaveBeenCalledTimes(1);
    expect(getRoomPresence).toHaveBeenCalledWith(ROOM);
  });

  it.each([
    ['a thrown error', new Error('daily is down')],
    ['a 404', new DailyApiError('GET', `/rooms/${ROOM}/presence`, 404, 'not found')],
    [
      'a contract violation',
      new DailyApiError('GET', `/rooms/${ROOM}/presence`, 0, 'body cannot be trusted'),
    ],
  ])(
    '⚠⚠ a per-room read that fails (%s) is UNKNOWN — nothing closes, it warns, and a terminal rule still fires',
    async (_label, failure) => {
      mockListCandidates.mockResolvedValue([meeting({ status: 'in_progress' })]);
      mockFindMeetingById.mockResolvedValue(meeting({ status: 'in_progress' }));
      mockListByMeeting.mockResolvedValue([
        presenceRow({ id: 'row-0', userId: OTHER_USER_ID, party: 'expert' }),
        OPEN_ROW,
      ]);
      mockEndMeeting.mockResolvedValue({
        meeting: meeting({ status: 'ended' }),
        closedIntervals: 2,
      });

      // Past the overrun ceiling, so rule 6 fires on the unknown roster.
      const result = await runMeetingLifecycleSweep(
        at(270),
        () => {},
        reader({}, vi.fn().mockRejectedValue(failure))
      );

      expect(result.intervalsClosed).toBe(0);
      expect(mockApplyPresenceEffect).not.toHaveBeenCalled();
      expect(mockWarn).toHaveBeenCalledWith(
        expect.objectContaining({ meetingId: MEETING_ID, roomName: ROOM, error: failure.message }),
        expect.stringContaining('per-room presence read failed')
      );
      expect(result.terminated).toBe(1);
      expect(mockTrackServer).toHaveBeenCalledWith(
        'meeting_overrun_stopped',
        expect.objectContaining({ room_occupancy: 'unknown' })
      );
    }
  );

  describe('no per-room read is made when it cannot matter', () => {
    it.each([
      ['the room is listed in the platform-wide map', { [ROOM]: [{ userId: 'someone' }] }],
      ['the room is listed in the platform-wide map as EMPTY', { [ROOM]: [] }],
    ])('%s', async (_label, rooms) => {
      mockListCandidates.mockResolvedValue([meeting({ status: 'in_progress' })]);
      mockListByMeeting.mockResolvedValue([OPEN_ROW]);
      const getRoomPresence = vi.fn();

      await runMeetingLifecycleSweep(at(30), () => {}, reader(rooms, getRoomPresence));

      expect(getRoomPresence).not.toHaveBeenCalled();
    });

    it('the platform-wide read FAILED — every roster is unknown, so no fan-out', async () => {
      mockListCandidates.mockResolvedValue([meeting({ status: 'in_progress' })]);
      mockListByMeeting.mockResolvedValue([OPEN_ROW]);
      const getRoomPresence = vi.fn();

      await runMeetingLifecycleSweep(at(30), () => {}, {
        getAllPresence: async () => {
          throw new Error('daily is down');
        },
        getRoomPresence,
      });

      expect(getRoomPresence).not.toHaveBeenCalled();
    });

    it('the candidate holds NOTHING open — there is nothing to close', async () => {
      mockListCandidates.mockResolvedValue([meeting({ status: 'in_progress' })]);
      mockListByMeeting.mockResolvedValue([]);
      const getRoomPresence = vi.fn();

      await runMeetingLifecycleSweep(at(30), () => {}, reader({}, getRoomPresence));

      expect(getRoomPresence).not.toHaveBeenCalled();
    });

    it('⚠ the stamped room name disagrees with the derived one — UNKNOWN, nothing closes, and it warns', async () => {
      const foreignRoom = 'balo-someone-elses-room';
      mockListCandidates.mockResolvedValue([
        meeting({ status: 'in_progress', dailyRoomName: foreignRoom }),
      ]);
      mockListByMeeting.mockResolvedValue([OPEN_ROW]);
      const getRoomPresence = vi.fn().mockResolvedValue([]);

      const result = await runMeetingLifecycleSweep(at(30), () => {}, reader({}, getRoomPresence));

      expect(getRoomPresence).not.toHaveBeenCalled();
      expect(result.intervalsClosed).toBe(0);
      expect(mockApplyPresenceEffect).not.toHaveBeenCalled();
      expect(mockWarn).toHaveBeenCalledWith(
        { meetingId: MEETING_ID, roomName: foreignRoom },
        expect.stringContaining('disagrees with the derived one')
      );
    });

    it('the meeting has no room name', async () => {
      mockListCandidates.mockResolvedValue([
        meeting({ status: 'in_progress', dailyRoomName: null, joinUrl: null }),
      ]);
      mockListByMeeting.mockResolvedValue([OPEN_ROW]);
      const getRoomPresence = vi.fn();

      await runMeetingLifecycleSweep(at(30), () => {}, reader({}, getRoomPresence));

      expect(getRoomPresence).not.toHaveBeenCalled();
    });
  });

  /**
   * ⚠ A ROOM LISTED IN THE PLATFORM-WIDE MAP, EVEN AS `[]`, IS A CONFIRMED ANSWER for that room:
   * it reconciles from the map, with no per-room read.
   */
  it('⚠ a room the vendor lists as EMPTY still reconciles — that is a confirmed answer', async () => {
    mockListCandidates.mockResolvedValue([meeting({ status: 'in_progress' })]);
    mockFindMeetingById.mockResolvedValue(meeting({ status: 'in_progress' }));
    mockListByMeeting.mockResolvedValue([OPEN_ROW]);

    const result = await runMeetingLifecycleSweep(at(30), () => {}, reader({ [ROOM]: [] }));

    expect(result.intervalsClosed).toBe(1);
  });

  /**
   * ⚠⚠ THE WORST BUG THIS FILE GUARDS. A Daily outage, a `429`, or an un-provisioned meeting all
   * yield NO roster — and treating that as "the room is empty" would close EVERY open interval
   * on EVERY live meeting in one tick, truncating every billable span at once. `null` means
   * UNKNOWN; reconciliation is SKIPPED, and the terminal rules still run.
   */
  it('⚠⚠ a VENDOR FAILURE skips reconciliation entirely — it never reads as "the room is empty"', async () => {
    mockListCandidates.mockResolvedValue([meeting({ status: 'in_progress' })]);
    mockListByMeeting.mockResolvedValue([OPEN_ROW]);

    const getRoomPresence = vi.fn();
    const result = await runMeetingLifecycleSweep(at(30), () => {}, {
      getAllPresence: async () => {
        throw new Error('daily is down');
      },
      getRoomPresence,
    });

    expect(result.intervalsClosed).toBe(0);
    expect(mockApplyPresenceEffect).not.toHaveBeenCalled();
    // ⚠ AN OUTAGE NEVER FANS OUT INTO PER-ROOM READS.
    expect(getRoomPresence).not.toHaveBeenCalled();
    expect(mockErrorLog).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'daily is down' }),
      expect.stringContaining('skipping reconciliation')
    );
  });

  /**
   * ⚠ AN INTERVAL WITH NO IDENTITY CANNOT BE RECONCILED AGAINST A ROSTER — there is nothing to
   * match. It is `observer` by construction, so it bills nothing either way, and closing it on
   * a guess would be worse than leaving it. A room LISTED in the platform-wide map (even as
   * `[]`) is not a confirmed-empty read.
   */
  it('⚠ leaves an UNMAPPED interval (both identity columns null) alone when the room is listed in the GLOBAL map, even as `[]`', async () => {
    mockListCandidates.mockResolvedValue([meeting({ status: 'in_progress' })]);
    mockListByMeeting.mockResolvedValue([UNMAPPED_ROW]);

    const result = await runMeetingLifecycleSweep(at(30), () => {}, reader({ [ROOM]: [] }));

    expect(result.intervalsClosed).toBe(0);
    expect(mockApplyPresenceEffect).not.toHaveBeenCalled();
  });

  it('⚠ a validated-empty per-room read closes an UNMAPPED interval — nobody is in the room to be it', async () => {
    mockListCandidates.mockResolvedValue([meeting({ status: 'in_progress' })]);
    mockFindMeetingById.mockResolvedValue(meeting({ status: 'in_progress' }));
    mockListByMeeting.mockResolvedValue([UNMAPPED_ROW]);

    const result = await runMeetingLifecycleSweep(
      at(30),
      () => {},
      reader({}, vi.fn().mockResolvedValue([]))
    );

    expect(result.intervalsClosed).toBe(1);
    expect(mockClosePresenceEffectForRow).toHaveBeenCalledWith(
      expect.objectContaining({ id: MEETING_ID }),
      UNMAPPED_ROW,
      at(30)
    );
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({ participantId: null }),
      expect.stringContaining('dropped webhook')
    );
  });

  /** ⚠ AN ID-LESS PARTICIPANT STILL MAKES THE ROOM OCCUPIED — `vendorCount` is the RAW count. */
  it('⚠ a per-room read with one id-less participant never closes an UNMAPPED interval', async () => {
    mockListCandidates.mockResolvedValue([meeting({ status: 'in_progress' })]);
    mockListByMeeting.mockResolvedValue([UNMAPPED_ROW]);

    const result = await runMeetingLifecycleSweep(
      at(30),
      () => {},
      reader({}, vi.fn().mockResolvedValue([{}]))
    );

    expect(result.intervalsClosed).toBe(0);
    expect(mockApplyPresenceEffect).not.toHaveBeenCalled();
  });

  // ── PASS 2 — THE FIVE TERMINAL RULES ────────────────────────────────────────────────────

  const TERMINAL_ROWS: ReadonlyArray<{
    label: string;
    rule: string;
    status: string;
    intervals: Array<{ party: string; joinedAt: Date; leftAt: Date | null }>;
    nowMinutes: number;
    outcome: string | null;
    event?: string;
    /** BAL-581 — venue-field overrides merged onto the venue-complete default. */
    meeting?: Record<string, unknown>;
    /** BAL-581 — when set, the event assertion is EXACT rather than `expect.anything()`. */
    eventPayload?: Record<string, unknown>;
  }> = [
    {
      label: 'IDLE END — completed',
      rule: 'idle_end',
      status: 'in_progress',
      intervals: [
        { party: 'expert', joinedAt: START, leftAt: at(30) },
        { party: 'client', joinedAt: at(2), leftAt: at(30) },
      ],
      nowMinutes: 35,
      outcome: 'completed',
    },
    {
      label: 'NO-SHOW — no_show_client',
      rule: 'no_show',
      status: 'waiting_for_participants',
      intervals: [{ party: 'expert', joinedAt: START, leftAt: null }],
      nowMinutes: 15,
      outcome: 'no_show_client',
    },
    {
      label: 'MISSED CALL — missed_call + its own event',
      rule: 'missed_call',
      status: 'scheduled',
      intervals: [],
      nowMinutes: 10,
      outcome: 'missed_call',
      event: 'meeting_missed_call',
    },
    {
      label: 'ABANDONED WAIT (D9) — NULL outcome + its own event',
      rule: 'abandoned_wait',
      status: 'waiting_for_participants',
      intervals: [{ party: 'expert', joinedAt: START, leftAt: at(8) }],
      nowMinutes: 13,
      outcome: null,
      event: 'meeting_waiting_abandoned',
    },
    {
      label: 'VENUE UNAVAILABLE (BAL-581) — venue_unavailable + its own event',
      rule: 'venue_unavailable',
      status: 'scheduled',
      intervals: [],
      nowMinutes: 10,
      outcome: 'venue_unavailable',
      event: 'meeting_venue_unavailable',
      meeting: { dailyRoomName: null, joinUrl: null, venueProvisionedAt: null },
      eventPayload: { meeting_id: MEETING_ID, room_name_stamped: false, distinct_id: MEETING_ID },
    },
    {
      label: 'VENUE UNAVAILABLE (BAL-581) — a MISMATCHED stamped name still counts as stamped',
      rule: 'venue_unavailable',
      status: 'scheduled',
      intervals: [],
      nowMinutes: 10,
      outcome: 'venue_unavailable',
      event: 'meeting_venue_unavailable',
      meeting: {
        dailyRoomName: 'balo-ffffffffffffffffffffffffffffffff',
        joinUrl: 'https://balo.daily.co/balo-ffffffffffffffffffffffffffffffff',
        venueProvisionedAt: at(-1440),
      },
      eventPayload: { meeting_id: MEETING_ID, room_name_stamped: true, distinct_id: MEETING_ID },
    },
  ];

  it.each(TERMINAL_ROWS)('$label', async (rowSpec) => {
    const candidate = meeting({ status: rowSpec.status, ...rowSpec.meeting });
    mockListCandidates.mockResolvedValue([candidate]);
    mockListByMeeting.mockResolvedValue(rowSpec.intervals);
    if (rowSpec.meeting !== undefined) {
      // ⚠ BAL-581 — the stale-snapshot re-read (`findById`) and the CAS RETURNING row
      // must agree with the CANDIDATE's own venue facts, or the `venue_unavailable` guard sees
      // the default (venue-ready) fixture on its re-check and the termination never confirms.
      mockFindMeetingById.mockResolvedValue(candidate);
      mockEndMeeting.mockResolvedValue({
        meeting: { ...candidate, status: 'ended' },
        closedIntervals: 0,
      });
    }

    const result = await runMeetingLifecycleSweep(at(rowSpec.nowMinutes), () => {}, EMPTY_READER);

    expect(result.terminated).toBe(1);
    expect(mockEndMeeting).toHaveBeenCalledWith({
      id: MEETING_ID,
      outcome: rowSpec.outcome,
      // ⚠ ALL SIX SYSTEM RULES REPORT `system_idle`. `ended_by` answers "person or system?";
      // WHICH rule fired is answered by `outcome` plus the audit row's `terminalRule`.
      endedBy: 'system_idle',
      endedAt: at(rowSpec.nowMinutes),
      terminalRule: { rule: rowSpec.rule, arm: null },
      // ⚠ NULL ACTOR — the ADR-1030 system-actor exemption. Never a fabricated actor.
      actorUserId: null,
    });
    if (rowSpec.eventPayload !== undefined && rowSpec.event !== undefined) {
      expect(mockTrackServer).toHaveBeenCalledWith(rowSpec.event, rowSpec.eventPayload);
    } else if (rowSpec.event !== undefined) {
      expect(mockTrackServer).toHaveBeenCalledWith(rowSpec.event, expect.anything());
    }
  });

  /**
   * BAL-581 — a late-repaired venue is NOT `venue_unavailable`, even past the missed-call
   * threshold measured from `scheduledStart`: the anchor moves to when the room became ready.
   */
  it('⚠ a room ready AFTER the start is not terminated until the missed-call window from ITS OWN anchor', async () => {
    mockListCandidates.mockResolvedValue([
      meeting({ status: 'scheduled', venueProvisionedAt: at(8) }),
    ]);

    const notYet = await runMeetingLifecycleSweep(at(10), () => {}, EMPTY_READER);
    expect(notYet.terminated).toBe(0);

    mockListCandidates.mockResolvedValue([
      meeting({ status: 'scheduled', venueProvisionedAt: at(8) }),
    ]);
    const now = await runMeetingLifecycleSweep(at(18), () => {}, EMPTY_READER);
    expect(now.terminated).toBe(1);
    expect(mockEndMeeting).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'missed_call' })
    );
  });

  // ── BAL-581 — STALE-SNAPSHOT RE-READ BEFORE A `venue_unavailable` END ───────────────────

  it('a repair that lands after the batch read aborts the venue_unavailable termination', async () => {
    mockListCandidates.mockResolvedValue([
      meeting({
        status: 'scheduled',
        dailyRoomName: null,
        joinUrl: null,
        venueProvisionedAt: null,
      }),
    ]);
    // The repair's `setVenue` landed between the batch read and this candidate's processing.
    mockFindMeetingById.mockResolvedValue(
      meeting({ status: 'scheduled', venueProvisionedAt: at(9) })
    );

    const result = await runMeetingLifecycleSweep(at(10), () => {}, EMPTY_READER);

    expect(result.terminated).toBe(0);
    expect(mockEndMeeting).not.toHaveBeenCalled();
  });

  it('tears down the room from the CAS RETURNING row, never the stale null snapshot', async () => {
    mockListCandidates.mockResolvedValue([
      meeting({
        status: 'scheduled',
        dailyRoomName: null,
        joinUrl: null,
        venueProvisionedAt: null,
      }),
    ]);
    // The re-read still confirms venue_unavailable…
    mockFindMeetingById.mockResolvedValue(
      meeting({ status: 'scheduled', dailyRoomName: null, joinUrl: null, venueProvisionedAt: null })
    );
    // …but the RETURNING row the CAS write actually produced carries a real room.
    mockEndMeeting.mockResolvedValue({
      meeting: meeting({ status: 'ended', dailyRoomName: ROOM }),
      closedIntervals: 0,
    });

    const result = await runMeetingLifecycleSweep(at(10), () => {}, EMPTY_READER);

    expect(result.terminated).toBe(1);
    expect(mockDeleteRoom).toHaveBeenCalledWith(ROOM);
  });

  it('emits the universal `meeting_ended` on every terminal path', async () => {
    mockListCandidates.mockResolvedValue([meeting({ status: 'scheduled' })]);

    await runMeetingLifecycleSweep(at(10), () => {}, EMPTY_READER);

    expect(mockEmitMeetingEnded).toHaveBeenCalledWith(
      expect.objectContaining({ endedBy: 'system_idle', actorUserId: null })
    );
  });

  it('tears the Daily room down after a system termination', async () => {
    mockListCandidates.mockResolvedValue([meeting({ status: 'scheduled' })]);

    await runMeetingLifecycleSweep(at(10), () => {}, EMPTY_READER);

    expect(mockDeleteRoom).toHaveBeenCalledWith(ROOM);
  });

  /**
   * BAL-473 (§5.2, ARCHITECT AMENDMENT to OD-2) — a system terminal rule enqueues
   * `recording-stop` too, BEFORE `tearDownRoom`, same as the human `end-meeting.ts` path. Every
   * OTHER terminal rule than `idle_end` never had a recording capturing, so the job no-ops for
   * free on those — this call is unconditional and costs nothing.
   */
  it('⚠ enqueues recording-stop BEFORE tearing the Daily room down', async () => {
    mockListCandidates.mockResolvedValue([meeting({ status: 'scheduled' })]);
    const order: string[] = [];
    mockEnqueueRecordingStop.mockImplementation(async () => {
      order.push('enqueueRecordingStop');
    });
    mockDeleteRoom.mockImplementation(async () => {
      order.push('deleteRoom');
      return 'deleted';
    });

    await runMeetingLifecycleSweep(at(10), () => {}, EMPTY_READER);

    expect(mockEnqueueRecordingStop).toHaveBeenCalledWith({ meetingId: MEETING_ID });
    expect(order).toEqual(['enqueueRecordingStop', 'deleteRoom']);
  });

  it('the recording-stop enqueue failing is non-fatal — the meeting stays terminated', async () => {
    mockListCandidates.mockResolvedValue([meeting({ status: 'scheduled' })]);
    mockEnqueueRecordingStop.mockRejectedValue(new Error('redis is down'));

    const result = await runMeetingLifecycleSweep(at(10), () => {}, EMPTY_READER);

    expect(result.terminated).toBe(1);
    expect(mockErrorLog).toHaveBeenCalled();
    // Teardown still runs — the fault is contained to the enqueue.
    expect(mockDeleteRoom).toHaveBeenCalledWith(ROOM);
  });

  /**
   * ⚠⚠ THE DERIVED-NAME CROSS-CHECK — the same guard `resolveVenue` applies on the JOIN path,
   * and it matters MORE here because this call is DESTRUCTIVE and irreversible. The room name is
   * a pure function of `meetings.id`, so a stamped name that disagrees points at SOMEBODY ELSE'S
   * ROOM and deleting it would drop a call that is running.
   */
  it('⚠⚠ REFUSES to delete a room whose stamped name disagrees with the derived one', async () => {
    mockListCandidates.mockResolvedValue([meeting({ status: 'scheduled' })]);
    // ⚠ Teardown reads the CAS RETURNING row, so THIS is the row whose name must disagree to
    // exercise the guard; the candidate itself stays venue-ready so the decision is still
    // `missed_call` (a mismatched CANDIDATE name would instead read as venue-not-ready and fire
    // `venue_unavailable`, which is a different test below).
    mockEndMeeting.mockResolvedValue({
      meeting: meeting({
        status: 'ended',
        dailyRoomName: 'balo-ffffffffffffffffffffffffffffffff',
      }),
      closedIntervals: 0,
    });

    const result = await runMeetingLifecycleSweep(at(10), () => {}, EMPTY_READER);

    expect(result.terminated).toBe(1);
    expect(mockDeleteRoom).not.toHaveBeenCalled();
    expect(mockErrorLog).toHaveBeenCalledWith(
      expect.objectContaining({ meetingId: MEETING_ID, stamped: expect.any(String) }),
      expect.stringContaining('REFUSING to delete')
    );
  });

  it('a teardown failure is non-fatal — the meeting stays ended', async () => {
    mockListCandidates.mockResolvedValue([meeting({ status: 'scheduled' })]);
    mockDeleteRoom.mockRejectedValue(new Error('daily 429'));

    const result = await runMeetingLifecycleSweep(at(10), () => {}, EMPTY_READER);

    expect(result.terminated).toBe(1);
    expect(mockErrorLog).toHaveBeenCalled();
  });

  it('a lost CAS race (somebody pressed End) counts as NOT terminated, and is not an error', async () => {
    mockListCandidates.mockResolvedValue([meeting({ status: 'scheduled' })]);
    mockEndMeeting.mockResolvedValue(undefined);

    const result = await runMeetingLifecycleSweep(at(10), () => {}, EMPTY_READER);

    expect(result.terminated).toBe(0);
    expect(mockEmitMeetingEnded).not.toHaveBeenCalled();
    expect(mockDeleteRoom).not.toHaveBeenCalled();
  });

  it('a HEALTHY live meeting matches no rule and is left alone', async () => {
    mockListCandidates.mockResolvedValue([meeting({ status: 'in_progress' })]);
    mockListByMeeting.mockResolvedValue([
      { party: 'expert', joinedAt: START, leftAt: null },
      { party: 'client', joinedAt: at(1), leftAt: null },
    ]);

    const result = await runMeetingLifecycleSweep(at(20), () => {}, EMPTY_READER);

    expect(result.terminated).toBe(0);
    expect(mockEndMeeting).not.toHaveBeenCalled();
  });

  /**
   * ⚠ D12 — a `waiting_for_participants` meeting rescheduled INTO THE FUTURE must match NOTHING.
   * Without the wall-clock preconditions, an expert with an open interval across the move would
   * have `expertPresentMs` grow to `now` and trip the no-show on a call that has not happened.
   */
  it('⚠ D12 — a meeting rescheduled into the FUTURE is inert', async () => {
    mockListCandidates.mockResolvedValue([
      meeting({ status: 'waiting_for_participants', scheduledStart: at(24 * 60) }),
    ]);
    mockListByMeeting.mockResolvedValue([{ party: 'expert', joinedAt: START, leftAt: null }]);

    const result = await runMeetingLifecycleSweep(at(30), () => {}, EMPTY_READER);

    expect(result.terminated).toBe(0);
  });

  // ── PASS 3 — ARMING ─────────────────────────────────────────────────────────────────────

  it('arms the OPS alert when the expert has never joined', async () => {
    mockListCandidates.mockResolvedValue([meeting({ status: 'scheduled' })]);

    await runMeetingLifecycleSweep(at(3), () => {}, EMPTY_READER);

    expect(mockScheduleExpertAbsent).toHaveBeenCalledWith({
      meetingId: MEETING_ID,
      scheduledStart: START,
      // ⚠ BAL-581 — the venue is ready before the start on this (default) fixture, so the
      // anchor equals `scheduledStart` and old behaviour is exactly preserved.
      absenceAnchor: START,
      contextType: 'case',
      timers: DEFAULT_MEETING_TIMERS,
    });
    expect(mockScheduleClientAbsent).not.toHaveBeenCalled();
  });

  /**
   * BAL-581 — the ops alert says "the EXPERT has not joined". With no room nobody COULD join,
   * so arming here would page ops to chase an expert who was locked out too; that meeting is
   * the `meeting.unprovisioned` admin alert's.
   */
  it('⚠ BAL-581 — arms NOTHING for a meeting whose venue was never provisioned', async () => {
    mockListCandidates.mockResolvedValue([
      meeting({
        status: 'scheduled',
        dailyRoomName: null,
        joinUrl: null,
        venueProvisionedAt: null,
      }),
    ]);

    await runMeetingLifecycleSweep(at(6), () => {}, EMPTY_READER);

    expect(mockScheduleExpertAbsent).not.toHaveBeenCalled();
  });

  /** BAL-581 — the anchor is `venueAbsenceAnchor`, never bare `scheduledStart`. */
  it('⚠ BAL-581 — arms NOTHING before a LATE-ready venue existed', async () => {
    mockListCandidates.mockResolvedValue([
      meeting({ status: 'scheduled', venueProvisionedAt: at(3) }),
    ]);

    await runMeetingLifecycleSweep(at(2), () => {}, EMPTY_READER);

    expect(mockScheduleExpertAbsent).not.toHaveBeenCalled();
  });

  it('⚠ BAL-581 — arms the ops alert the instant a LATE venue becomes ready, anchored there', async () => {
    mockListCandidates.mockResolvedValue([
      meeting({ status: 'scheduled', venueProvisionedAt: at(3) }),
    ]);

    await runMeetingLifecycleSweep(at(3), () => {}, EMPTY_READER);

    expect(mockScheduleExpertAbsent).toHaveBeenCalledWith(
      expect.objectContaining({ absenceAnchor: at(3) })
    );
  });

  it('arms the CLIENT nudge when the expert is holding the room alone', async () => {
    mockListCandidates.mockResolvedValue([meeting()]);
    mockListByMeeting.mockResolvedValue([{ party: 'expert', joinedAt: at(5), leftAt: null }]);

    await runMeetingLifecycleSweep(at(6), () => {}, EMPTY_READER);

    expect(mockScheduleClientAbsent).toHaveBeenCalledWith(
      expect.objectContaining({
        meetingId: MEETING_ID,
        companyId: 'company-1',
        // ⚠ THE EXPERT-PRESENT CLOCK START, not the scheduled start.
        clockStart: at(5),
      })
    );
    expect(mockScheduleExpertAbsent).not.toHaveBeenCalled();
  });

  /**
   * ⚠⚠ THE WAITING PARTY IS RESOLVED HERE, AT THE ONLY PRODUCER. It was hard-coded `null` with a
   * comment claiming the template resolved a fallback — `meeting-absence-emails.tsx` resolves
   * NOTHING — so EVERY client nudge shipped party-neutral copy while four tests asserted a
   * capability nothing could reach. Prospective copy names the PARTY (CLAUDE.md): the expert's
   * agency, or an independent expert's own name.
   */
  it('⚠⚠ names the WAITING PARTY on the nudge, resolved from the meeting’s own expert', async () => {
    mockListCandidates.mockResolvedValue([meeting()]);
    mockListByMeeting.mockResolvedValue([{ party: 'expert', joinedAt: at(5), leftAt: null }]);

    await runMeetingLifecycleSweep(at(6), () => {}, EMPTY_READER);

    expect(mockDeliveringPartyName).toHaveBeenCalledWith('expert-1');
    expect(mockScheduleClientAbsent).toHaveBeenCalledWith(
      expect.objectContaining({ waitingPartyName: 'CloudPeak' })
    );
  });

  it('⚠ falls back to a NULL party name rather than inventing one', async () => {
    mockListCandidates.mockResolvedValue([meeting()]);
    mockListByMeeting.mockResolvedValue([{ party: 'expert', joinedAt: at(5), leftAt: null }]);
    mockDeliveringPartyName.mockResolvedValue(null);

    await runMeetingLifecycleSweep(at(6), () => {}, EMPTY_READER);

    expect(mockScheduleClientAbsent).toHaveBeenCalledWith(
      expect.objectContaining({ waitingPartyName: null })
    );
  });

  it('arms NOTHING before the scheduled start', async () => {
    mockListCandidates.mockResolvedValue([meeting({ status: 'scheduled' })]);

    await runMeetingLifecycleSweep(at(-1), () => {}, EMPTY_READER);

    expect(mockScheduleExpertAbsent).not.toHaveBeenCalled();
    expect(mockScheduleClientAbsent).not.toHaveBeenCalled();
  });

  it('arms NOTHING for a meeting it just terminated', async () => {
    mockListCandidates.mockResolvedValue([meeting({ status: 'scheduled' })]);

    await runMeetingLifecycleSweep(at(10), () => {}, EMPTY_READER);

    expect(mockScheduleExpertAbsent).not.toHaveBeenCalled();
  });

  it('skips the client nudge when the owning party cannot be resolved', async () => {
    mockListCandidates.mockResolvedValue([meeting()]);
    mockListByMeeting.mockResolvedValue([{ party: 'expert', joinedAt: START, leftAt: null }]);
    mockResolveOwner.mockResolvedValue(undefined);

    await runMeetingLifecycleSweep(at(6), () => {}, EMPTY_READER);

    expect(mockScheduleClientAbsent).not.toHaveBeenCalled();
  });

  // ── PER-ROW ISOLATION ───────────────────────────────────────────────────────────────────

  /**
   * ⚠ ONE BAD ROW MUST NEVER ABORT THE BATCH. A per-minute money sweep that stops at the first
   * failure would leave every later meeting unmetered for as long as the bad row persists.
   */
  it('⚠ one failing candidate does NOT abort the batch', async () => {
    // ⚠ BAL-581 — `dailyRoomName`/`joinUrl` MUST be re-derived per id: the shared `ROOM` constant
    // is `dailyRoomNameForMeeting(MEETING_ID)` only, so overriding just `id` would make BOTH rows
    // read as venue-NOT-READY (a name mismatch) and fire `venue_unavailable` instead of the
    // `missed_call` this test means to isolate.
    mockListCandidates.mockResolvedValue([
      meeting({
        id: 'bad',
        status: 'scheduled',
        dailyRoomName: dailyRoomNameForMeeting('bad'),
        joinUrl: `https://balo.daily.co/${dailyRoomNameForMeeting('bad')}`,
      }),
      meeting({
        id: 'good',
        status: 'scheduled',
        dailyRoomName: dailyRoomNameForMeeting('good'),
        joinUrl: `https://balo.daily.co/${dailyRoomNameForMeeting('good')}`,
      }),
    ]);
    mockListByMeeting.mockImplementation(async (id: string) => {
      if (id === 'bad') throw new Error('read failed');
      return [];
    });

    const result = await runMeetingLifecycleSweep(at(10), () => {}, EMPTY_READER);

    expect(result.scanned).toBe(2);
    expect(result.terminated).toBe(1);
    expect(mockErrorLog).toHaveBeenCalledWith(
      expect.objectContaining({ meetingId: 'bad' }),
      'Meeting lifecycle sweep failed'
    );
  });

  // ── BAL-412 — PRESENCE SETTLEMENT, BEST-EFFORT AND NON-FATAL ────────────────────────────

  it('settles the terminated meeting with the system-actor exemption (actorUserId: null)', async () => {
    mockListCandidates.mockResolvedValue([meeting({ status: 'in_progress' })]);
    mockListByMeeting.mockResolvedValue([
      { party: 'expert', joinedAt: START, leftAt: at(30) },
      { party: 'client', joinedAt: at(2), leftAt: at(30) },
    ]);

    const result = await runMeetingLifecycleSweep(at(35), () => {}, EMPTY_READER);

    expect(result.terminated).toBe(1);
    expect(mockSettleSessionlessCaseMeeting).toHaveBeenCalledWith({
      meetingId: MEETING_ID,
      trigger: 'lifecycle_sweep',
      actorUserId: null,
      now: at(35),
    });
  });

  // BAL-474 (D5.3) — every terminal rule (idle end, no-show, missed call, abandoned wait and
  // BAL-581's venue unavailable) reaches the same call: the service decides from the shape whether
  // anything is owed. The rows are the five terminal rules' own arrangements (`TERMINAL_ROWS`), so a
  // rule added or changed there is covered here too.
  it.each(TERMINAL_ROWS)(
    '⚠ the $label rule settles through the sessionless service (keyed on the presence shape, not the rule)',
    async (rowSpec) => {
      const candidate = meeting({ status: rowSpec.status, ...rowSpec.meeting });
      mockListCandidates.mockResolvedValue([candidate]);
      mockListByMeeting.mockResolvedValue(rowSpec.intervals);
      if (rowSpec.meeting !== undefined) {
        // The venue rule re-reads the row before ending it; the re-read and the CAS row must carry
        // the candidate's own venue facts (see the `TERMINAL_ROWS` test above).
        mockFindMeetingById.mockResolvedValue(candidate);
        mockEndMeeting.mockResolvedValue({
          meeting: { ...candidate, status: 'ended' },
          closedIntervals: 0,
        });
      }

      const result = await runMeetingLifecycleSweep(at(rowSpec.nowMinutes), () => {}, EMPTY_READER);

      expect(result.terminated).toBe(1);
      expect(mockSettleSessionlessCaseMeeting).toHaveBeenCalledTimes(1);
      expect(mockSettleSessionlessCaseMeeting).toHaveBeenCalledWith({
        meetingId: MEETING_ID,
        trigger: 'lifecycle_sweep',
        actorUserId: null,
        now: at(rowSpec.nowMinutes),
      });
    }
  );

  it('⚠ a SETTLEMENT FAILURE does not abort the sweep tick — logs at error and continues', async () => {
    mockListCandidates.mockResolvedValue([
      meeting({ status: 'in_progress' }),
      meeting({ id: 'good', status: 'in_progress' }),
    ]);
    mockListByMeeting.mockResolvedValue([
      { party: 'expert', joinedAt: START, leftAt: at(30) },
      { party: 'client', joinedAt: at(2), leftAt: at(30) },
    ]);
    mockSettleSessionlessCaseMeeting.mockRejectedValueOnce(new Error('settlement boom'));

    const result = await runMeetingLifecycleSweep(at(35), () => {}, EMPTY_READER);

    expect(result.terminated).toBe(2);
    expect(mockErrorLog).toHaveBeenCalledWith(
      expect.objectContaining({ meetingId: MEETING_ID }),
      expect.stringContaining('Presence settlement failed')
    );
  });

  it('does not call settlement for a meeting the sweep merely armed (no terminal rule fired)', async () => {
    mockListCandidates.mockResolvedValue([meeting()]);
    mockListByMeeting.mockResolvedValue([{ party: 'expert', joinedAt: at(5), leftAt: null }]);

    await runMeetingLifecycleSweep(at(6), () => {}, EMPTY_READER);

    expect(mockSettleSessionlessCaseMeeting).not.toHaveBeenCalled();
  });

  it('BAL-466 — a candidate whose meeting has a presence session settles, actorUserId: null', async () => {
    mockListCandidates.mockResolvedValue([meeting({ status: 'in_progress' })]);
    mockListByMeeting.mockResolvedValue([
      { party: 'expert', joinedAt: START, leftAt: at(30) },
      { party: 'client', joinedAt: at(2), leftAt: at(30) },
    ]);
    mockSettleSessionlessCaseMeeting.mockResolvedValue({
      kind: 'settled_existing_session',
      outcome: { ok: true, settlement: { shape: 'held' }, result: {} },
    });

    const result = await runMeetingLifecycleSweep(at(35), () => {}, EMPTY_READER);

    expect(result.terminated).toBe(1);
    expect(mockSettleSessionlessCaseMeeting).toHaveBeenCalledWith({
      meetingId: MEETING_ID,
      trigger: 'lifecycle_sweep',
      actorUserId: null,
      now: at(35),
    });
  });

  it('⚠ a non-`no_meeting` DECLINE logs a warning rather than throwing — the sweep tick still succeeds', async () => {
    mockListCandidates.mockResolvedValue([meeting({ status: 'in_progress' })]);
    mockListByMeeting.mockResolvedValue([
      { party: 'expert', joinedAt: START, leftAt: at(30) },
      { party: 'client', joinedAt: at(2), leftAt: at(30) },
    ]);
    mockSettleSessionlessCaseMeeting.mockResolvedValue({
      kind: 'settled_existing_session',
      outcome: { ok: false, code: 'already_settled' },
    });

    const result = await runMeetingLifecycleSweep(at(35), () => {}, EMPTY_READER);

    expect(result.terminated).toBe(1);
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({ meetingId: MEETING_ID, code: 'already_settled' }),
      expect.stringContaining('Presence settlement declined')
    );
  });

  it.each(['released_closed_case_no_show', 'released_expert_invited_guest_only'])(
    '⚠ BAL-474 — `%s` is TERMINAL on the sweep too: an info line, never a "backstop will retry" warn',
    async (code) => {
      mockListCandidates.mockResolvedValue([meeting({ status: 'waiting_for_participants' })]);
      mockListByMeeting.mockResolvedValue([{ party: 'expert', joinedAt: START, leftAt: null }]);
      mockSettleSessionlessCaseMeeting.mockResolvedValue({
        kind: 'settled_existing_session',
        outcome: { ok: false, code },
      });

      const swept = await runMeetingLifecycleSweep(at(15), () => {}, EMPTY_READER);

      expect(swept.terminated).toBe(1);
      expect(mockInfo).toHaveBeenCalledWith(
        expect.objectContaining({ meetingId: MEETING_ID, code }),
        expect.stringContaining('released on the lifecycle sweep')
      );
      expect(mockWarn).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining('Presence settlement declined')
      );
    }
  );

  it.each([
    [
      { kind: 'deferred', reason: 'session_in_progress', outcome: 'no_show_client' },
      'settlement deferred on the lifecycle sweep — the meter sweep sessionless-meeting backstop retries it',
    ],
    [
      { kind: 'refused', reason: 'booker_unattributable' },
      'settlement refused on the lifecycle sweep — permanent: the meeting is marked and the refusal alarmed, and nothing retries it',
    ],
  ])(
    'a %j sessionless result logs its OWN warn (a deferral is retried, a refusal never is) — the sweep tick still succeeds',
    async (result, message) => {
      mockListCandidates.mockResolvedValue([meeting({ status: 'in_progress' })]);
      mockListByMeeting.mockResolvedValue([
        { party: 'expert', joinedAt: START, leftAt: at(30) },
        { party: 'client', joinedAt: at(2), leftAt: at(30) },
      ]);
      mockSettleSessionlessCaseMeeting.mockResolvedValue(result);

      const swept = await runMeetingLifecycleSweep(at(35), () => {}, EMPTY_READER);

      expect(swept.terminated).toBe(1);
      expect(mockWarn).toHaveBeenCalledWith(
        expect.objectContaining({ meetingId: MEETING_ID, kind: result.kind }),
        expect.stringContaining(message)
      );
    }
  );
});

describe('overrun_stop — the Arm B hard ceiling (BAL-585)', () => {
  const BOTH_CLAIMS = [
    dailyParticipantIdFor('user', USER_ID),
    dailyParticipantIdFor('user', OTHER_USER_ID),
  ];
  /** scheduledEnd = start+60, so the ceiling is max(start+60, start+240) + 30 = start+270. */
  const CEILING_MINUTES = 270;
  const TWO_OPEN = [
    presenceRow({ party: 'expert' }),
    presenceRow({ id: 'row-2', userId: OTHER_USER_ID, joinedAt: at(2) }),
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mockListStranded.mockResolvedValue([]);
    mockListCandidates.mockResolvedValue([meeting({ status: 'in_progress' })]);
    mockFindMeetingById.mockResolvedValue(meeting({ status: 'in_progress' }));
    mockListByMeeting.mockResolvedValue(TWO_OPEN);
    mockListContexts.mockResolvedValue([]);
    mockEndMeeting.mockResolvedValue({
      meeting: meeting({ status: 'ended' }),
      closedIntervals: 2,
    });
    mockDeleteRoom.mockResolvedValue('deleted');
    mockSettleSessionlessCaseMeeting.mockResolvedValue({
      kind: 'not_billable',
      reason: 'not_a_case_meeting',
    });
    mockFindCapturingForMeeting.mockResolvedValue(undefined);
    mockCountFailedByStage.mockResolvedValue(0);
  });

  it('does nothing one minute before the ceiling, whatever the roster says', async () => {
    const result = await runMeetingLifecycleSweep(at(CEILING_MINUTES - 1), () => {}, EMPTY_READER);

    expect(result.terminated).toBe(0);
    expect(mockEndMeeting).not.toHaveBeenCalled();
    expect(mockTrackServer).not.toHaveBeenCalled();
  });

  it('INCIDENT SHAPE — an unreadable per-room roster still ends the meeting at the ceiling, occupancy unknown', async () => {
    const now = at(CEILING_MINUTES);
    // Global `{}` plus a per-room read that throws (`EMPTY_READER`'s default): nothing is
    // confirmed, so nothing closes by the reconciler and the ceiling is what stops the call.
    const result = await runMeetingLifecycleSweep(now, () => {}, EMPTY_READER);

    expect(result.terminated).toBe(1);
    expect(mockEndMeeting).toHaveBeenCalledTimes(1);
    expect(mockEndMeeting).toHaveBeenCalledWith({
      id: MEETING_ID,
      outcome: 'completed',
      endedBy: 'system_idle',
      endedAt: now,
      actorUserId: null,
      terminalRule: { rule: 'overrun_stop', arm: 'hard_ceiling' },
    });
    expect(mockSettleSessionlessCaseMeeting).toHaveBeenCalledTimes(1);
    expect(mockEnqueueRecordingStop).toHaveBeenCalledWith({ meetingId: MEETING_ID });
    expect(mockDeleteRoom).toHaveBeenCalledWith(ROOM);
    expect(mockTrackServer).toHaveBeenCalledWith('meeting_overrun_stopped', {
      meeting_id: MEETING_ID,
      room_occupancy: 'unknown',
      minutes_past_scheduled_end: CEILING_MINUTES - 60,
      open_intervals_closed: 2,
      distinct_id: MEETING_ID,
    });
    expect(mockInfo).toHaveBeenCalledWith(
      expect.objectContaining({ rule: 'overrun_stop', arm: 'hard_ceiling' }),
      'Terminal rule fired'
    );
  });

  it('a roster that confirms both claims reports the room as occupied', async () => {
    const result = await runMeetingLifecycleSweep(
      at(CEILING_MINUTES),
      () => {},
      reader({ [ROOM]: BOTH_CLAIMS.map((userId) => ({ userId })) })
    );

    expect(result.terminated).toBe(1);
    expect(mockTrackServer).toHaveBeenCalledWith(
      'meeting_overrun_stopped',
      expect.objectContaining({ room_occupancy: 'occupied', open_intervals_closed: 2 })
    );
  });

  it('an unreadable roster (vendor outage) reports occupancy unknown and still ends the meeting', async () => {
    const result = await runMeetingLifecycleSweep(at(CEILING_MINUTES), () => {}, {
      getAllPresence: async () => {
        throw new Error('daily is down');
      },
      getRoomPresence: vi.fn(),
    });

    expect(result.terminated).toBe(1);
    expect(mockTrackServer).toHaveBeenCalledWith(
      'meeting_overrun_stopped',
      expect.objectContaining({ room_occupancy: 'unknown' })
    );
  });

  it('a pre-in_progress meeting is never ended by the ceiling alone', async () => {
    mockListCandidates.mockResolvedValue([meeting({ status: 'waiting_for_participants' })]);
    mockListByMeeting.mockResolvedValue([{ party: 'expert', joinedAt: START, leftAt: null }]);

    await runMeetingLifecycleSweep(at(CEILING_MINUTES), () => {}, EMPTY_READER);

    expect(mockTrackServer).not.toHaveBeenCalledWith('meeting_overrun_stopped', expect.anything());
  });

  it('a long booking is bounded by scheduledEnd + grace, not the 240-minute session cap', async () => {
    const longMeeting = meeting({ status: 'in_progress', scheduledEnd: at(300) });
    mockListCandidates.mockResolvedValue([longMeeting]);
    mockFindMeetingById.mockResolvedValue(longMeeting);

    await runMeetingLifecycleSweep(at(329), () => {}, EMPTY_READER);
    expect(mockEndMeeting).not.toHaveBeenCalled();

    await runMeetingLifecycleSweep(at(330), () => {}, EMPTY_READER);
    expect(mockEndMeeting).toHaveBeenCalledTimes(1);
  });
});

describe('the stranded arm and the reconciler caps (BAL-584)', () => {
  /** scheduledEnd = start+60, so the ceiling is max(start+60, start+240) + 30 = start+270. */
  const CEILING_MINUTES = 270;
  const IDLE_END_MINUTES = DEFAULT_MEETING_TIMERS.idleEndEmptyMs / MINUTE;
  /** Three days after the booking — far behind the 24h lookback floor. */
  const STRAND_NOW = at(3 * 24 * 60);
  const OPEN_PAIR = [
    presenceRow({ party: 'expert' }),
    presenceRow({ id: 'row-2', userId: OTHER_USER_ID, joinedAt: at(2) }),
  ];
  const CLOSED_AT_CEILING = OPEN_PAIR.map((row) => ({ ...row, leftAt: at(CEILING_MINUTES) }));

  /** A meeting whose stamped room is derived from its OWN id, so it reads as venue-ready. */
  function ownRoomMeeting(id: string, overrides: Record<string, unknown> = {}) {
    const room = dailyRoomNameForMeeting(id);
    return meeting({
      id,
      dailyRoomName: room,
      joinUrl: `https://balo.daily.co/${room}`,
      ...overrides,
    });
  }

  function openRows(prefix: string, count: number) {
    return Array.from({ length: count }, (_unused, index) =>
      presenceRow({ id: `${prefix}-${index}`, userId: `${prefix}-user-${index}` })
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockListCandidates.mockResolvedValue([]);
    mockListStranded.mockResolvedValue([]);
    mockFindMeetingById.mockResolvedValue(meeting({ status: 'in_progress' }));
    mockListByMeeting.mockResolvedValue(OPEN_PAIR);
    mockListContexts.mockResolvedValue([]);
    mockEndMeeting.mockResolvedValue({ meeting: meeting({ status: 'ended' }), closedIntervals: 2 });
    mockDeleteRoom.mockResolvedValue('deleted');
    mockApplyPresenceEffect.mockResolvedValue('closed');
    mockClosePresenceEffectForRow.mockReturnValue({ action: 'close' });
    mockReconcileMeetingStatus.mockResolvedValue(null);
    mockSettleSessionlessCaseMeeting.mockResolvedValue({
      kind: 'not_billable',
      reason: 'not_a_case_meeting',
    });
    mockFindCapturingForMeeting.mockResolvedValue(undefined);
    mockCountFailedByStage.mockResolvedValue(0);
  });

  it('pins the three bounds', () => {
    expect(MAX_RECONCILER_CLOSES_PER_TICK).toBe(25);
    expect(MAX_ROOM_PRESENCE_READS_PER_TICK).toBe(20);
    expect(MEETING_STRANDED_BATCH_LIMIT).toBe(50);
  });

  // ── The two reads ────────────────────────────────────────────────────────────────────────

  it('reads the stranded batch strictly BEFORE the same floor the in-window read starts from', async () => {
    await runMeetingLifecycleSweep(STRAND_NOW, () => {}, EMPTY_READER);

    const floor = new Date(STRAND_NOW.getTime() - 24 * 60 * MINUTE);
    expect(mockListCandidates).toHaveBeenCalledWith({
      statuses: ['scheduled', 'waiting_for_participants', 'in_progress'],
      scheduledStartAfter: floor,
      limit: MEETING_LIFECYCLE_BATCH_LIMIT,
    });
    expect(mockListStranded).toHaveBeenCalledWith({
      scheduledStartBefore: floor,
      limit: MEETING_STRANDED_BATCH_LIMIT,
    });
  });

  it('⚠ a FULL stranded batch warns, naming the oldest start it reached', async () => {
    mockListStranded.mockResolvedValue(
      Array.from({ length: MEETING_STRANDED_BATCH_LIMIT }, (_unused, index) =>
        ownRoomMeeting(`strand-${index}`, { status: 'scheduled' })
      )
    );

    await runMeetingLifecycleSweep(STRAND_NOW, () => {}, EMPTY_READER);

    expect(mockWarn).toHaveBeenCalledWith(
      { limit: MEETING_STRANDED_BATCH_LIMIT, oldestScheduledStart: START.toISOString() },
      'Stranded lifecycle batch FILLED — strands were dropped from this tick'
    );
    expect(mockListCandidates).toHaveBeenCalledWith(
      expect.objectContaining({ limit: MEETING_LIFECYCLE_BATCH_LIMIT })
    );
  });

  it('⚠ an EMPTY in-window batch does not skip the stranded arm', async () => {
    mockListStranded.mockResolvedValue([meeting({ status: 'in_progress' })]);
    const getAllPresence = vi.fn().mockResolvedValue({});

    const result = await runMeetingLifecycleSweep(STRAND_NOW, () => {}, {
      getAllPresence,
      getRoomPresence: UNSTUBBED_ROOM_READ,
    });

    expect(result).toMatchObject({ scanned: 1, stranded: 1, terminated: 1 });
    expect(getAllPresence).toHaveBeenCalledTimes(1);
  });

  it('a failing stranded read is logged and does not take the in-window batch down', async () => {
    mockListCandidates.mockResolvedValue([meeting({ status: 'scheduled' })]);
    mockListStranded.mockRejectedValue(new Error('planner timeout'));
    mockListByMeeting.mockResolvedValue([]);

    const result = await runMeetingLifecycleSweep(at(10), () => {}, EMPTY_READER);

    expect(result).toMatchObject({ scanned: 1, stranded: 0, terminated: 1 });
    expect(mockErrorLog).toHaveBeenCalledWith(
      { error: 'planner timeout' },
      'Stranded lifecycle read failed — strands are skipped this tick'
    );
  });

  // ── ⚠⚠ THE 2132522b SHAPE ─────────────────────────────────────────────────────────────────

  /**
   * ⚠⚠ A call that ended three days ago with both `participant.left` webhooks dropped. Daily's
   * map is `{}` (it never lists an empty room) and the per-room read confirms nobody is there.
   * Both intervals close AT THE OVERRUN CEILING, not at the tick that noticed, and `idle_end`
   * ends the meeting at the ceiling plus the idle window — about 4.5h recorded, not three days.
   */
  it('⚠⚠ a stranded in_progress call, confirmed empty, closes at the ceiling and ends idle_end backdated', async () => {
    mockListStranded.mockResolvedValue([meeting({ status: 'in_progress' })]);
    mockListByMeeting.mockResolvedValueOnce(OPEN_PAIR).mockResolvedValueOnce(CLOSED_AT_CEILING);
    const getRoomPresence = vi.fn().mockResolvedValue([]);

    const result = await runMeetingLifecycleSweep(
      STRAND_NOW,
      () => {},
      reader({}, getRoomPresence)
    );

    expect(result).toMatchObject({ stranded: 1, intervalsClosed: 2, terminated: 1 });
    for (const row of OPEN_PAIR) {
      expect(mockClosePresenceEffectForRow).toHaveBeenCalledWith(
        expect.objectContaining({ id: MEETING_ID }),
        row,
        at(CEILING_MINUTES)
      );
    }
    const endedAt = at(CEILING_MINUTES + IDLE_END_MINUTES);
    expect(mockEndMeeting).toHaveBeenCalledWith(
      expect.objectContaining({
        endedAt,
        terminalRule: expect.objectContaining({ rule: 'idle_end' }),
      })
    );
    expect(mockEmitMeetingEnded).toHaveBeenCalledWith(expect.objectContaining({ now: endedAt }));
    // The settlement keeps the REAL tick instant — its ceiling already reads `meeting.endedAt`.
    expect(mockSettleSessionlessCaseMeeting).toHaveBeenCalledWith(
      expect.objectContaining({ now: STRAND_NOW })
    );
  });

  /** ⚠ BAL-585 addendum — the late `overrun_stop` close must also stop at the instant it was due. */
  it('⚠ the same shape with a per-room 404 ends overrun_stop on the first stranded tick, backdated to the ceiling', async () => {
    mockListStranded.mockResolvedValue([meeting({ status: 'in_progress' })]);
    const notFound = new DailyApiError('GET', `/rooms/${ROOM}/presence`, 404, 'not found');

    const result = await runMeetingLifecycleSweep(
      STRAND_NOW,
      () => {},
      reader({}, vi.fn().mockRejectedValue(notFound))
    );

    expect(result).toMatchObject({ intervalsClosed: 0, terminated: 1 });
    expect(mockEndMeeting).toHaveBeenCalledWith({
      id: MEETING_ID,
      outcome: 'completed',
      endedBy: 'system_idle',
      endedAt: at(CEILING_MINUTES),
      actorUserId: null,
      terminalRule: { rule: 'overrun_stop', arm: 'hard_ceiling' },
    });
    expect(mockTrackServer).toHaveBeenCalledWith('meeting_overrun_stopped', {
      meeting_id: MEETING_ID,
      room_occupancy: 'unknown',
      // Measured to the EFFECTIVE stop, not to the tick that noticed.
      minutes_past_scheduled_end: CEILING_MINUTES - 60,
      open_intervals_closed: 2,
      distinct_id: MEETING_ID,
    });
  });

  it('an in-window termination is NOT backdated — `ended_at` stays the tick instant', async () => {
    mockListCandidates.mockResolvedValue([meeting({ status: 'in_progress' })]);
    mockListByMeeting.mockResolvedValue(OPEN_PAIR);

    await runMeetingLifecycleSweep(at(CEILING_MINUTES + 7), () => {}, EMPTY_READER);

    expect(mockEndMeeting).toHaveBeenCalledWith(
      expect.objectContaining({ endedAt: at(CEILING_MINUTES + 7) })
    );
  });

  it('a pre-live strand reconciler close lands at the tick instant — no ceiling applies', async () => {
    mockListStranded.mockResolvedValue([meeting({ status: 'waiting_for_participants' })]);
    mockListByMeeting
      .mockResolvedValueOnce([OPEN_PAIR[0]])
      .mockResolvedValueOnce([{ ...OPEN_PAIR[0], leftAt: STRAND_NOW }]);

    await runMeetingLifecycleSweep(STRAND_NOW, () => {}, reader({}, vi.fn().mockResolvedValue([])));

    expect(mockClosePresenceEffectForRow).toHaveBeenCalledWith(
      expect.anything(),
      OPEN_PAIR[0],
      STRAND_NOW
    );
  });

  // ── Close-only, no arming ────────────────────────────────────────────────────────────────

  it('⚠ a stranded candidate never opens an interval and never repairs status, even when the vendor lists an unknown participant', async () => {
    mockListStranded.mockResolvedValue([meeting({ status: 'in_progress' })]);
    mockListByMeeting.mockResolvedValue([OPEN_PAIR[0]]);

    const result = await runMeetingLifecycleSweep(
      STRAND_NOW,
      () => {},
      reader({
        [ROOM]: [
          { userId: dailyParticipantIdFor('user', USER_ID) },
          { userId: dailyParticipantIdFor('user', OTHER_USER_ID) },
        ],
      })
    );

    expect(result.intervalsOpened).toBe(0);
    expect(mockResolvePresenceEffect).not.toHaveBeenCalled();
    expect(mockReconcileMeetingStatus).not.toHaveBeenCalled();
  });

  it.each(['scheduled', 'waiting_for_participants'])(
    '⚠ a stranded %s candidate whose interval closes never runs the status repair',
    async (status) => {
      mockListStranded.mockResolvedValue([meeting({ status })]);
      mockListByMeeting
        .mockResolvedValueOnce([OPEN_PAIR[0]])
        .mockResolvedValueOnce([{ ...OPEN_PAIR[0], leftAt: STRAND_NOW }]);

      const result = await runMeetingLifecycleSweep(
        STRAND_NOW,
        () => {},
        reader({}, vi.fn().mockResolvedValue([]))
      );

      // The close happened, so the post-reconcile reload ran — and it is not the status repair.
      expect(result.intervalsClosed).toBe(1);
      expect(mockFindMeetingById).toHaveBeenCalledWith(MEETING_ID);
      expect(mockReconcileMeetingStatus).not.toHaveBeenCalled();
    }
  );

  it('⚠ a stranded candidate arms no absence reminder and spends no recording-ensure budget', async () => {
    // Pre-live, expert never present, past the start: an in-window candidate would arm the ops alert.
    mockListStranded.mockResolvedValue([meeting({ status: 'scheduled' })]);
    mockListByMeeting.mockResolvedValue([]);

    await runMeetingLifecycleSweep(at(3), () => {}, EMPTY_READER);

    expect(mockScheduleExpertAbsent).not.toHaveBeenCalled();
    expect(mockScheduleClientAbsent).not.toHaveBeenCalled();
  });

  it('⚠ a live-looking stranded call never reaches the recordings table or the ensure queue', async () => {
    mockListStranded.mockResolvedValue([meeting({ status: 'in_progress' })]);
    mockListByMeeting.mockResolvedValue([OPEN_PAIR[0]]);

    const result = await runMeetingLifecycleSweep(
      at(100),
      () => {},
      reader({ [ROOM]: [{ userId: dailyParticipantIdFor('user', USER_ID) }] })
    );

    expect(result.terminated).toBe(0);
    expect(result.recordingEnsures).toBe(0);
    expect(mockFindCapturingForMeeting).not.toHaveBeenCalled();
    expect(mockEnqueueRecordingEnsure).not.toHaveBeenCalled();
  });

  // ── The caps ─────────────────────────────────────────────────────────────────────────────

  it('⚠ 26 closable intervals across an in-window and a stranded candidate → exactly 25 close, the in-window first; the next tick closes the last', async () => {
    const strandRows = openRows('strand', 6);
    mockListCandidates.mockResolvedValue([ownRoomMeeting('win', { status: 'in_progress' })]);
    mockListStranded.mockResolvedValue([ownRoomMeeting('strand', { status: 'in_progress' })]);
    mockFindMeetingById.mockImplementation(async (id: string) =>
      ownRoomMeeting(id, { status: 'in_progress' })
    );
    mockListByMeeting.mockImplementation(async (id: string) =>
      id === 'win' ? openRows('win', 20) : strandRows
    );
    const getRoomPresence = vi.fn().mockResolvedValue([]);

    const tick = await runMeetingLifecycleSweep(at(100), () => {}, reader({}, getRoomPresence));

    expect(tick.intervalsClosed).toBe(MAX_RECONCILER_CLOSES_PER_TICK);
    expect(mockApplyPresenceEffect).toHaveBeenCalledTimes(MAX_RECONCILER_CLOSES_PER_TICK);
    const closedMeetingIds = mockClosePresenceEffectForRow.mock.calls.map(
      ([closedMeeting]) => (closedMeeting as { id: string }).id
    );
    expect(closedMeetingIds.slice(0, 20)).toEqual(Array.from({ length: 20 }, () => 'win'));
    expect(mockErrorLog).toHaveBeenCalledWith(
      { limit: MAX_RECONCILER_CLOSES_PER_TICK, deferred: 1 },
      expect.stringContaining('Reconciler close cap FILLED')
    );

    // The next tick: only the deferred row is left, and it closes.
    vi.clearAllMocks();
    mockListCandidates.mockResolvedValue([ownRoomMeeting('win', { status: 'in_progress' })]);
    mockListStranded.mockResolvedValue([ownRoomMeeting('strand', { status: 'in_progress' })]);
    mockListByMeeting.mockImplementation(async (id: string) =>
      id === 'strand' ? strandRows.slice(5) : []
    );
    mockApplyPresenceEffect.mockResolvedValue('closed');
    mockClosePresenceEffectForRow.mockReturnValue({ action: 'close' });

    const next = await runMeetingLifecycleSweep(at(101), () => {}, reader({}, getRoomPresence));

    expect(next.intervalsClosed).toBe(1);
    expect(mockApplyPresenceEffect).toHaveBeenCalledTimes(1);
    expect(mockErrorLog).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('close cap FILLED')
    );
  });

  it('⚠ once the close cap is spent, a later absent-room candidate makes NO per-room read and its open intervals are deferred', async () => {
    mockListCandidates.mockResolvedValue([
      ownRoomMeeting('first', { status: 'in_progress' }),
      ownRoomMeeting('second', { status: 'in_progress' }),
    ]);
    mockFindMeetingById.mockImplementation(async (id: string) =>
      ownRoomMeeting(id, { status: 'in_progress' })
    );
    mockListByMeeting.mockImplementation(async (id: string) =>
      id === 'first' ? openRows('first', MAX_RECONCILER_CLOSES_PER_TICK) : openRows('second', 3)
    );
    const getRoomPresence = vi.fn().mockResolvedValue([]);

    const result = await runMeetingLifecycleSweep(at(100), () => {}, reader({}, getRoomPresence));

    expect(getRoomPresence).toHaveBeenCalledTimes(1);
    expect(getRoomPresence).toHaveBeenCalledWith(dailyRoomNameForMeeting('first'));
    expect(result.intervalsClosed).toBe(MAX_RECONCILER_CLOSES_PER_TICK);
    expect(mockErrorLog).toHaveBeenCalledWith(
      { limit: MAX_RECONCILER_CLOSES_PER_TICK, deferred: 3 },
      expect.stringContaining('Reconciler close cap FILLED')
    );
  });

  it('⚠ 21 absent-room candidates → 20 per-room reads, the 21st is UNKNOWN this tick, and the cap warns', async () => {
    const total = MAX_ROOM_PRESENCE_READS_PER_TICK + 1;
    mockListCandidates.mockResolvedValue(
      Array.from({ length: total }, (_unused, index) =>
        ownRoomMeeting(`absent-${index}`, { status: 'in_progress' })
      )
    );
    mockFindMeetingById.mockImplementation(async (id: string) =>
      ownRoomMeeting(id, { status: 'in_progress' })
    );
    mockListByMeeting.mockImplementation(async (id: string) => openRows(id, 1));
    const getRoomPresence = vi.fn().mockResolvedValue([]);

    const result = await runMeetingLifecycleSweep(at(100), () => {}, reader({}, getRoomPresence));

    expect(getRoomPresence).toHaveBeenCalledTimes(MAX_ROOM_PRESENCE_READS_PER_TICK);
    expect(result.intervalsClosed).toBe(MAX_ROOM_PRESENCE_READS_PER_TICK);
    expect(mockWarn).toHaveBeenCalledWith(
      { limit: MAX_ROOM_PRESENCE_READS_PER_TICK, deferred: 1 },
      expect.stringContaining('Per-room presence read cap FILLED')
    );
  });

  // ── The analytics event ──────────────────────────────────────────────────────────────────

  it.each<{
    label: string;
    mode: 'in_window' | 'stranded';
    rooms: Record<string, Participants>;
    source: string;
  }>([
    {
      label: 'a per-room read, in-window',
      mode: 'in_window',
      rooms: {},
      source: 'room',
    },
    {
      label: 'the platform-wide map, in-window',
      mode: 'in_window',
      rooms: { [ROOM]: [] },
      source: 'platform',
    },
    {
      label: 'a per-room read, stranded',
      mode: 'stranded',
      rooms: {},
      source: 'room',
    },
    {
      label: 'the platform-wide map, stranded',
      mode: 'stranded',
      rooms: { [ROOM]: [] },
      source: 'platform',
    },
  ])(
    'emits meeting_presence_reconciled once for a changed candidate — $label',
    async ({ mode, rooms, source }) => {
      const candidates = [meeting({ status: 'in_progress' })];
      (mode === 'stranded' ? mockListStranded : mockListCandidates).mockResolvedValue(candidates);
      mockListByMeeting.mockResolvedValue([OPEN_PAIR[0]]);

      await runMeetingLifecycleSweep(
        at(100),
        () => {},
        reader(rooms, vi.fn().mockResolvedValue([]))
      );

      const calls = mockTrackServer.mock.calls.filter(
        ([event]) => event === 'meeting_presence_reconciled'
      );
      expect(calls).toEqual([
        [
          'meeting_presence_reconciled',
          {
            meeting_id: MEETING_ID,
            intervals_closed: 1,
            intervals_opened: 0,
            roster_source: source,
            stranded: mode === 'stranded',
            distinct_id: MEETING_ID,
          },
        ],
      ]);
    }
  );

  it('emits nothing when the reconciler changed nothing', async () => {
    mockListCandidates.mockResolvedValue([meeting({ status: 'in_progress' })]);
    mockListByMeeting.mockResolvedValue([OPEN_PAIR[0]]);

    await runMeetingLifecycleSweep(
      at(100),
      () => {},
      reader({ [ROOM]: [{ userId: dailyParticipantIdFor('user', USER_ID) }] })
    );

    expect(mockTrackServer).not.toHaveBeenCalledWith(
      'meeting_presence_reconciled',
      expect.anything()
    );
  });
});

describe('roomOccupancy', () => {
  it.each([
    { label: 'unknown', read: { source: 'unknown' }, expected: 'unknown' },
    {
      label: 'a validated empty room read',
      read: { source: 'room', participants: [], vendorCount: 0 },
      expected: 'empty',
    },
    {
      label: 'a platform-map room with listed ids',
      read: { source: 'platform', participants: ['a'], vendorCount: 1 },
      expected: 'occupied',
    },
    {
      // ⚠ THE RAW COUNT, NOT THE FILTERED IDS — an id-less participant still occupies the room.
      label: 'a room whose only participant has no id',
      read: { source: 'room', participants: [], vendorCount: 1 },
      expected: 'occupied',
    },
  ] as const)('$label -> $expected', ({ read, expected }) => {
    expect(roomOccupancy(read)).toBe(expected);
  });
});

describe('the sweep cadence', () => {
  /**
   * ⚠ PER-MINUTE IS NOT A FREE KNOB. It is what BOUNDS the dropped-`participant.left` over-bill
   * to one tick; slowing it widens a MONEY error, not just a latency.
   */
  it('⚠ runs every minute — the bound on the over-bill window', () => {
    expect(MEETING_LIFECYCLE_SWEEP_CRON).toBe('* * * * *');
  });
});

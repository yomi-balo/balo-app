import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockListCandidates,
  mockFindMeetingById,
  mockEndMeeting,
  mockListByMeeting,
  mockListOpen,
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
  mockSettleMeetingIfBillable,
  mockEnqueueRecordingEnsure,
  mockEnqueueRecordingStop,
  mockFindCapturingForMeeting,
  mockCountFailedByStage,
} = vi.hoisted(() => ({
  mockListCandidates: vi.fn(),
  mockFindMeetingById: vi.fn(),
  mockEndMeeting: vi.fn(),
  mockListByMeeting: vi.fn(),
  mockListOpen: vi.fn(),
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
  mockSettleMeetingIfBillable: vi.fn(),
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
    findById: mockFindMeetingById,
    endMeeting: mockEndMeeting,
  },
  meetingPresenceRepository: { listByMeeting: mockListByMeeting, listOpen: mockListOpen },
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
// BAL-412 — INERT on main (D10). Mocked so this suite stays focused on the sweep's own three
// passes; the settlement wrapper's own behaviour is covered in `settle-from-presence.test.ts`.
vi.mock('../services/credit-session/settle-from-presence.js', () => ({
  settleMeetingIfBillable: mockSettleMeetingIfBillable,
}));
vi.mock('../notifications/scheduling/meeting-absence.js', () => ({
  scheduleExpertAbsentAlert: mockScheduleExpertAbsent,
  scheduleClientAbsentNudge: mockScheduleClientAbsent,
}));
vi.mock('../services/daily/rooms.js', () => ({
  dailyRoomTeardown: { deleteRoom: mockDeleteRoom },
  dailyPresenceReader: { getAllPresence: vi.fn() },
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

import { dailyParticipantIdFor, DEFAULT_MEETING_TIMERS } from '@balo/shared/meetings';
import {
  MAX_RECORDING_ENSURES_PER_SWEEP_TICK,
  MEETING_LIFECYCLE_BATCH_LIMIT,
  MEETING_LIFECYCLE_SWEEP_CRON,
  runMeetingLifecycleSweep,
} from './meeting-lifecycle-sweep.js';
import type { PresenceReader } from '../services/daily/rooms.js';

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

function meeting(overrides: Record<string, unknown> = {}) {
  return {
    id: MEETING_ID,
    status: 'waiting_for_participants',
    scheduledStart: START,
    scheduledEnd: at(60),
    dailyRoomName: ROOM,
    endedAt: null,
    outcome: null,
    ...overrides,
  };
}

/** A presence reader port that answers a fixed roster — no network, no Daily account. */
function reader(rooms: Record<string, Array<{ userId?: string }>>): PresenceReader {
  return { getAllPresence: async () => rooms };
}

const EMPTY_READER = reader({});

describe('runMeetingLifecycleSweep (BAL-134 §5.6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListCandidates.mockResolvedValue([]);
    mockListByMeeting.mockResolvedValue([]);
    mockListOpen.mockResolvedValue([]);
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
    mockSettleMeetingIfBillable.mockResolvedValue({ ok: false, code: 'no_meeting' });
    // BAL-480 — no capturing segment by default; individual tests override to exercise the
    // level-triggered gate.
    mockFindCapturingForMeeting.mockResolvedValue(undefined);
    // BAL-480 fix round 1 — well under the per-meeting Daily failure cap by default.
    mockCountFailedByStage.mockResolvedValue(0);
  });

  it('scans nothing and does nothing on an empty batch — no vendor call', async () => {
    const getAllPresence = vi.fn();

    await expect(
      runMeetingLifecycleSweep(at(30), () => {}, { getAllPresence })
    ).resolves.toMatchObject({ scanned: 0, terminated: 0 });
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

  // ── PASS 1 — RECONCILIATION ─────────────────────────────────────────────────────────────

  /**
   * ⚠ EVERY INTERVAL THIS CLOSES IS A DROPPED `participant.left` WEBHOOK, and the RATE is the
   * health signal for the whole presence model — this warn is the only place it exists.
   */
  it('⚠ closes an open interval the vendor roster does not confirm, and WARNS about it', async () => {
    mockListCandidates.mockResolvedValue([meeting({ status: 'in_progress' })]);
    mockFindMeetingById.mockResolvedValue(meeting({ status: 'in_progress' }));
    mockListOpen.mockResolvedValue([
      { id: 'row-1', userId: USER_ID, meetingGuestId: null, party: 'client', joinedAt: START },
    ]);

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
    const row = {
      id: 'row-1',
      userId: USER_ID,
      meetingGuestId: null,
      party: 'client',
      joinedAt: START,
    };
    mockListOpen.mockResolvedValue([row]);

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
    mockListOpen.mockResolvedValue([
      { id: 'row-1', userId: USER_ID, meetingGuestId: null, party: 'client', joinedAt: START },
    ]);

    const result = await runMeetingLifecycleSweep(at(30), () => {}, {
      getAllPresence: async () => ({
        [ROOM]: [{ userId: dailyParticipantIdFor('user', USER_ID) }],
      }),
    });

    expect(result.intervalsClosed).toBe(0);
  });

  it('opens an interval for a vendor participant Balo has none for (a dropped `joined`)', async () => {
    mockListCandidates.mockResolvedValue([meeting({ status: 'in_progress' })]);
    mockFindMeetingById.mockResolvedValue(meeting({ status: 'in_progress' }));
    mockApplyPresenceEffect.mockResolvedValue('opened');

    const result = await runMeetingLifecycleSweep(at(30), () => {}, {
      getAllPresence: async () => ({
        [ROOM]: [{ userId: dailyParticipantIdFor('user', USER_ID) }],
      }),
    });

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

    await runMeetingLifecycleSweep(at(30), () => {}, {
      getAllPresence: async () => ({
        [ROOM]: [
          { userId: dailyParticipantIdFor('user', USER_ID) },
          { userId: dailyParticipantIdFor('user', OTHER_USER_ID) },
        ],
      }),
    });

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

    await runMeetingLifecycleSweep(at(30), () => {}, {
      getAllPresence: async () => ({
        [ROOM]: [{ userId: dailyParticipantIdFor('user', USER_ID) }],
      }),
    });

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

    const result = await runMeetingLifecycleSweep(at(30), () => {}, {
      getAllPresence: async () => ({
        [ROOM]: [{ userId: dailyParticipantIdFor('user', USER_ID) }],
      }),
    });

    // Only reachable via `in_progress` — a `scheduled` meeting whose expert HAS been present
    // matches the abandoned wait instead, which carries a NULL outcome.
    expect(result.terminated).toBe(1);
    expect(mockEndMeeting).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'completed' }));
  });

  it('does NOT re-read or re-transition when reconciliation changed nothing', async () => {
    mockListCandidates.mockResolvedValue([meeting({ status: 'in_progress' })]);
    mockListByMeeting.mockResolvedValue([
      { party: 'expert', joinedAt: START, leftAt: null },
      { party: 'client', joinedAt: at(1), leftAt: null },
    ]);
    mockListOpen.mockResolvedValue([
      { id: 'row-1', userId: USER_ID, meetingGuestId: null, party: 'expert', joinedAt: START },
    ]);

    await runMeetingLifecycleSweep(at(20), () => {}, {
      getAllPresence: async () => ({
        [ROOM]: [{ userId: dailyParticipantIdFor('user', USER_ID) }],
      }),
    });

    expect(mockFindMeetingById).not.toHaveBeenCalled();
    expect(mockReconcileMeetingStatus).not.toHaveBeenCalled();
  });

  it('a meeting soft-deleted between the batch read and the repair is skipped, not thrown on', async () => {
    mockListCandidates.mockResolvedValue([meeting({ status: 'in_progress' })]);
    mockApplyPresenceEffect.mockResolvedValue('opened');
    mockFindMeetingById.mockResolvedValue(undefined);

    const result = await runMeetingLifecycleSweep(at(30), () => {}, {
      getAllPresence: async () => ({
        [ROOM]: [{ userId: dailyParticipantIdFor('user', USER_ID) }],
      }),
    });

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
      { party: 'expert', joinedAt: START, leftAt: null },
      { party: 'client', joinedAt: at(1), leftAt: null },
    ]);
    mockListOpen.mockResolvedValue([
      { id: 'row-1', userId: USER_ID, meetingGuestId: null, party: 'client', joinedAt: at(1) },
    ]);

    await runMeetingLifecycleSweep(at(20), () => {}, {
      getAllPresence: async () => ({
        [ROOM]: [{ userId: dailyParticipantIdFor('user', USER_ID) }],
      }),
    });

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
   * orders `asc(scheduledStart), asc(id)` — stable — so without this term twenty permanently
   * -capped meetings would occupy the whole per-tick budget forever and no later meeting's
   * self-heal would ever run. Post-outage, that is exactly when the budget must reach the
   * meetings that are still recoverable.
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

  // ── ⚠⚠ S1 — THE PLATFORM-WIDE-EMPTY SANITY GATE ────────────────────────────────────────

  /**
   * ⚠⚠ THE `rosterAvailable` GUARD ONLY COVERS A **THROWN** `getAllPresence`. A `200` whose body
   * this platform cannot interpret the way it expects yields a well-formed EMPTY map with
   * `rosterAvailable === true` — and then every candidate resolves to `[]` = "confirmed empty",
   * every open interval on the platform closes in one tick, ~5 minutes later `idleEndApplies`
   * ends every `in_progress` meeting, and `tearDownRoom` DELETES DAILY ROOMS OUT FROM UNDER
   * PEOPLE WHO ARE STILL TALKING.
   */
  it('⚠⚠ S1 — a platform-wide EMPTY roster does not close intervals; it is UNKNOWN', async () => {
    mockListCandidates.mockResolvedValue([meeting({ status: 'in_progress' })]);
    mockListOpen.mockResolvedValue([
      { id: 'row-1', userId: USER_ID, meetingGuestId: null, party: 'client', joinedAt: START },
    ]);

    const result = await runMeetingLifecycleSweep(at(30), () => {}, EMPTY_READER);

    expect(result.intervalsClosed).toBe(0);
    expect(mockApplyPresenceEffect).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({ meetingId: MEETING_ID, openIntervals: 1 }),
      expect.stringContaining('NO participants in ANY room')
    );
  });

  /**
   * ⚠ THE GATE DISTINGUISHES "NO ROOMS AT ALL" FROM "THIS ROOM IS CONFIRMED EMPTY". The second
   * is the ordinary everyone-left answer and MUST still reconcile — otherwise the gate would
   * disable the reconciler's whole reason for existing.
   */
  it('⚠ a room the vendor lists as EMPTY still reconciles — that is a confirmed answer', async () => {
    mockListCandidates.mockResolvedValue([meeting({ status: 'in_progress' })]);
    mockFindMeetingById.mockResolvedValue(meeting({ status: 'in_progress' }));
    mockListOpen.mockResolvedValue([
      { id: 'row-1', userId: USER_ID, meetingGuestId: null, party: 'client', joinedAt: START },
    ]);

    const result = await runMeetingLifecycleSweep(at(30), () => {}, reader({ [ROOM]: [] }));

    expect(result.intervalsClosed).toBe(1);
  });

  it('a platform-wide empty roster still reconciles a candidate that holds NOTHING open', async () => {
    mockListCandidates.mockResolvedValue([meeting({ status: 'in_progress' })]);
    mockListOpen.mockResolvedValue([]);

    await runMeetingLifecycleSweep(at(30), () => {}, EMPTY_READER);

    expect(mockWarn).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('NO participants in ANY room')
    );
  });

  /**
   * ⚠⚠ THE WORST BUG THIS FILE GUARDS. A Daily outage, a `429`, or an un-provisioned meeting all
   * yield NO roster — and treating that as "the room is empty" would close EVERY open interval
   * on EVERY live meeting in one tick, truncating every billable span at once. `null` means
   * UNKNOWN; reconciliation is SKIPPED, and the terminal rules still run.
   */
  it('⚠⚠ a VENDOR FAILURE skips reconciliation entirely — it never reads as "the room is empty"', async () => {
    mockListCandidates.mockResolvedValue([meeting({ status: 'in_progress' })]);
    mockListOpen.mockResolvedValue([
      { id: 'row-1', userId: USER_ID, meetingGuestId: null, party: 'client', joinedAt: START },
    ]);

    const result = await runMeetingLifecycleSweep(at(30), () => {}, {
      getAllPresence: async () => {
        throw new Error('daily is down');
      },
    });

    expect(result.intervalsClosed).toBe(0);
    expect(mockApplyPresenceEffect).not.toHaveBeenCalled();
    expect(mockErrorLog).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'daily is down' }),
      expect.stringContaining('skipping reconciliation')
    );
  });

  /**
   * ⚠ AN INTERVAL WITH NO IDENTITY CANNOT BE RECONCILED — there is nothing to match against the
   * roster. It is `observer` by construction, so it bills nothing either way, and closing it on
   * a guess would be worse than leaving it.
   */
  it('⚠ leaves an UNMAPPED interval (both identity columns null) alone', async () => {
    mockListCandidates.mockResolvedValue([meeting({ status: 'in_progress' })]);
    mockListOpen.mockResolvedValue([
      { id: 'row-1', userId: null, meetingGuestId: null, party: 'observer', joinedAt: START },
    ]);

    const result = await runMeetingLifecycleSweep(at(30), () => {}, reader({ [ROOM]: [] }));

    expect(result.intervalsClosed).toBe(0);
  });

  // ── PASS 2 — THE FOUR TERMINAL RULES ────────────────────────────────────────────────────

  const TERMINAL_ROWS: ReadonlyArray<{
    label: string;
    status: string;
    intervals: Array<{ party: string; joinedAt: Date; leftAt: Date | null }>;
    nowMinutes: number;
    outcome: string | null;
    event?: string;
  }> = [
    {
      label: 'IDLE END — completed',
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
      status: 'waiting_for_participants',
      intervals: [{ party: 'expert', joinedAt: START, leftAt: null }],
      nowMinutes: 15,
      outcome: 'no_show_client',
    },
    {
      label: 'MISSED CALL — missed_call + its own event',
      status: 'scheduled',
      intervals: [],
      nowMinutes: 10,
      outcome: 'missed_call',
      event: 'meeting_missed_call',
    },
    {
      label: 'ABANDONED WAIT (D9) — NULL outcome + its own event',
      status: 'waiting_for_participants',
      intervals: [{ party: 'expert', joinedAt: START, leftAt: at(8) }],
      nowMinutes: 13,
      outcome: null,
      event: 'meeting_waiting_abandoned',
    },
  ];

  it.each(TERMINAL_ROWS)('$label', async (rowSpec) => {
    mockListCandidates.mockResolvedValue([meeting({ status: rowSpec.status })]);
    mockListByMeeting.mockResolvedValue(rowSpec.intervals);

    const result = await runMeetingLifecycleSweep(at(rowSpec.nowMinutes), () => {}, EMPTY_READER);

    expect(result.terminated).toBe(1);
    expect(mockEndMeeting).toHaveBeenCalledWith({
      id: MEETING_ID,
      outcome: rowSpec.outcome,
      // ⚠ ALL FOUR SYSTEM RULES REPORT `system_idle`. `ended_by` answers "person or system?";
      // WHICH rule fired is answered by `outcome` plus the audit row.
      endedBy: 'system_idle',
      endedAt: at(rowSpec.nowMinutes),
      // ⚠ NULL ACTOR — the ADR-1030 system-actor exemption. Never a fabricated actor.
      actorUserId: null,
    });
    if (rowSpec.event !== undefined) {
      expect(mockTrackServer).toHaveBeenCalledWith(rowSpec.event, expect.anything());
    }
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
    mockListCandidates.mockResolvedValue([
      meeting({ status: 'scheduled', dailyRoomName: 'balo-ffffffffffffffffffffffffffffffff' }),
    ]);

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
      contextType: 'case',
      timers: DEFAULT_MEETING_TIMERS,
    });
    expect(mockScheduleClientAbsent).not.toHaveBeenCalled();
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
    mockListCandidates.mockResolvedValue([
      meeting({ id: 'bad', status: 'scheduled' }),
      meeting({ id: 'good', status: 'scheduled' }),
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
    expect(mockSettleMeetingIfBillable).toHaveBeenCalledWith({
      meetingId: MEETING_ID,
      actorUserId: null,
      now: at(35),
    });
  });

  it('⚠ a SETTLEMENT FAILURE does not abort the sweep tick — logs at error and continues', async () => {
    mockListCandidates.mockResolvedValue([
      meeting({ status: 'in_progress' }),
      meeting({ id: 'good', status: 'in_progress' }),
    ]);
    mockListByMeeting.mockResolvedValue([
      { party: 'expert', joinedAt: START, leftAt: at(30) },
      { party: 'client', joinedAt: at(2), leftAt: at(30) },
    ]);
    mockSettleMeetingIfBillable.mockRejectedValueOnce(new Error('settlement boom'));

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

    expect(mockSettleMeetingIfBillable).not.toHaveBeenCalled();
  });

  it('BAL-466 — a candidate whose meeting has a presence session settles, actorUserId: null', async () => {
    mockListCandidates.mockResolvedValue([meeting({ status: 'in_progress' })]);
    mockListByMeeting.mockResolvedValue([
      { party: 'expert', joinedAt: START, leftAt: at(30) },
      { party: 'client', joinedAt: at(2), leftAt: at(30) },
    ]);
    mockSettleMeetingIfBillable.mockResolvedValue({
      ok: true,
      settlement: { shape: 'held' },
      result: {},
    });

    const result = await runMeetingLifecycleSweep(at(35), () => {}, EMPTY_READER);

    expect(result.terminated).toBe(1);
    expect(mockSettleMeetingIfBillable).toHaveBeenCalledWith({
      meetingId: MEETING_ID,
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
    mockSettleMeetingIfBillable.mockResolvedValue({ ok: false, code: 'already_settled' });

    const result = await runMeetingLifecycleSweep(at(35), () => {}, EMPTY_READER);

    expect(result.terminated).toBe(1);
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({ meetingId: MEETING_ID, code: 'already_settled' }),
      expect.stringContaining('Presence settlement declined')
    );
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

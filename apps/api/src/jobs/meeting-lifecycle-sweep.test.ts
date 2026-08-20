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
}));

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
// ⚠ NEITHER `../lib/redis.js` NOR `../lib/queue.js` IS REACHED: only `runMeetingLifecycleSweep`
// is imported, and the Worker/cron constructors are never called. ⚠ `@balo/shared/meetings` is
// NOT mocked — `resolveTerminalRule` and `dailyParticipantIdFor` are what these rows assert.

import { dailyParticipantIdFor, DEFAULT_MEETING_TIMERS } from '@balo/shared/meetings';
import {
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
    // BAL-412 — INERT on main (D10): every meeting today resolves `no_meeting`.
    mockSettleMeetingIfBillable.mockResolvedValue({ ok: false, code: 'no_meeting' });
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
   */
  it('⚠⚠ C1 — a reconciler-opened expert+client pair drives the STATUS transition too', async () => {
    mockListCandidates.mockResolvedValue([meeting({ status: 'scheduled' })]);
    mockFindMeetingById.mockResolvedValue(meeting({ status: 'scheduled' }));
    mockApplyPresenceEffect.mockResolvedValue('opened');
    mockReconcileMeetingStatus.mockResolvedValue('in_progress');

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

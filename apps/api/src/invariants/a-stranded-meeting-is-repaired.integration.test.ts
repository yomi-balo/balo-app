import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * BAL-584 — INVARIANT, END TO END AGAINST A REAL POSTGRES: a live meeting whose
 * `participant.left` webhooks were both dropped, and which is now older than the lifecycle
 * sweep's in-window lookback floor, is REPAIRED by the sweep's stranded arm within two ticks —
 * its intervals closed WHERE DAILY RECORDED THE PARTICIPANTS LEAVING, the meeting ended, its
 * recorded span bounded to the instant the rule became due rather than the tick that noticed,
 * and its credit session no longer metered. A pre-live strand is bounded the same way, so its
 * settlement bills the true presence and never a day of it.
 *
 * ── THE INCIDENT (meeting 2132522b) ─────────────────────────────────────────────────────
 *
 * Both leave webhooks dropped, so both intervals stayed open. Daily's platform-wide presence map
 * never lists an EMPTY room, so once nobody was on any Balo call it was `{}`: an absent room is
 * not a confirmed-empty one, and only a validated per-room read licenses closing its intervals.
 * Past the 24h floor the meeting also left the in-window batch, so without the stranded arm no
 * sweep would look at it again and its presence session would keep metering for days.
 *
 * ── WHAT IS DRIVEN ──────────────────────────────────────────────────────────────────────
 *
 * Only production entry points: the booking row (`meetingsRepository.create` + `setVenue`),
 * admission (`joinMeetingAsMember` through its `minter` injection point), presence (the Daily
 * webhook's three phases), and `runMeetingLifecycleSweep(now, noop, reader)`. The two dropped
 * leaves are simulated by emptying the fake vendor room WITHOUT reporting a leave, so Balo's
 * intervals stay open while Daily's map is `{}` — exactly the incident's shape.
 *
 * ⚠ THE SWEEP'S `now` IS AN ARGUMENT, so the meeting is booked an hour before the REAL clock
 * (admission reads the real clock) and ticked three days later. Every instant is derived from
 * the real clock at test time; there are no calendar literals.
 *
 * ── MOCKS (and only these) ──────────────────────────────────────────────────────────────
 * `../lib/queue.js` `getQueue` (BullMQ would open a Redis connection), the Daily room teardown,
 * the Stripe off-session charge (no wallet here holds a mandate) and `raiseAdminAlert`.
 * `@balo/db` stays REAL. This file runs from `packages/db/vitest.config.integration.ts`.
 */

const { vendorRooms, roomRead, mockDeleteRoom, mockGetQueue } = vi.hoisted(() => {
  const rooms = new Map<string, Set<string>>();
  const add = vi.fn().mockResolvedValue({ id: 'test-job' });
  return {
    vendorRooms: rooms,
    /**
     * What the vendor reads do this test: the per-room presence read confirms empty or answers
     * 404, and Daily's session history records each claim's leave (empty by default, so a claim
     * Daily has no record of falls back to the booked end).
     */
    roomRead: {
      mode: 'empty' as 'empty' | 'not_found',
      leaves: new Map<string, Date>(),
    },
    mockDeleteRoom: vi.fn(async (name: string): Promise<'deleted'> => {
      rooms.delete(name);
      return 'deleted';
    }),
    mockGetQueue: vi.fn(() => ({ add })),
  };
});

vi.mock('../lib/queue.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/queue.js')>()),
  getQueue: mockGetQueue,
}));
vi.mock('../services/daily/rooms.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/daily/rooms.js')>()),
  dailyRoomTeardown: { deleteRoom: mockDeleteRoom },
}));
vi.mock('../services/stripe/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/stripe/index.js')>()),
  createOffSessionCharge: vi.fn(async (): Promise<never> => {
    throw new Error('Stripe is not reachable from this suite — no test wallet holds a mandate');
  }),
}));
vi.mock('../services/admin-alerts/raise.js', () => ({
  raiseAdminAlert: vi.fn(async (): Promise<void> => undefined),
}));

import {
  and,
  auditEvents,
  creditLedger,
  creditLedgerRepository,
  creditSessions,
  creditSessionsRepository,
  creditWalletsRepository,
  db,
  deriveIdempotencyKey,
  eq,
  expertsRepository,
  meetingPresenceRepository,
  meetings,
  meetingsRepository,
  type AuditEvent,
  type Meeting,
} from '@balo/db';
import { randomUUID } from 'node:crypto';
import { deriveSessionEstimate } from '@balo/shared/credit';
import {
  LIFECYCLE_LOOKBACK_MS,
  dailyParticipantIdFor,
  dailyRoomNameForMeeting,
  overrunStopCeiling,
} from '@balo/shared/meetings';
import { resolveMeetingTimers } from '../config/meeting-timers.js';
import { runMeetingLifecycleSweep } from '../jobs/meeting-lifecycle-sweep.js';
import { DailyApiError } from '../services/daily/errors.js';
import type { MeetingTokenMinter } from '../services/daily/meeting-tokens.js';
import type { PresenceReader } from '../services/daily/rooms.js';
import { joinMeetingAsMember } from '../services/meetings/join-meeting.js';
import {
  applyPresenceEffect,
  reconcileMeetingStatus,
  resolvePresenceEffect,
  type PresenceAction,
} from '../services/meetings/presence-writer.js';
import { seedBookingParties } from '../test/fixtures/booking-graph.js';

// ── Constants — every one DERIVED ──────────────────────────────────────────────────────

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const BOOKING_LEAD_MINUTES = 60;
const BOOKED_WINDOW_MINUTES = 30;
/** Comfortably more than the longest metered span any test here can draw. */
const FUNDED_BALANCE_MINOR = 500_000;
const EXPERT_HOURLY_MINOR = 33_600;
/** At the default fee this is 700/min client, 560/min expert. */
const { clientRateMinorPerMinute: CLIENT_RATE, expertRateMinorPerMinute: EXPERT_RATE } =
  deriveSessionEstimate({ expertHourlyMinor: EXPERT_HOURLY_MINOR, estimatedMinutes: 1 });
const TIMERS = resolveMeetingTimers();

/** The documented `minter` injection point — no Daily account, no network. */
const testMinter: MeetingTokenMinter = {
  createMeetingToken: async () => ({ token: 'test-daily-meeting-token' }),
};

/**
 * The vendor roster as Daily reports it: the platform-wide map lists only NON-EMPTY rooms, the
 * per-room read answers `[]` for an empty one (or a 404, per `roomRead.mode`), and the session
 * history answers the leaves a test injects through `roomRead.leaves`.
 */
const fakePresenceReader: PresenceReader = {
  getAllPresence: async () =>
    Object.fromEntries(
      [...vendorRooms.entries()]
        .filter(([, participants]) => participants.size > 0)
        .map(([room, participants]) => [room, [...participants].map((userId) => ({ userId }))])
    ),
  getRoomPresence: async (roomName) => {
    if (roomRead.mode === 'not_found') {
      throw new DailyApiError('GET', `/rooms/${roomName}/presence`, 404, 'room not found');
    }
    return [...(vendorRooms.get(roomName) ?? [])].map((userId) => ({ userId }));
  },
  getRoomSessionLeaves: async () => ({ leaves: new Map(roomRead.leaves) }),
};

const noop = (): void => {};

function plusMinutes(instant: Date, minutes: number): Date {
  return new Date(instant.getTime() + minutes * MS_PER_MINUTE);
}

/** A minute-aligned scheduled start an hour before the real clock. Never a calendar literal. */
function freshScheduledStart(): Date {
  const minute = Math.floor(Date.now() / MS_PER_MINUTE) * MS_PER_MINUTE;
  return new Date(minute - MS_PER_HOUR);
}

// ── Fixture ──────────────────────────────────────────────────────────────────────────

interface StrandedCall {
  readonly meetingId: string;
  readonly sessionId: string;
  readonly start: Date;
  /** The overrun ceiling — the instant the rule that stops this call became due. */
  readonly ceiling: Date;
  /** A tick three days after the booking — far behind the 24h lookback floor. */
  readonly strandedNow: Date;
  /** The Daily `user_id` claims of the two parties, as the session history keys them. */
  readonly expertClaim: string;
  readonly clientClaim: string;
}

async function mustFindMeeting(meetingId: string): Promise<Meeting> {
  const meeting = await meetingsRepository.findById(meetingId);
  if (meeting === undefined) {
    throw new Error(`fixture: meeting ${meetingId} not found`);
  }
  return meeting;
}

/** One Daily presence observation, applied the way the webhook route does, mirrored to Daily. */
async function observe(
  action: PresenceAction,
  meetingId: string,
  participantId: string,
  at: Date
): Promise<void> {
  const meeting = await mustFindMeeting(meetingId);
  const effect = await resolvePresenceEffect({ action, meeting, participantId, at });
  await applyPresenceEffect(db, effect);
  await reconcileMeetingStatus(meeting, at);

  const roomName = meeting.dailyRoomName;
  if (roomName === null) {
    throw new Error(`fixture: meeting ${meetingId} has no venue`);
  }
  const room = vendorRooms.get(roomName) ?? new Set<string>();
  if (action === 'open') {
    room.add(participantId);
  } else {
    room.delete(participantId);
  }
  vendorRooms.set(roomName, room);
}

interface BookedMeeting {
  readonly parties: Awaited<ReturnType<typeof seedBookingParties>>;
  readonly expertUserId: string;
  readonly meetingId: string;
  readonly roomName: string;
}

/** A Case meeting booked over `[start, scheduledEnd]` with its venue stamped READY at booking. */
async function seedVenueReadyMeeting(start: Date, scheduledEnd: Date): Promise<BookedMeeting> {
  const parties = await seedBookingParties();
  await expertsRepository.updateProfile(parties.expertProfileId, {
    rateCents: EXPERT_HOURLY_MINOR,
  });
  const expert = await expertsRepository.findUserIdByProfileId(parties.expertProfileId);
  if (expert === undefined) {
    throw new Error('fixture: the seeded expert profile resolves no user');
  }
  const { meeting } = await meetingsRepository.create({
    scheduledStart: start,
    scheduledEnd,
    contexts: [{ contextType: 'case', contextId: parties.caseEngagementId }],
    actorUserId: parties.memberUserId,
  });
  const roomName = dailyRoomNameForMeeting(meeting.id);
  await meetingsRepository.setVenue(meeting.id, {
    dailyRoomName: roomName,
    joinUrl: `https://balo.daily.co/${roomName}`,
  });
  // A booking-time room is ready before the start; `setVenue` stamps the real clock.
  await db
    .update(meetings)
    .set({ venueProvisionedAt: plusMinutes(start, -BOOKING_LEAD_MINUTES) })
    .where(eq(meetings.id, meeting.id));
  return { parties, expertUserId: expert.user.id, meetingId: meeting.id, roomName };
}

/** A cash top-up, through the ledger's one write seam. Provisions the wallet first. */
async function fundWallet(parties: BookedMeeting['parties']): Promise<void> {
  const wallet = await creditWalletsRepository.ensureForCompany(db, parties.companyId);
  const paymentIntentId = `pi_test_${randomUUID().replace(/-/g, '')}`;
  await creditLedgerRepository.postEntry({
    walletId: wallet.id,
    entryType: 'purchase',
    reason: 'manual_purchase',
    amountMinor: FUNDED_BALANCE_MINOR,
    idempotencyKey: deriveIdempotencyKey({ reason: 'manual_purchase', paymentIntentId }),
    memberId: parties.memberUserId,
    stripePaymentIntentId: paymentIntentId,
  });
}

/**
 * A live, billing Case call: expert and client both joined, the presence session open, and then
 * BOTH LEAVES DROPPED — Daily's room is empty and nothing told Balo.
 */
async function seedStrandedCall(): Promise<StrandedCall> {
  const start = freshScheduledStart();
  const scheduledEnd = plusMinutes(start, BOOKED_WINDOW_MINUTES);
  const { parties, expertUserId, meetingId, roomName } = await seedVenueReadyMeeting(
    start,
    scheduledEnd
  );
  await fundWallet(parties);

  const admitted = await joinMeetingAsMember({
    meetingId: meetingId,
    userId: parties.memberUserId,
    minter: testMinter,
  });
  if (!admitted.ok) {
    throw new Error(`fixture: member admission refused (${admitted.code})`);
  }
  await observe('open', meetingId, dailyParticipantIdFor('user', expertUserId), start);
  await observe(
    'open',
    meetingId,
    dailyParticipantIdFor('user', parties.memberUserId),
    plusMinutes(start, 1)
  );
  expect((await mustFindMeeting(meetingId)).status).toBe('in_progress');

  // ⚠ THE DROPPED LEAVES: Daily's room empties, Balo is never told.
  vendorRooms.set(roomName, new Set());

  const [session] = await db
    .select()
    .from(creditSessions)
    .where(eq(creditSessions.meetingId, meetingId));
  if (session === undefined) {
    throw new Error('fixture: admission opened no presence session');
  }
  return {
    meetingId: meetingId,
    sessionId: session.id,
    start,
    ceiling: overrunStopCeiling(start, scheduledEnd, TIMERS),
    strandedNow: new Date(start.getTime() + 3 * MS_PER_DAY),
    expertClaim: dailyParticipantIdFor('user', expertUserId),
    clientClaim: dailyParticipantIdFor('user', parties.memberUserId),
  };
}

// ── Reads ────────────────────────────────────────────────────────────────────────────

async function meteredSessionIds(): Promise<string[]> {
  return (await creditSessionsRepository.findMeterable()).map((session) => session.id);
}

async function endedAudit(meetingId: string): Promise<AuditEvent[]> {
  return db
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.entityType, 'meeting'),
        eq(auditEvents.entityId, meetingId),
        eq(auditEvents.action, 'meeting.ended')
      )
    );
}

async function leftAtInstants(meetingId: string): Promise<number[]> {
  const rows = await meetingPresenceRepository.listByMeeting(meetingId);
  return rows.map((row) => row.leftAt?.getTime() ?? Number.NaN);
}

beforeEach(() => {
  vi.clearAllMocks();
  vendorRooms.clear();
  roomRead.mode = 'empty';
  roomRead.leaves.clear();
});

// ── The cases ────────────────────────────────────────────────────────────────────────

describe('INVARIANT (end-to-end): a stranded meeting is repaired by the lifecycle sweep', () => {
  it('⚠⚠ 2132522b — global `{}` + a confirmed-empty room: intervals close at the recorded leaves, the meeting ends idle_end, the session stops metering', async () => {
    const call = await seedStrandedCall();
    // Daily's session history recorded the two leaves the dropped webhooks never delivered.
    const expertLeave = plusMinutes(call.start, 3);
    const clientLeave = new Date(expertLeave.getTime() + 10_000);
    roomRead.leaves.set(call.expertClaim, expertLeave);
    roomRead.leaves.set(call.clientClaim, clientLeave);
    // The strand is real: the in-window batch cannot see it, and the session is still metered.
    expect(await meteredSessionIds()).toContain(call.sessionId);
    expect(await fakePresenceReader.getAllPresence()).toEqual({});

    // Two ticks is the bound: the reconciler close and the terminal rule share the FIRST tick.
    await runMeetingLifecycleSweep(call.strandedNow, noop, fakePresenceReader);
    await runMeetingLifecycleSweep(plusMinutes(call.strandedNow, 1), noop, fakePresenceReader);

    const meeting = await mustFindMeeting(call.meetingId);
    expect(meeting.status).toBe('ended');
    const [audit, ...rest] = await endedAudit(call.meetingId);
    expect(rest).toHaveLength(0);
    expect(audit?.metadata).toMatchObject({
      endedBy: 'system_idle',
      outcome: 'completed',
      terminalRule: 'idle_end',
    });

    // Both intervals closed WHERE THE PARTICIPANTS LEFT, not at the tick and not at the ceiling.
    expect(await leftAtInstants(call.meetingId)).toEqual([
      expertLeave.getTime(),
      clientLeave.getTime(),
    ]);
    // `ended_at` is the instant the idle rule became due: the latest leave plus the idle window.
    expect(meeting.endedAt?.getTime()).toBe(clientLeave.getTime() + TIMERS.idleEndEmptyMs);
    expect(meeting.endedAt?.getTime()).toBeLessThan(call.strandedNow.getTime());

    expect(await meteredSessionIds()).not.toContain(call.sessionId);
  });

  it('⚠ BAL-585 — the same shape with a per-room 404 ends overrun_stop on the FIRST stranded tick, `ended_at` = `left_at` = the ceiling', async () => {
    roomRead.mode = 'not_found';
    const call = await seedStrandedCall();
    expect(await meteredSessionIds()).toContain(call.sessionId);

    await runMeetingLifecycleSweep(call.strandedNow, noop, fakePresenceReader);

    const meeting = await mustFindMeeting(call.meetingId);
    expect(meeting.status).toBe('ended');
    const [audit] = await endedAudit(call.meetingId);
    expect(audit?.metadata).toMatchObject({
      endedBy: 'system_idle',
      outcome: 'completed',
      terminalRule: 'overrun_stop',
    });
    expect(meeting.endedAt?.getTime()).toBe(call.ceiling.getTime());
    expect(await leftAtInstants(call.meetingId)).toEqual([
      call.ceiling.getTime(),
      call.ceiling.getTime(),
    ]);
    expect(await meteredSessionIds()).not.toContain(call.sessionId);
  });

  /**
   * ⚠⚠ THE MONEY CASE. A pre-live strand (the client left before the expert arrived, the
   * expert's `left` webhook was dropped, and the meeting is past the lookback floor) has an open
   * interval that, closed at the TICK instant, would make the expert look present for ~24h, and
   * `abandoned_wait` would settle a `held` call on that span: an off-session charge for time
   * nobody spent on the call. The interval closes where Daily recorded the expert leaving, so the
   * settlement sees the true presence and never more.
   */
  it('⚠⚠ a pre-live strand closes at the expert’s recorded leave, ends abandoned_wait, and bills nothing beyond the true presence', async () => {
    const start = freshScheduledStart();
    const { parties, expertUserId, meetingId, roomName } = await seedVenueReadyMeeting(
      start,
      plusMinutes(start, BOOKED_WINDOW_MINUTES)
    );
    await fundWallet(parties);
    const clientClaim = dailyParticipantIdFor('user', parties.memberUserId);
    const expertClaim = dailyParticipantIdFor('user', expertUserId);
    await observe('open', meetingId, clientClaim, start);
    await observe('close', meetingId, clientClaim, plusMinutes(start, 1));
    const expertJoin = plusMinutes(start, 2);
    await observe('open', meetingId, expertClaim, expertJoin);
    expect((await mustFindMeeting(meetingId)).status).toBe('waiting_for_participants');
    // ⚠ THE DROPPED LEAVE: Daily's room empties, Balo is never told, but Daily's history knows.
    vendorRooms.set(roomName, new Set());
    const expertLeave = plusMinutes(start, 20);
    roomRead.leaves.set(expertClaim, expertLeave);

    // The floor is `now − LIFECYCLE_LOOKBACK_MS`, so this tick puts the start one minute below it.
    const tick = plusMinutes(new Date(start.getTime() + LIFECYCLE_LOOKBACK_MS), 1);
    await runMeetingLifecycleSweep(tick, noop, fakePresenceReader);

    const meeting = await mustFindMeeting(meetingId);
    expect(meeting.status).toBe('ended');
    const [audit] = await endedAudit(meetingId);
    expect(audit?.metadata).toMatchObject({ terminalRule: 'abandoned_wait' });
    expect(await leftAtInstants(meetingId)).toContain(expertLeave.getTime());
    expect(meeting.endedAt?.getTime()).toBe(expertLeave.getTime() + TIMERS.idleEndEmptyMs);
    expect(meeting.endedAt?.getTime()).toBeLessThan(tick.getTime());

    // THE MONEY: the settlement is a `held` call over the expert's TRUE 18-minute span. Closing
    // at the tick would have read ~24h, capped at `maxBillableMinutes` (240): 13x the charge.
    const trueExpertMinutes = (expertLeave.getTime() - expertJoin.getTime()) / MS_PER_MINUTE;
    expect(trueExpertMinutes).toBe(18);
    const sessions = await db
      .select()
      .from(creditSessions)
      .where(eq(creditSessions.meetingId, meetingId));
    expect(sessions).toHaveLength(1);
    const [session] = sessions;
    expect(session).toMatchObject({
      settlementShape: 'held',
      connectedMinutes: trueExpertMinutes,
      expertAccruedMinor: trueExpertMinutes * EXPERT_RATE,
    });
    const consumed = await db
      .select({ amountMinor: creditLedger.amountMinor })
      .from(creditLedger)
      .where(
        and(
          eq(creditLedger.sessionId, session?.id ?? ''),
          eq(creditLedger.reason, 'session_consume')
        )
      );
    expect(consumed).toHaveLength(trueExpertMinutes);
    expect(consumed.reduce((total, row) => total + row.amountMinor, 0)).toBe(
      -trueExpertMinutes * CLIENT_RATE
    );
  });

  /**
   * ⚠⚠ A pre-live strand whose recorded leave is RECENT: the first stranded tick closes the
   * expert's interval at that leave, but `abandoned_wait` is not due until the idle window after
   * it has elapsed. With nothing open the meeting must STAY SELECTED, or no later tick would ever
   * reach the terminal rule and it would sit in `waiting_for_participants` forever.
   */
  it('⚠⚠ a pre-live strand whose recorded leave is recent stays selected with nothing open until abandoned_wait falls due', async () => {
    const start = freshScheduledStart();
    const { expertUserId, meetingId, parties, roomName } = await seedVenueReadyMeeting(
      start,
      plusMinutes(start, BOOKED_WINDOW_MINUTES)
    );
    const clientClaim = dailyParticipantIdFor('user', parties.memberUserId);
    const expertClaim = dailyParticipantIdFor('user', expertUserId);
    await observe('open', meetingId, clientClaim, start);
    await observe('close', meetingId, clientClaim, plusMinutes(start, 1));
    await observe('open', meetingId, expertClaim, plusMinutes(start, 2));
    expect((await mustFindMeeting(meetingId)).status).toBe('waiting_for_participants');
    // ⚠ THE DROPPED LEAVE: the room is confirmed empty, and Daily's history dates the leave one
    // minute before the first tick.
    vendorRooms.set(roomName, new Set());
    const firstTick = plusMinutes(new Date(start.getTime() + LIFECYCLE_LOOKBACK_MS), 1);
    const expertLeave = plusMinutes(firstTick, -1);
    roomRead.leaves.set(expertClaim, expertLeave);
    const abandonedDue = expertLeave.getTime() + TIMERS.idleEndEmptyMs;
    expect(abandonedDue).toBeGreaterThan(firstTick.getTime());

    await runMeetingLifecycleSweep(firstTick, noop, fakePresenceReader);

    expect(await leftAtInstants(meetingId)).toContain(expertLeave.getTime());
    expect((await mustFindMeeting(meetingId)).status).toBe('waiting_for_participants');

    // Nothing is open now, and the meeting is still the stranded arm's to decide.
    const nextTick = plusMinutes(firstTick, 1);
    expect(nextTick.getTime()).toBeLessThan(abandonedDue);
    const candidates = await meetingsRepository.listStrandedLifecycleCandidates({
      scheduledStartBefore: new Date(nextTick.getTime() - LIFECYCLE_LOOKBACK_MS),
      limit: 50,
    });
    expect(candidates.map((candidate) => candidate.id)).toContain(meetingId);
    await runMeetingLifecycleSweep(nextTick, noop, fakePresenceReader);
    expect((await mustFindMeeting(meetingId)).status).toBe('waiting_for_participants');

    await runMeetingLifecycleSweep(
      new Date(abandonedDue + MS_PER_MINUTE),
      noop,
      fakePresenceReader
    );

    const meeting = await mustFindMeeting(meetingId);
    expect(meeting.status).toBe('ended');
    const [audit] = await endedAudit(meetingId);
    expect(audit?.metadata).toMatchObject({ terminalRule: 'abandoned_wait' });
    expect(meeting.endedAt?.getTime()).toBe(abandonedDue);
  });
});

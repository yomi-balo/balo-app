import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * BAL-649 (ADR-1058, ADR-1044, ADR-1049) — INVARIANT, END TO END AGAINST A REAL POSTGRES: a Call now
 * ring that is never answered — it expires, the callee declines, or the caller stops — bills NOBODY,
 * however long the expert sat in the room while it rang. No session opens, no ledger row posts, and
 * no client no-show can settle, because the meeting never had a client-side party to be absent.
 *
 * ── WHAT IS DRIVEN ──────────────────────────────────────────────────────────────────────
 *
 *   · the ring row — `meetingRingsRepository.startWithNewMeeting` (the `new_meeting` placement:
 *     the case meeting is created in the same transaction, `scheduled_start = now`);
 *   · presence — the Daily webhook's three phases: `resolvePresenceEffect` → `applyPresenceEffect`
 *     → `reconcileMeetingStatus`;
 *   · the terminal write — `endRing` (the service, so the post-commit tail runs too), the
 *     per-minute `runMeetingLifecycleSweep` when the expiry job was lost, or a human End's own
 *     write (`meetingsRepository.endMeeting`, `outcome: null`) landing while the ring still rang;
 *   · the money paths that could wrongly bill it — `settleSessionlessCaseMeeting`,
 *     `creditSessionsRepository.findSessionlessEndedCaseMeetings` and `runSessionMeterSweep`.
 *
 * ── MOCKS (and only these) ──────────────────────────────────────────────────────────────
 *
 *   · `../lib/queue.js` `getQueue` — BullMQ would open a live Redis connection;
 *   · `dailyRoomTeardown.deleteRoom` — a vendor call;
 *   · the Stripe provider's `createOffSessionCharge` — it rejects loudly if ever reached;
 *   · `raiseAdminAlert` — a spy; a refused or exhausted open would alarm.
 * `@balo/db` stays REAL.
 *
 * ── THE HARNESS ─────────────────────────────────────────────────────────────────────────
 *
 * Runs from `packages/db/vitest.config.integration.ts`; every test is one rolled-back transaction
 * on a `max: 1` pool, so `created_at` is shared by every row a test writes and a caught `23505`
 * would abort the transaction.
 *
 * ⚠ NO CALENDAR LITERALS. Every instant derives from a minute-aligned start taken from the real
 * clock an hour ago, so the suite stays green on any future calendar day.
 *
 * ⚠ THE EXPERT SITS ALONE FOR 20 MINUTES — past the 15-minute floor. That is what turns a
 * wrongly-applied `no_show_client` rule from a zero into a floor-sized charge.
 */

// ── Mocks (and only these). `@balo/db` MUST stay real. ──────────────────────────────────

const {
  vendorRooms,
  mockDeleteRoom,
  mockGetQueue,
  mockRaiseAdminAlert,
  mockCreateOffSessionCharge,
} = vi.hoisted(() => {
  const rooms = new Map<string, Set<string>>();
  const add = vi.fn().mockResolvedValue({ id: 'test-job' });
  return {
    vendorRooms: rooms,
    mockDeleteRoom: vi.fn(async (name: string): Promise<'deleted'> => {
      rooms.delete(name);
      return 'deleted';
    }),
    mockGetQueue: vi.fn(() => ({ add })),
    mockRaiseAdminAlert: vi.fn(async (): Promise<void> => undefined),
    mockCreateOffSessionCharge: vi.fn(async (): Promise<never> => {
      throw new Error('Stripe is not reachable from this suite — no test wallet holds a mandate');
    }),
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
  createOffSessionCharge: mockCreateOffSessionCharge,
}));
vi.mock('../services/admin-alerts/raise.js', () => ({ raiseAdminAlert: mockRaiseAdminAlert }));

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
  meetingRingsRepository,
  meetings,
  meetingsRepository,
  type AuditEvent,
  type Meeting,
} from '@balo/db';
import {
  CALL_NOW_RING_MS,
  CALL_NOW_SCHEDULED_MINUTES,
  dailyParticipantIdFor,
  dailyRoomNameForMeeting,
} from '@balo/shared/meetings';
import { runSessionMeterSweep } from '../jobs/credit-session-meter-sweep.js';
import { runMeetingLifecycleSweep } from '../jobs/meeting-lifecycle-sweep.js';
import { endRing } from '../services/call-now/end-ring.js';
import { settleSessionlessCaseMeeting } from '../services/credit-session/settle-sessionless-case-meeting.js';
import type { PresenceReader } from '../services/daily/rooms.js';
import {
  applyPresenceEffect,
  reconcileMeetingStatus,
  resolvePresenceEffect,
  type PresenceAction,
} from '../services/meetings/presence-writer.js';
import { seedBookingParties, type BookingParties } from '../test/fixtures/booking-graph.js';

// ── Constants ────────────────────────────────────────────────────────────────────────

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
/** The expert sits in the room this long — comfortably past the 15-minute billing floor. */
const EXPERT_ALONE_MINUTES = 20;
/** How long before its start a fixture meeting's room became ready — any value > 0 will do. */
const ROOM_LEAD_MINUTES = 60;
const EXPERT_RATE_MINOR_PER_MINUTE = 560;
const FUNDED_BALANCE_MINOR = 50_000;
const FINDER_WINDOW_HOURS = 72;

const TERMINAL_STATUSES = ['unanswered', 'declined', 'stopped'] as const;
type RingTerminalStatus = (typeof TERMINAL_STATUSES)[number];

const noop = (): void => {};

/** The vendor roster, mirroring every join/leave this file reports (see the sibling no-show suite). */
const fakePresenceReader: PresenceReader = {
  getAllPresence: async () =>
    Object.fromEntries(
      [...vendorRooms.entries()]
        .filter(([, participants]) => participants.size > 0)
        .map(([room, participants]) => [room, [...participants].map((userId) => ({ userId }))])
    ),
  getRoomPresence: async (roomName) =>
    [...(vendorRooms.get(roomName) ?? [])].map((userId) => ({ userId })),
  getRoomSessionLeaves: async () => ({ leaves: new Map(), visits: [] }),
};

// ── Time ─────────────────────────────────────────────────────────────────────────────

/** A minute-aligned instant an hour before the real clock. Never a calendar literal. */
function freshRingStart(): Date {
  const minute = Math.floor(Date.now() / MS_PER_MINUTE) * MS_PER_MINUTE;
  return new Date(minute - MS_PER_HOUR);
}

function plusMinutes(instant: Date, minutes: number): Date {
  return new Date(instant.getTime() + minutes * MS_PER_MINUTE);
}

// ── Fixture ──────────────────────────────────────────────────────────────────────────

interface Scenario {
  readonly parties: BookingParties;
  /** The client member who rings — the caller. */
  readonly callerUserId: string;
  /** The delivering expert's user — the callee. */
  readonly expertUserId: string;
}

async function seedScenario(): Promise<Scenario> {
  const parties = await seedBookingParties();
  await expertsRepository.updateProfile(parties.expertProfileId, {
    rateCents: EXPERT_RATE_MINOR_PER_MINUTE,
  });
  const expert = await expertsRepository.findUserIdByProfileId(parties.expertProfileId);
  if (expert === undefined) {
    throw new Error('fixture: the seeded expert profile resolves no user');
  }
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
  return { parties, callerUserId: parties.memberUserId, expertUserId: expert.user.id };
}

/**
 * ONE `new_meeting` ring, started by the client member against the delivering expert, through the
 * repository's one write seam. The meeting window is the 15-minute floor, `scheduled_start = start`.
 * Returns the ring's and the created meeting's ids with the room name provisioned (the call-now
 * service provisions it after commit; this fixture does the same through `setVenue`).
 */
async function startUnansweredCandidate(
  scenario: Scenario,
  start: Date
): Promise<{ readonly ringId: string; readonly meetingId: string; readonly roomName: string }> {
  const started = await meetingRingsRepository.startWithNewMeeting({
    engagementId: scenario.parties.caseEngagementId,
    callerUserId: scenario.callerUserId,
    calleeUserId: scenario.expertUserId,
    callerSide: 'client',
    reachedBy: 'app',
    expiresAt: new Date(start.getTime() + CALL_NOW_RING_MS),
    now: start,
    scheduledStart: start,
    scheduledEnd: plusMinutes(start, CALL_NOW_SCHEDULED_MINUTES),
  });
  const meetingId = started.meeting.id;
  const roomName = dailyRoomNameForMeeting(meetingId);
  await meetingsRepository.setVenue(meetingId, {
    dailyRoomName: roomName,
    joinUrl: `https://balo.daily.co/${roomName}`,
  });
  // `setVenue` stamps the real clock, which is after this fixture's back-dated start; a room
  // provisioned with the call is ready before it, so backdate the stamp to match.
  await db
    .update(meetings)
    .set({ venueProvisionedAt: plusMinutes(start, -ROOM_LEAD_MINUTES) })
    .where(eq(meetings.id, meetingId));
  return { ringId: started.ring.id, meetingId, roomName };
}

// ── Production seams ─────────────────────────────────────────────────────────────────

async function mustFindMeeting(meetingId: string): Promise<Meeting> {
  const meeting = await meetingsRepository.findById(meetingId);
  if (meeting === undefined) {
    throw new Error(`fixture: meeting ${meetingId} not found`);
  }
  return meeting;
}

/** ONE Daily presence observation, the way `routes/daily/webhook.ts` applies it. */
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

function joined(meetingId: string, participantId: string, at: Date): Promise<void> {
  return observe('open', meetingId, participantId, at);
}

function asUser(userId: string): string {
  return dailyParticipantIdFor('user', userId);
}

// ── Reads ────────────────────────────────────────────────────────────────────────────

async function sessionsFor(meetingId: string): Promise<Array<{ id: string }>> {
  const rows = await db
    .select({ id: creditSessions.id, deletedAt: creditSessions.deletedAt })
    .from(creditSessions)
    .where(eq(creditSessions.meetingId, meetingId));
  return rows.filter((row) => row.deletedAt === null);
}

/** Every ledger row the wallet holds that is NOT the fixture's top-up — i.e. anything a call posted. */
async function postedLedgerRows(companyId: string): Promise<Array<{ reason: string }>> {
  const wallet = await creditWalletsRepository.findByCompanyId(companyId);
  if (wallet === undefined) {
    throw new Error('fixture: the funded wallet vanished');
  }
  const rows = await db
    .select({ reason: creditLedger.reason })
    .from(creditLedger)
    .where(eq(creditLedger.walletId, wallet.id));
  return rows.filter((row) => row.reason !== 'manual_purchase');
}

async function walletBalance(companyId: string): Promise<number | undefined> {
  return (await creditWalletsRepository.findByCompanyId(companyId))?.balanceMinor;
}

async function auditRows(
  entityType: string,
  entityId: string,
  action: string
): Promise<AuditEvent[]> {
  return db
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.entityType, entityType),
        eq(auditEvents.entityId, entityId),
        eq(auditEvents.action, action)
      )
    );
}

/** The sessionless finder, over a window wide enough to contain every meeting this file creates. */
async function sessionlessCandidateIds(start: Date, endedBefore: Date): Promise<string[]> {
  const found = await creditSessionsRepository.findSessionlessEndedCaseMeetings({
    endedBefore,
    windowStart: new Date(start.getTime() - FINDER_WINDOW_HOURS * MS_PER_HOUR),
  });
  return found.map((candidate) => candidate.meetingId);
}

/** WHICH terminal path ended the meeting, read from its one `meeting.ended` audit row. */
async function expectEndedAsNoAnswer(meetingId: string): Promise<void> {
  const meeting = await mustFindMeeting(meetingId);
  expect(meeting.status).toBe('ended');
  expect(meeting.outcome).toBe('no_answer');
  const ended = await auditRows('meeting', meetingId, 'meeting.ended');
  expect(ended).toHaveLength(1);
  expect(ended[0]?.metadata).toMatchObject({ endedBy: 'system_idle', outcome: 'no_answer' });
}

/** Nothing was opened, posted, owed or alarmed — the whole money surface for this meeting is empty. */
async function expectNothingBilled(scenario: Scenario, meetingId: string): Promise<void> {
  expect(await sessionsFor(meetingId)).toHaveLength(0);
  expect(await postedLedgerRows(scenario.parties.companyId)).toEqual([]);
  expect(await walletBalance(scenario.parties.companyId)).toBe(FUNDED_BALANCE_MINOR);
  expect(
    await auditRows('meeting', meetingId, 'credit_session.sessionless_meeting_marked')
  ).toEqual([]);
  expect(mockRaiseAdminAlert).not.toHaveBeenCalled();
  expect(mockCreateOffSessionCharge).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  vendorRooms.clear();
});

// ── The cases ────────────────────────────────────────────────────────────────────────

describe('INVARIANT (end-to-end): an unanswered Call now ring never bills', () => {
  it.each(TERMINAL_STATUSES)(
    '⚠ a ring ended %s with the expert alone past the floor opens no session and posts nothing',
    async (to: RingTerminalStatus) => {
      const scenario = await seedScenario();
      const start = freshRingStart();
      const { ringId, meetingId } = await startUnansweredCandidate(scenario, start);

      // The expert waits in the room from the moment the ring starts, and no client-side party ever comes.
      await joined(meetingId, asUser(scenario.expertUserId), start);
      expect((await mustFindMeeting(meetingId)).status).toBe('scheduled');

      const endAt = plusMinutes(start, EXPERT_ALONE_MINUTES);
      const outcome = await endRing({
        ringId,
        to,
        actorUserId: to === 'unanswered' ? null : scenario.callerUserId,
        now: endAt,
      });
      expect(outcome).toMatchObject({ ended: true, status: to });
      await expectEndedAsNoAnswer(meetingId);

      const settled = await settleSessionlessCaseMeeting({
        meetingId,
        trigger: 'backstop',
        actorUserId: null,
        now: plusMinutes(endAt, 5),
      });
      expect(settled).toEqual({ kind: 'not_billable', reason: 'no_answer' });

      expect(await sessionlessCandidateIds(start, plusMinutes(endAt, 10))).not.toContain(meetingId);
      await expectNothingBilled(scenario, meetingId);
    }
  );

  it('control: the same finder window DOES list a sessionless no-show meeting', async () => {
    const scenario = await seedScenario();
    const start = freshRingStart();
    const { ringId, meetingId: ringMeetingId } = await startUnansweredCandidate(scenario, start);
    await endRing({
      ringId,
      to: 'unanswered',
      actorUserId: null,
      now: plusMinutes(start, EXPERT_ALONE_MINUTES),
    });

    // A booked case meeting that ended as a client no-show and was never settled.
    const { meeting: noShow } = await meetingsRepository.create({
      scheduledStart: start,
      scheduledEnd: plusMinutes(start, 30),
      contexts: [{ contextType: 'case', contextId: scenario.parties.caseEngagementId }],
      actorUserId: scenario.callerUserId,
    });
    const ended = await meetingsRepository.endMeeting({
      id: noShow.id,
      outcome: 'no_show_client',
      endedBy: 'system_idle',
      endedAt: plusMinutes(start, EXPERT_ALONE_MINUTES),
      actorUserId: null,
    });
    expect(ended?.meeting.status).toBe('ended');

    const found = await sessionlessCandidateIds(
      start,
      plusMinutes(start, EXPERT_ALONE_MINUTES + 10)
    );
    expect(found).toContain(noShow.id);
    expect(found).not.toContain(ringMeetingId);
  });

  it('⚠ a lost expiry job: the lifecycle sweep ends the unanswered ring as no_answer, never as a client no-show', async () => {
    const scenario = await seedScenario();
    const start = freshRingStart();
    const { meetingId } = await startUnansweredCandidate(scenario, start);
    await joined(meetingId, asUser(scenario.expertUserId), start);

    // No `endRing` runs (the delayed job was lost). The first sweep tick lands 20 minutes in — past
    // the no_show rule's floor and long after the ring's window.
    const tickAt = plusMinutes(start, EXPERT_ALONE_MINUTES);
    await runMeetingLifecycleSweep(tickAt, noop, fakePresenceReader);
    await expectEndedAsNoAnswer(meetingId);

    await runMeetingLifecycleSweep(plusMinutes(tickAt, 1), noop, fakePresenceReader);
    await runSessionMeterSweep(plusMinutes(tickAt, 5));

    expect(await sessionlessCandidateIds(start, plusMinutes(tickAt, 10))).not.toContain(meetingId);
    await expectNothingBilled(scenario, meetingId);
  });

  it('⚠ a human End lands while the ring still rings (outcome NULL, 20 minutes in): the ring rows alone keep it unbillable', async () => {
    const scenario = await seedScenario();
    const start = freshRingStart();
    const { meetingId } = await startUnansweredCandidate(scenario, start);
    await joined(meetingId, asUser(scenario.expertUserId), start);

    // The End's own write, past the floor, with the ring row still `ringing`: the meeting carries no
    // `no_answer` outcome, so only the ring facts can say nobody ever answered.
    const endAt = plusMinutes(start, EXPERT_ALONE_MINUTES);
    const ended = await meetingsRepository.endMeeting({
      id: meetingId,
      outcome: null,
      endedBy: 'expert_host',
      endedAt: endAt,
      actorUserId: scenario.expertUserId,
    });
    expect(ended?.meeting).toMatchObject({ status: 'ended', outcome: null });

    const settled = await settleSessionlessCaseMeeting({
      meetingId,
      trigger: 'human_end',
      actorUserId: scenario.expertUserId,
      now: endAt,
    });
    expect(settled).toEqual({ kind: 'not_billable', reason: 'no_answer' });

    await runSessionMeterSweep(plusMinutes(endAt, 30));
    await expectNothingBilled(scenario, meetingId);
  });

  it('⚠ idempotent: ending an already-ended ring a second time changes nothing and bills nothing', async () => {
    const scenario = await seedScenario();
    const start = freshRingStart();
    const { ringId, meetingId } = await startUnansweredCandidate(scenario, start);
    await joined(meetingId, asUser(scenario.expertUserId), start);

    const endAt = plusMinutes(start, EXPERT_ALONE_MINUTES);
    await endRing({ ringId, to: 'unanswered', actorUserId: null, now: endAt });
    const again = await endRing({
      ringId,
      to: 'stopped',
      actorUserId: scenario.callerUserId,
      now: plusMinutes(endAt, 1),
    });

    expect(again).toMatchObject({ ended: false, status: 'unanswered' });
    await expectEndedAsNoAnswer(meetingId);
    await expectNothingBilled(scenario, meetingId);
  });
});

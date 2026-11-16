import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * BAL-649 (ADR-1058, ADR-1044 "alone before the start never bills", ADR-1052) — INVARIANT, END TO
 * END AGAINST A REAL POSTGRES: a Call now ring that CONNECTS bills from the instant both parties
 * are first present, never from the instant the ring started. The expert who sat in the room while
 * the ring was ringing is not paid for those seconds; the meeting's start moves to the connect
 * instant, and a short call settles at the 15-minute floor like any other.
 *
 * ── THE SCENARIO ────────────────────────────────────────────────────────────────────────
 *
 *   T         the client rings; the expert is already in the room (an open expert interval)
 *   T + 30 s  the client-side party is first present → co-presence → the ring connects, in one
 *             transaction the meeting moves its start to T + 30 s and goes `in_progress`
 *   T + 5.5 m the expert ends the call, five minutes after the moved start
 *
 * Asserted: the start moved (`scheduled_start = started_at = T + 30 s`, the window keeps its
 * length), `settlementFacts` over the MOVED start reports no together-time before it and an
 * expert from-start figure of exactly five minutes — the 30 seconds are excluded — and the
 * session settles `held` at the floor, FLOOR consume rows at the client rate.
 *
 * ── WHAT IS DRIVEN ──────────────────────────────────────────────────────────────────────
 *
 *   · `meetingRingsRepository.startWithNewMeeting` — the ring and its meeting;
 *   · presence — `resolvePresenceEffect` → `applyPresenceEffect` → `reconcileMeetingStatus`, whose
 *     co-presence branch is what connects the ring (and then starts billing on the moved meeting);
 *   · the human End — `endMeeting`, which settles through the production sessionless/presence paths.
 *
 * ── MOCKS (and only these) ──────────────────────────────────────────────────────────────
 *
 *   · `../lib/queue.js` `getQueue` — BullMQ would open a live Redis connection;
 *   · `dailyRoomTeardown.deleteRoom` — a vendor call;
 *   · the Stripe provider's `createOffSessionCharge` — never reached: the wallet is funded;
 *   · `raiseAdminAlert` — a spy; a refused open would alarm.
 * `@balo/db` stays REAL. The harness is the sibling no-show suite's (one rolled-back transaction).
 *
 * ⚠ NO CALENDAR LITERALS. Every instant derives from a minute-aligned start an hour before the
 * real clock.
 *
 * ⚠ RATES ARE DERIVED. The open passes no `baloFeeBps`, so the session is priced at the default fee;
 * `deriveSessionEstimate` turns the fixture's expert rate into the per-minute rates asserted below.
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
      throw new Error('Stripe is not reachable from this suite — the wallet is funded');
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
  creditLedger,
  creditLedgerRepository,
  creditSessions,
  creditWalletsRepository,
  db,
  deriveIdempotencyKey,
  eq,
  expertsRepository,
  meetingPresenceRepository,
  meetingRingsRepository,
  meetings,
  meetingsRepository,
  type CreditSession,
  type Meeting,
} from '@balo/db';
import { deriveSessionEstimate } from '@balo/shared/credit';
import {
  CALL_NOW_RING_MS,
  CALL_NOW_SCHEDULED_MINUTES,
  dailyParticipantIdFor,
  dailyRoomNameForMeeting,
} from '@balo/shared/meetings';
import { resolveBillingFloorMinutes } from '../config/billing-floor.js';
import { endMeeting } from '../services/meetings/end-meeting.js';
import {
  applyPresenceEffect,
  reconcileMeetingStatus,
  resolvePresenceEffect,
  type PresenceAction,
} from '../services/meetings/presence-writer.js';
import { seedBookingParties, type BookingParties } from '../test/fixtures/booking-graph.js';

// ── Constants — every one DERIVED ────────────────────────────────────────────────────

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const ROOM_LEAD_MINUTES = 60;
/** THE floor, from the same resolver the settlement path snapshots. */
const FLOOR = resolveBillingFloorMinutes();
/** The client-side party arrives this long after the expert — inside the ring window (asserted below). */
const ANSWER_DELAY_MS = 30_000;
/** The call runs this long from the moved start — deliberately shorter than the floor. */
const CALL_MINUTES = 5;

const EXPERT_RATE_MINOR_PER_MINUTE = 560;
const { clientRateMinorPerMinute: CLIENT_RATE, expertRateMinorPerMinute: EXPERT_RATE } =
  deriveSessionEstimate({
    expertRateMinorPerMinute: EXPERT_RATE_MINOR_PER_MINUTE,
    estimatedMinutes: 1,
  });
const FUNDED_BALANCE_MINOR = 50_000;

// ── Time ─────────────────────────────────────────────────────────────────────────────

/** A minute-aligned instant an hour before the real clock. Never a calendar literal. */
function freshRingStart(): Date {
  const minute = Math.floor(Date.now() / MS_PER_MINUTE) * MS_PER_MINUTE;
  return new Date(minute - MS_PER_HOUR);
}

function plusMs(instant: Date, ms: number): Date {
  return new Date(instant.getTime() + ms);
}

function plusMinutes(instant: Date, minutes: number): Date {
  return plusMs(instant, minutes * MS_PER_MINUTE);
}

// ── Fixture ──────────────────────────────────────────────────────────────────────────

interface Scenario {
  readonly parties: BookingParties;
  /** The client member who rings (and, being the booker, the on-behalf attribution). */
  readonly callerUserId: string;
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

/** A `new_meeting` ring from the client member, with its room provisioned. */
async function startRing(
  scenario: Scenario,
  start: Date
): Promise<{ readonly ringId: string; readonly meetingId: string }> {
  const started = await meetingRingsRepository.startWithNewMeeting({
    engagementId: scenario.parties.caseEngagementId,
    callerUserId: scenario.callerUserId,
    calleeUserId: scenario.expertUserId,
    callerSide: 'client',
    reachedBy: 'app',
    expiresAt: plusMs(start, CALL_NOW_RING_MS),
    scheduledStart: start,
    scheduledEnd: plusMinutes(start, CALL_NOW_SCHEDULED_MINUTES),
  });
  const meetingId = started.meeting.id;
  const roomName = dailyRoomNameForMeeting(meetingId);
  await meetingsRepository.setVenue(meetingId, {
    dailyRoomName: roomName,
    joinUrl: `https://balo.daily.co/${roomName}`,
  });
  // The room is ready before the call's start; `setVenue` stamps the real clock, so backdate it.
  await db
    .update(meetings)
    .set({ venueProvisionedAt: plusMinutes(start, -ROOM_LEAD_MINUTES) })
    .where(eq(meetings.id, meetingId));
  return { ringId: started.ring.id, meetingId };
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

async function theOnlySession(meetingId: string): Promise<CreditSession> {
  const rows = await db
    .select()
    .from(creditSessions)
    .where(eq(creditSessions.meetingId, meetingId));
  const sessions = rows.filter((row) => row.deletedAt === null);
  expect(sessions).toHaveLength(1);
  const [only] = sessions;
  if (only === undefined) {
    throw new Error('unreachable: exactly one session asserted above');
  }
  return only;
}

async function consumeRows(sessionId: string): Promise<Array<{ amountMinor: number }>> {
  return db
    .select({ amountMinor: creditLedger.amountMinor })
    .from(creditLedger)
    .where(and(eq(creditLedger.sessionId, sessionId), eq(creditLedger.reason, 'session_consume')));
}

function sumMinor(rows: ReadonlyArray<{ amountMinor: number }>): number {
  return rows.reduce((total, row) => total + row.amountMinor, 0);
}

beforeEach(() => {
  vi.clearAllMocks();
  vendorRooms.clear();
});

// ── The cases ────────────────────────────────────────────────────────────────────────

describe('INVARIANT (end-to-end): a connected Call now ring bills from co-presence', () => {
  it('⚠ the start moves to the connect instant, the 30 s the expert waited is excluded, and the short call settles at the floor', async () => {
    const scenario = await seedScenario();
    const ringStart = freshRingStart();
    const connectAt = plusMs(ringStart, ANSWER_DELAY_MS);
    const endAt = plusMinutes(connectAt, CALL_MINUTES);
    const { ringId, meetingId } = await startRing(scenario, ringStart);
    expect(ANSWER_DELAY_MS).toBeLessThan(CALL_NOW_RING_MS);
    const originalWindowMs = CALL_NOW_SCHEDULED_MINUTES * MS_PER_MINUTE;

    // The expert is in the room from the ring's start, alone while it rings: no transition yet.
    await joined(meetingId, asUser(scenario.expertUserId), ringStart);
    const waiting = await mustFindMeeting(meetingId);
    expect(waiting.status).toBe('scheduled');
    expect((await meetingRingsRepository.findById(ringId))?.status).toBe('ringing');

    // The client-side party arrives inside the ring window: co-presence connects the ring.
    await joined(meetingId, asUser(scenario.callerUserId), connectAt);

    const connected = await mustFindMeeting(meetingId);
    expect(connected.status).toBe('in_progress');
    expect(connected.scheduledStart).toEqual(connectAt);
    expect(connected.startedAt).toEqual(connectAt);
    expect(connected.scheduledEnd.getTime() - connected.scheduledStart.getTime()).toBe(
      originalWindowMs
    );
    expect((await meetingRingsRepository.findById(ringId))?.status).toBe('connected');

    // The expert ends the call, five minutes after the moved start.
    const ended = await endMeeting({ meetingId, userId: scenario.expertUserId, now: endAt });
    expect(ended).toMatchObject({ ok: true, alreadyEnded: false });

    // Rule A over the MOVED start: nobody was together before it, and the expert's from-start
    // figure begins at the connect instant — the 30 s of waiting is not in it.
    const facts = await meetingPresenceRepository.settlementFacts(meetingId, {
      scheduledStart: connected.scheduledStart,
      now: endAt,
    });
    expect(facts.togetherBeforeStartMs).toBe(0);
    expect(facts.expertPresentFromStartMs).toBe(CALL_MINUTES * MS_PER_MINUTE);

    // Control: over the ORIGINAL start the expert's figure would include the 30 s — so the
    // assertion above can only pass because the start moved.
    const fromRingStart = await meetingPresenceRepository.settlementFacts(meetingId, {
      scheduledStart: ringStart,
      now: endAt,
    });
    expect(fromRingStart.expertPresentFromStartMs).toBe(
      CALL_MINUTES * MS_PER_MINUTE + ANSWER_DELAY_MS
    );

    // A five-minute call is held at the floor, billed at the client rate and accrued at the expert rate.
    const session = await theOnlySession(meetingId);
    expect(session.settlementShape).toBe('held');
    expect(session.connectedMinutes).toBe(FLOOR);
    const consumed = await consumeRows(session.id);
    expect(consumed).toHaveLength(FLOOR);
    expect(sumMinor(consumed)).toBe(-FLOOR * CLIENT_RATE);
    expect(session.expertAccruedMinor).toBe(FLOOR * EXPERT_RATE);
    expect(mockRaiseAdminAlert).not.toHaveBeenCalled();
    expect(mockCreateOffSessionCharge).not.toHaveBeenCalled();
  });
});

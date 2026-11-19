import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * BAL-650 (ADR-1058, ADR-1040 Amendment 8 §B, ADR-1044, ADR-1049) — INVARIANT, END TO END AGAINST A
 * REAL POSTGRES: a Call now ring that never connects consumes NOTHING, on both placements and for
 * every way a ring can end without a connect; a Call now ring that connects bills exactly as the
 * same consultation booked ordinarily would.
 *
 * ── THE MATRIX ──────────────────────────────────────────────────────────────────────────
 *
 *   NEVER CONNECTS — placement × caller × end:
 *     P1  `new_meeting`, the CLIENT rings. The client is admitted through `joinMeetingAsMember` and is
 *         present while the expert never arrives.
 *     P2  `new_meeting`, the EXPERT rings. The expert sits in the room for 20 minutes and the booker's
 *         plain join is HELD (`call_answer_required`, no token) — an expert-started ring is entered only
 *         through the client's commit step.
 *     P3  `in_place`, the CLIENT rings on a booking four hours away. The client is admitted by the ring
 *         exception to the join window.
 *     × `unanswered` (expiry), `declined` (the callee), `stopped` (the caller).
 *   Each asserts: no `credit_sessions` row in ANY status (no pending session either), no ledger row
 *   beyond the fixture's top-up, the balance unchanged, no receivable, no payout accrual, no no-show /
 *   missed / abandoned outcome, nothing the Stripe provider or the alert spy was asked to do, no
 *   `meeting.rescheduled`. P1/P2 add `settleSessionlessCaseMeeting` → `not_billable/no_answer`. P3 adds
 *   the booking row, its calendar rows and the reservable set unchanged.
 *
 *   CONNECTS — C1 (`new_meeting`, client rings), C2 (`new_meeting`, expert rings; the booker commits
 *   with `answeringRingId`), C3 (`in_place`), each at N = 20 and N = 5 together-minutes after the connect,
 *   each beside a TWIN: a second company's ordinary booked consultation with the same expert rate, the
 *   same window length and the same together-minutes from its start. The billing fingerprints must be
 *   equal. C2 also runs at zero balance with no mandate against a zero-balance twin: equal receivables
 *   prove the overdraft-tolerant open at connect.
 *
 * ── WHAT IS DRIVEN ──────────────────────────────────────────────────────────────────────
 *
 *   · the ring rows — `meetingRingsRepository.startWithNewMeeting` / `startOnMeeting`;
 *   · admission — `joinMeetingAsMember` with a token-counting minter;
 *   · presence — `resolvePresenceEffect` → `applyPresenceEffect` → `reconcileMeetingStatus`, whose
 *     co-presence branch connects the ring and starts billing;
 *   · the ring ends — `endRing` (the service, so the post-commit tail runs);
 *   · the money paths — `settleSessionlessCaseMeeting`, `findSessionlessEndedCaseMeetings`, `endMeeting`.
 *
 * ── MOCKS (and only these) ──────────────────────────────────────────────────────────────
 *
 *   · `../lib/queue.js` `getQueue` — BullMQ would open a live Redis connection;
 *   · `dailyRoomTeardown.deleteRoom` and `dailyParticipantEjector.ejectParticipants` — vendor calls;
 *   · the Stripe provider's `createOffSessionCharge` — it rejects loudly if ever reached;
 *   · `raiseAdminAlert` — a spy.
 * `@balo/db` stays REAL. The harness is the sibling suites': one rolled-back transaction per test.
 *
 * ⚠ THE CLOCK. `joinMeetingAsMember` reads `new Date()` for its liveness check, so `Date` alone is faked
 * and pinned to the instant each step is simulated at. Timers stay real (the DB driver needs them).
 *
 * ⚠ NO CALENDAR LITERALS. Every instant derives from a minute-aligned start an hour before the real
 * clock.
 */

// ── Mocks (and only these). `@balo/db` MUST stay real. ──────────────────────────────────

const {
  vendorRooms,
  mockQueueAdd,
  mockDeleteRoom,
  mockEjectParticipants,
  mockGetQueue,
  mockRaiseAdminAlert,
  mockCreateOffSessionCharge,
} = vi.hoisted(() => {
  const rooms = new Map<string, Set<string>>();
  const add = vi.fn().mockResolvedValue({ id: 'test-job' });
  return {
    vendorRooms: rooms,
    mockQueueAdd: add,
    mockDeleteRoom: vi.fn(async (name: string): Promise<'deleted'> => {
      rooms.delete(name);
      return 'deleted';
    }),
    mockEjectParticipants: vi.fn(async (): Promise<'ejected'> => 'ejected'),
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
  dailyParticipantEjector: { ejectParticipants: mockEjectParticipants },
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
  creditReceivables,
  creditSessions,
  creditSessionsRepository,
  creditWalletsRepository,
  db,
  deriveIdempotencyKey,
  eq,
  expertPayoutRecords,
  expertsRepository,
  meetingCalendarEventsRepository,
  meetingRingsRepository,
  meetings,
  meetingsRepository,
  type AuditEvent,
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
import { endRing } from '../services/call-now/end-ring.js';
import { settleSessionlessCaseMeeting } from '../services/credit-session/settle-sessionless-case-meeting.js';
import type { MeetingTokenMinter } from '../services/daily/meeting-tokens.js';
import { endMeeting } from '../services/meetings/end-meeting.js';
import {
  joinMeetingAsMember,
  type JoinMeetingAsMemberInput,
  type JoinMeetingResult,
} from '../services/meetings/join-meeting.js';
import {
  applyPresenceEffect,
  reconcileMeetingStatus,
  resolvePresenceEffect,
  type PresenceAction,
} from '../services/meetings/presence-writer.js';
import { seedBookingParties, type BookingParties } from '../test/fixtures/booking-graph.js';

// ── Constants ────────────────────────────────────────────────────────────────────────

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
/** THE floor, from the same resolver the settlement path snapshots. */
const FLOOR = resolveBillingFloorMinutes();
/** The party who rings sits alone this long — comfortably past the billing floor. */
const ALONE_MINUTES = 20;
/** How long before its start a fixture meeting's room became ready — any value > 0 will do. */
const ROOM_LEAD_MINUTES = 60;
/** The first party joins this long after the ring starts. */
const FIRST_JOIN_SECONDS = 1;
/** The second party arrives this long after the ring starts — inside the ring window (asserted below). */
const ANSWER_SECONDS = 30;
/** The in-place booking sits this far ahead of the ring: outside its own join window, and a later slot. */
const BOOKING_AHEAD_HOURS = 4;
const BOOKED_WINDOW_MINUTES = 30;
const FINDER_WINDOW_HOURS = 72;
const MEETING_RESCHEDULED_ACTION = 'meeting.rescheduled';
const TOGETHER_MINUTES = [20, 5] as const;

const EXPERT_RATE_MINOR_PER_MINUTE = 560;
const { clientRateMinorPerMinute: CLIENT_RATE } = deriveSessionEstimate({
  expertRateMinorPerMinute: EXPERT_RATE_MINOR_PER_MINUTE,
  estimatedMinutes: 1,
});
const FUNDED_BALANCE_MINOR = 50_000;

const TERMINAL_STATUSES = ['unanswered', 'declined', 'stopped'] as const;
type RingTerminalStatus = (typeof TERMINAL_STATUSES)[number];

const NEVER_CONNECTS_CASES = ['P1', 'P2', 'P3'] as const;
type NeverConnectsCase = (typeof NEVER_CONNECTS_CASES)[number];
const CONNECTED_CASES = ['C1', 'C2', 'C3'] as const;
type ConnectedCase = (typeof CONNECTED_CASES)[number];

const CASE_PLACEMENT: Readonly<
  Record<NeverConnectsCase | ConnectedCase, 'new_meeting' | 'in_place'>
> = {
  P1: 'new_meeting',
  P2: 'new_meeting',
  P3: 'in_place',
  C1: 'new_meeting',
  C2: 'new_meeting',
  C3: 'in_place',
};

/** The cases whose caller is the delivering expert (the booker is rung). */
const EXPERT_RINGS: ReadonlySet<NeverConnectsCase | ConnectedCase> = new Set(['P2', 'C2']);

/** The vendor-side token requests this test's minter saw — one entry per Daily credential issued. */
interface CountingMinter extends MeetingTokenMinter {
  readonly mintedFor: string[];
}

function countingMinter(): CountingMinter {
  const mintedFor: string[] = [];
  return {
    mintedFor,
    createMeetingToken: async (request) => {
      mintedFor.push(request.participantId);
      return { token: 'test-daily-meeting-token' };
    },
  };
}

// ── Time ─────────────────────────────────────────────────────────────────────────────

/** A minute-aligned instant an hour before the real clock. Never a calendar literal. */
function freshRingStart(): Date {
  const minute = Math.floor(Date.now() / MS_PER_MINUTE) * MS_PER_MINUTE;
  return new Date(minute - MS_PER_HOUR);
}

function plusMs(instant: Date, ms: number): Date {
  return new Date(instant.getTime() + ms);
}

function plusSeconds(instant: Date, seconds: number): Date {
  return plusMs(instant, seconds * MS_PER_SECOND);
}

function plusMinutes(instant: Date, minutes: number): Date {
  return plusMs(instant, minutes * MS_PER_MINUTE);
}

function setClock(at: Date): void {
  vi.setSystemTime(at);
}

// ── Fixture ──────────────────────────────────────────────────────────────────────────

interface Scenario {
  readonly parties: BookingParties;
  /** The booker: the client member the case belongs to. */
  readonly bookerUserId: string;
  readonly expertUserId: string;
}

/** `fundedMinor = null` seeds a wallet with nothing in it and no mandate. */
async function seedScenario(fundedMinor: number | null = FUNDED_BALANCE_MINOR): Promise<Scenario> {
  const parties = await seedBookingParties();
  await expertsRepository.updateProfile(parties.expertProfileId, {
    rateCents: EXPERT_RATE_MINOR_PER_MINUTE,
  });
  const expert = await expertsRepository.findUserIdByProfileId(parties.expertProfileId);
  if (expert === undefined) {
    throw new Error('fixture: the seeded expert profile resolves no user');
  }
  const wallet = await creditWalletsRepository.ensureForCompany(db, parties.companyId);
  if (fundedMinor !== null) {
    const paymentIntentId = `pi_test_${randomUUID().replace(/-/g, '')}`;
    await creditLedgerRepository.postEntry({
      walletId: wallet.id,
      entryType: 'purchase',
      reason: 'manual_purchase',
      amountMinor: fundedMinor,
      idempotencyKey: deriveIdempotencyKey({ reason: 'manual_purchase', paymentIntentId }),
      memberId: parties.memberUserId,
      stripePaymentIntentId: paymentIntentId,
    });
  }
  return { parties, bookerUserId: parties.memberUserId, expertUserId: expert.user.id };
}

/** Provision the room the way the call-now service does after commit, with its readiness backdated. */
async function provisionRoom(meetingId: string, start: Date): Promise<string> {
  const roomName = dailyRoomNameForMeeting(meetingId);
  await meetingsRepository.setVenue(meetingId, {
    dailyRoomName: roomName,
    joinUrl: `https://balo.daily.co/${roomName}`,
  });
  // `setVenue` stamps the real clock; a room provisioned with the call is ready before its start.
  await db
    .update(meetings)
    .set({ venueProvisionedAt: plusMinutes(start, -ROOM_LEAD_MINUTES) })
    .where(eq(meetings.id, meetingId));
  return roomName;
}

/** An ordinary booked case meeting, its room, and its two calendar rows. */
async function bookCaseMeeting(
  scenario: Scenario,
  start: Date,
  windowMinutes: number
): Promise<string> {
  const { meeting } = await meetingsRepository.create({
    scheduledStart: start,
    scheduledEnd: plusMinutes(start, windowMinutes),
    contexts: [{ contextType: 'case', contextId: scenario.parties.caseEngagementId }],
    actorUserId: scenario.bookerUserId,
  });
  await provisionRoom(meeting.id, start);
  await meetingCalendarEventsRepository.recordIcsDelivery({
    meetingId: meeting.id,
    party: 'client',
  });
  await meetingCalendarEventsRepository.recordIcsDelivery({
    meetingId: meeting.id,
    party: 'expert',
  });
  return meeting.id;
}

interface StartedRing {
  readonly ringId: string;
  readonly meetingId: string;
}

/**
 * ONE ring through the repository's write seam. P1/C1 and P2/C2 ring on a NEW meeting (the booker
 * rings, or the expert does); P3/C3 ring IN PLACE on a booking `BOOKING_AHEAD_HOURS` away.
 */
async function startRing(
  scenario: Scenario,
  scenarioCase: NeverConnectsCase | ConnectedCase,
  start: Date
): Promise<StartedRing> {
  const expertRings = EXPERT_RINGS.has(scenarioCase);
  const base = {
    engagementId: scenario.parties.caseEngagementId,
    callerUserId: expertRings ? scenario.expertUserId : scenario.bookerUserId,
    calleeUserId: expertRings ? scenario.bookerUserId : scenario.expertUserId,
    callerSide: expertRings ? ('expert' as const) : ('client' as const),
    reachedBy: 'app' as const,
    attemptId: null,
    calleeOnlineAtStart: false,
    expiresAt: plusMs(start, CALL_NOW_RING_MS),
    now: start,
  };
  if (CASE_PLACEMENT[scenarioCase] === 'in_place') {
    const bookedStart = plusMinutes(start, BOOKING_AHEAD_HOURS * 60);
    const meetingId = await bookCaseMeeting(scenario, bookedStart, BOOKED_WINDOW_MINUTES);
    const started = await meetingRingsRepository.startOnMeeting({ ...base, meetingId });
    if (started === undefined) {
      throw new Error('fixture: the in-place ring found no eligible booking');
    }
    return { ringId: started.ring.id, meetingId };
  }
  const started = await meetingRingsRepository.startWithNewMeeting({
    ...base,
    scheduledStart: start,
    scheduledEnd: plusMinutes(start, CALL_NOW_SCHEDULED_MINUTES),
  });
  await provisionRoom(started.meeting.id, start);
  return { ringId: started.ring.id, meetingId: started.meeting.id };
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
  setClock(at);
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

function asUser(userId: string): string {
  return dailyParticipantIdFor('user', userId);
}

function joined(meetingId: string, userId: string, at: Date): Promise<void> {
  return observe('open', meetingId, asUser(userId), at);
}

function left(meetingId: string, userId: string, at: Date): Promise<void> {
  return observe('close', meetingId, asUser(userId), at);
}

/** The member join, at the pinned instant. `answeringRingId` is the answer step's input. */
async function joinAs(
  minter: MeetingTokenMinter,
  meetingId: string,
  userId: string,
  at: Date,
  answeringRingId?: string
): Promise<JoinMeetingResult> {
  setClock(at);
  const input: JoinMeetingAsMemberInput = {
    meetingId,
    userId,
    minter,
    ...(answeringRingId === undefined ? {} : { answeringRingId }),
  };
  return joinMeetingAsMember(input);
}

async function expectAdmitted(result: JoinMeetingResult): Promise<void> {
  expect(result).toMatchObject({ ok: true });
}

/** A held join: the planned refusal, its `ringId`, and NO token issued for that user. */
function expectHeldForAnswer(result: JoinMeetingResult, ringId: string): void {
  expect(result).toMatchObject({ ok: false, code: 'call_answer_required', ringId });
}

// ── Reads ────────────────────────────────────────────────────────────────────────────

/** Every `credit_sessions` row of the company — any status, soft-deleted or not. */
async function allSessionsOfCompany(companyId: string): Promise<CreditSession[]> {
  return db.select().from(creditSessions).where(eq(creditSessions.companyId, companyId));
}

async function sessionsForMeeting(meetingId: string): Promise<CreditSession[]> {
  return db.select().from(creditSessions).where(eq(creditSessions.meetingId, meetingId));
}

async function ledgerRowsBeyondTopUp(companyId: string): Promise<Array<{ reason: string }>> {
  const wallet = await creditWalletsRepository.findByCompanyId(companyId);
  if (wallet === undefined) {
    throw new Error('fixture: the wallet vanished');
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

async function receivablesOf(companyId: string): Promise<Array<{ amountMinor: number }>> {
  return db
    .select({ amountMinor: creditReceivables.amountMinor })
    .from(creditReceivables)
    .where(eq(creditReceivables.companyId, companyId));
}

async function payoutsOf(companyId: string): Promise<Array<{ amountMinor: number }>> {
  return db
    .select({ amountMinor: expertPayoutRecords.amountMinor })
    .from(expertPayoutRecords)
    .where(eq(expertPayoutRecords.companyId, companyId));
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

async function sessionlessCandidateIds(start: Date, endedBefore: Date): Promise<string[]> {
  const found = await creditSessionsRepository.findSessionlessEndedCaseMeetings({
    endedBefore,
    windowStart: new Date(start.getTime() - FINDER_WINDOW_HOURS * MS_PER_HOUR),
  });
  return found.map((candidate) => candidate.meetingId);
}

async function reservableIds(companyId: string, now: Date): Promise<string[]> {
  const reservable = await meetingsRepository.listReservableCaseBookings({ companyId, now });
  return reservable.map((booking) => booking.meetingId);
}

async function calendarSequences(meetingId: string): Promise<Array<[string, number]>> {
  const rows = await meetingCalendarEventsRepository.listLiveByMeeting(meetingId);
  return rows
    .map((row): [string, number] => [row.party, row.sequence])
    .sort((a, b) => a[0].localeCompare(b[0]));
}

// ── Never-connects assertions ───────────────────────────────────────────────────────

/** Nothing was opened, posted, owed, accrued or alarmed — the whole money surface is empty. */
async function expectNothingConsumed(scenario: Scenario, meetingId: string): Promise<void> {
  const { companyId } = scenario.parties;
  expect(await allSessionsOfCompany(companyId)).toEqual([]);
  expect(await sessionsForMeeting(meetingId)).toEqual([]);
  expect(await ledgerRowsBeyondTopUp(companyId)).toEqual([]);
  expect(await walletBalance(companyId)).toBe(FUNDED_BALANCE_MINOR);
  expect(await receivablesOf(companyId)).toEqual([]);
  expect(await payoutsOf(companyId)).toEqual([]);
  expect(
    await auditRows('meeting', meetingId, 'credit_session.sessionless_meeting_marked')
  ).toEqual([]);
  expect(await auditRows('meeting', meetingId, MEETING_RESCHEDULED_ACTION)).toEqual([]);
  const meeting = await mustFindMeeting(meetingId);
  expect(['no_answer', null]).toContain(meeting.outcome);
  expect(mockRaiseAdminAlert).not.toHaveBeenCalled();
  expect(mockCreateOffSessionCharge).not.toHaveBeenCalled();
}

async function expectEndedAsNoAnswer(meetingId: string): Promise<void> {
  const meeting = await mustFindMeeting(meetingId);
  expect(meeting.status).toBe('ended');
  expect(meeting.outcome).toBe('no_answer');
  const ended = await auditRows('meeting', meetingId, 'meeting.ended');
  expect(ended).toHaveLength(1);
  expect(ended[0]?.metadata).toMatchObject({ endedBy: 'system_idle', outcome: 'no_answer' });
}

function ringEnder(
  scenarioCase: NeverConnectsCase,
  scenario: Scenario,
  to: RingTerminalStatus
): string | null {
  if (to === 'unanswered') {
    return null;
  }
  const callerUserId = EXPERT_RINGS.has(scenarioCase)
    ? scenario.expertUserId
    : scenario.bookerUserId;
  const calleeUserId = EXPERT_RINGS.has(scenarioCase)
    ? scenario.bookerUserId
    : scenario.expertUserId;
  return to === 'declined' ? calleeUserId : callerUserId;
}

// ── Connected fingerprint ───────────────────────────────────────────────────────────

interface BillingFingerprint {
  readonly sessions: number;
  readonly settlementShape: CreditSession['settlementShape'];
  readonly connectedMinutes: number | null;
  readonly consumeRows: number;
  readonly consumeSumMinor: number;
  readonly expertAccruedMinor: number | null;
  readonly payoutAmountsMinor: number[];
  readonly receivableAmountsMinor: number[];
  readonly ledgerReasons: string[];
  readonly balanceMinor: number | undefined;
}

async function fingerprint(companyId: string, meetingId: string): Promise<BillingFingerprint> {
  const sessions = (await sessionsForMeeting(meetingId)).filter((row) => row.deletedAt === null);
  const [session] = sessions;
  const consume =
    session === undefined
      ? []
      : await db
          .select({ amountMinor: creditLedger.amountMinor })
          .from(creditLedger)
          .where(
            and(eq(creditLedger.sessionId, session.id), eq(creditLedger.reason, 'session_consume'))
          );
  const ledger = await ledgerRowsBeyondTopUp(companyId);
  return {
    sessions: sessions.length,
    settlementShape: session?.settlementShape ?? null,
    connectedMinutes: session?.connectedMinutes ?? null,
    consumeRows: consume.length,
    consumeSumMinor: consume.reduce((total, row) => total + row.amountMinor, 0),
    expertAccruedMinor: session?.expertAccruedMinor ?? null,
    payoutAmountsMinor: (await payoutsOf(companyId)).map((row) => row.amountMinor),
    receivableAmountsMinor: (await receivablesOf(companyId)).map((row) => row.amountMinor),
    ledgerReasons: ledger.map((row) => row.reason).sort((a, b) => a.localeCompare(b)),
    balanceMinor: await walletBalance(companyId),
  };
}

/**
 * The twin: an ordinary booked consultation of a SECOND company whose window starts at `start` and whose two
 * parties are both present from it, ended `minutes` later by its expert.
 */
async function runTwin(
  fundedMinor: number | null,
  start: Date,
  minutes: number
): Promise<{ scenario: Scenario; meetingId: string }> {
  const scenario = await seedScenario(fundedMinor);
  const meetingId = await bookCaseMeeting(scenario, start, CALL_NOW_SCHEDULED_MINUTES);
  await joined(meetingId, scenario.expertUserId, start);
  await joined(meetingId, scenario.bookerUserId, start);
  const ended = await endMeeting({
    meetingId,
    userId: scenario.expertUserId,
    now: plusMinutes(start, minutes),
  });
  expect(ended).toMatchObject({ ok: true, alreadyEnded: false });
  return { scenario, meetingId };
}

beforeEach(() => {
  vi.clearAllMocks();
  vendorRooms.clear();
  vi.useFakeTimers({ toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

// ── Never connects ───────────────────────────────────────────────────────────────────

describe.each(NEVER_CONNECTS_CASES)(
  'INVARIANT (end-to-end): a Call now ring that never connects consumes nothing — %s',
  (scenarioCase: NeverConnectsCase) => {
    it.each(TERMINAL_STATUSES)(
      '⚠ ended %s with the first party alone past the floor: no session, no charge, no no-show, the booking untouched',
      async (to: RingTerminalStatus) => {
        const scenario = await seedScenario();
        const { companyId } = scenario.parties;
        const start = freshRingStart();
        const minter = countingMinter();
        const placement = CASE_PLACEMENT[scenarioCase];
        const expertRings = EXPERT_RINGS.has(scenarioCase);
        const reservableBeforeRing = await reservableIds(companyId, start);

        const { ringId, meetingId } = await startRing(scenario, scenarioCase, start);
        // An in-place ring sits on a booking that is already reservable; a new meeting exists only once rung.
        const reservableBefore =
          placement === 'in_place' ? await reservableIds(companyId, start) : reservableBeforeRing;
        expect(reservableBefore.includes(meetingId)).toBe(placement === 'in_place');
        const meetingBefore = await mustFindMeeting(meetingId);
        const calendarBefore = await calendarSequences(meetingId);
        const firstAt = plusSeconds(start, FIRST_JOIN_SECONDS);

        // The ringing party enters first and then waits alone past the floor.
        if (expertRings) {
          await expectAdmitted(await joinAs(minter, meetingId, scenario.expertUserId, firstAt));
          await joined(meetingId, scenario.expertUserId, firstAt);
          // The booker's plain join is HELD: no credential, so no presence and no co-presence connect.
          const held = await joinAs(
            minter,
            meetingId,
            scenario.bookerUserId,
            plusSeconds(start, 5)
          );
          expectHeldForAnswer(held, ringId);
          expect(minter.mintedFor).not.toContain(asUser(scenario.bookerUserId));
        } else {
          await expectAdmitted(await joinAs(minter, meetingId, scenario.bookerUserId, firstAt));
          await joined(meetingId, scenario.bookerUserId, firstAt);
        }
        expect((await meetingRingsRepository.findById(ringId))?.status).toBe('ringing');
        expect((await mustFindMeeting(meetingId)).status).not.toBe('in_progress');
        expect(await sessionsForMeeting(meetingId)).toEqual([]);

        const endAt = plusMinutes(start, ALONE_MINUTES);
        setClock(endAt);
        const outcome = await endRing({
          ringId,
          to,
          actorUserId: ringEnder(scenarioCase, scenario, to),
          now: endAt,
        });
        expect(outcome).toMatchObject({ ended: true, status: to });
        expect((await meetingRingsRepository.findById(ringId))?.status).toBe(to);

        if (placement === 'in_place') {
          // The ring parties are ejected from the booking's room without a ban; their leave closes the
          // presence the ring left open.
          expect(mockEjectParticipants).toHaveBeenCalledWith(
            dailyRoomNameForMeeting(meetingId),
            expect.arrayContaining([asUser(scenario.bookerUserId), asUser(scenario.expertUserId)]),
            { ban: false }
          );
          await left(meetingId, scenario.bookerUserId, endAt);
          expect(await mustFindMeeting(meetingId)).toEqual(meetingBefore);
          expect(await calendarSequences(meetingId)).toEqual(calendarBefore);
          expect(await reservableIds(companyId, start)).toEqual(reservableBefore);
        } else {
          expect(mockEjectParticipants).not.toHaveBeenCalled();
          await expectEndedAsNoAnswer(meetingId);
          const settled = await settleSessionlessCaseMeeting({
            meetingId,
            trigger: 'backstop',
            actorUserId: null,
            now: plusMinutes(endAt, 5),
          });
          expect(settled).toEqual({ kind: 'not_billable', reason: 'no_answer' });
          expect(await sessionlessCandidateIds(start, plusMinutes(endAt, 10))).not.toContain(
            meetingId
          );
          expect(await reservableIds(companyId, start)).toEqual(reservableBefore);
        }

        await expectNothingConsumed(scenario, meetingId);
      }
    );
  }
);

// ── Connected ────────────────────────────────────────────────────────────────────────

/** Drive a connected ring: the ringing party enters first, the other answers at `ANSWER_SECONDS`. */
async function connectRing(
  scenario: Scenario,
  scenarioCase: ConnectedCase,
  start: Date,
  minter: CountingMinter
): Promise<StartedRing & { connectAt: Date }> {
  const { ringId, meetingId } = await startRing(scenario, scenarioCase, start);
  const connectAt = plusSeconds(start, ANSWER_SECONDS);
  expect(ANSWER_SECONDS * MS_PER_SECOND).toBeLessThan(CALL_NOW_RING_MS);
  const firstAt = plusSeconds(start, FIRST_JOIN_SECONDS);

  if (EXPERT_RINGS.has(scenarioCase)) {
    await expectAdmitted(await joinAs(minter, meetingId, scenario.expertUserId, firstAt));
    await joined(meetingId, scenario.expertUserId, firstAt);
    // The booker's plain join is held; only the commit (`answeringRingId`) admits.
    const held = await joinAs(minter, meetingId, scenario.bookerUserId, connectAt);
    expectHeldForAnswer(held, ringId);
    expect(minter.mintedFor).not.toContain(asUser(scenario.bookerUserId));
    await expectAdmitted(await joinAs(minter, meetingId, scenario.bookerUserId, connectAt, ringId));
    expect(minter.mintedFor).toContain(asUser(scenario.bookerUserId));
    await joined(meetingId, scenario.bookerUserId, connectAt);
  } else {
    await expectAdmitted(await joinAs(minter, meetingId, scenario.bookerUserId, firstAt));
    await joined(meetingId, scenario.bookerUserId, firstAt);
    await expectAdmitted(await joinAs(minter, meetingId, scenario.expertUserId, connectAt));
    await joined(meetingId, scenario.expertUserId, connectAt);
  }
  return { ringId, meetingId, connectAt };
}

async function expectConnectedAtMovedStart(
  ring: StartedRing & { connectAt: Date },
  scenarioCase: ConnectedCase
): Promise<void> {
  const connected = await mustFindMeeting(ring.meetingId);
  expect(connected.status).toBe('in_progress');
  expect(connected.scheduledStart).toEqual(ring.connectAt);
  expect(connected.startedAt).toEqual(ring.connectAt);
  expect((await meetingRingsRepository.findById(ring.ringId))?.status).toBe('connected');

  // Billing starts at the connect instant itself, not at the next sweep or at settlement: one session,
  // connected at the moved start.
  const sessions = (await sessionsForMeeting(ring.meetingId)).filter(
    (row) => row.deletedAt === null
  );
  expect(sessions).toHaveLength(1);
  expect(sessions[0]?.status).toBe('active');
  expect(sessions[0]?.connectedAt).toEqual(ring.connectAt);

  if (CASE_PLACEMENT[scenarioCase] === 'in_place') {
    // The booked meeting moved to the connect instant: its old slot is free, once, and the calendar knows.
    const moved = await auditRows('meeting', ring.meetingId, MEETING_RESCHEDULED_ACTION);
    expect(moved).toHaveLength(1);
    expect(moved[0]?.metadata).toMatchObject({ reason: 'call_now_connected' });
    expect(await calendarSequences(ring.meetingId)).toEqual([
      ['client', 1],
      ['expert', 1],
    ]);
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'amend',
      expect.objectContaining({ meetingId: ring.meetingId }),
      expect.anything()
    );
  }
}

describe.each(CONNECTED_CASES)(
  'INVARIANT (end-to-end): a connected Call now ring bills exactly as a booked consultation — %s',
  (scenarioCase: ConnectedCase) => {
    it.each(TOGETHER_MINUTES)(
      '⚠ %i together-minutes after the connect bills identically to its booked twin',
      async (minutes: number) => {
        const scenario = await seedScenario();
        const start = freshRingStart();
        const minter = countingMinter();
        const ring = await connectRing(scenario, scenarioCase, start, minter);
        await expectConnectedAtMovedStart(ring, scenarioCase);

        const ended = await endMeeting({
          meetingId: ring.meetingId,
          userId: scenario.expertUserId,
          now: plusMinutes(ring.connectAt, minutes),
        });
        expect(ended).toMatchObject({ ok: true, alreadyEnded: false });

        const twin = await runTwin(FUNDED_BALANCE_MINOR, ring.connectAt, minutes);
        const billed = await fingerprint(scenario.parties.companyId, ring.meetingId);
        const booked = await fingerprint(twin.scenario.parties.companyId, twin.meetingId);

        expect(billed.sessions).toBe(1);
        expect(billed.connectedMinutes).toBe(Math.max(minutes, FLOOR));
        expect(billed.consumeRows).toBe(Math.max(minutes, FLOOR));
        expect(billed.consumeSumMinor).toBe(-Math.max(minutes, FLOOR) * CLIENT_RATE);
        expect(billed.payoutAmountsMinor).toHaveLength(1);
        expect(billed).toEqual(booked);
        expect(mockRaiseAdminAlert).not.toHaveBeenCalled();
        expect(mockCreateOffSessionCharge).not.toHaveBeenCalled();
      }
    );

    if (scenarioCase === 'C2') {
      it('⚠ at zero balance with no mandate the open at connect is overdraft-tolerant: a receivable equal to its zero-balance twin', async () => {
        // Admits via `answeringRingId` directly, to prove only the overdraft-tolerant open at connect:
        // `answerCallNow` would refuse this wallet as `booking_unfunded` (that refusal is F4 in
        // `call-now-funding.integration.test.ts`).
        const scenario = await seedScenario(null);
        const start = freshRingStart();
        const minter = countingMinter();
        const ring = await connectRing(scenario, 'C2', start, minter);
        await expectConnectedAtMovedStart(ring, 'C2');

        const ended = await endMeeting({
          meetingId: ring.meetingId,
          userId: scenario.expertUserId,
          now: plusMinutes(ring.connectAt, FLOOR),
        });
        expect(ended).toMatchObject({ ok: true, alreadyEnded: false });

        const twin = await runTwin(null, ring.connectAt, FLOOR);
        const billed = await fingerprint(scenario.parties.companyId, ring.meetingId);
        const booked = await fingerprint(twin.scenario.parties.companyId, twin.meetingId);

        expect(billed.sessions).toBe(1);
        expect(billed.receivableAmountsMinor).toHaveLength(1);
        expect(billed).toEqual(booked);
      });
    }
  }
);

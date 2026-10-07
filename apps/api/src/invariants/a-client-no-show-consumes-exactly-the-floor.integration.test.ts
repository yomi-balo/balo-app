import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * BAL-474 (ADR-1040 Amendment 7, ADR-1052, ADR-1049 A5) — INVARIANT F3, END TO END AGAINST A
 * REAL POSTGRES: a client no-show with the expert present the full floor consumes EXACTLY the
 * floor, through every terminal path that can end such a meeting; a sessionless HELD Case call
 * is billed post-hoc; and the zero shapes still consume nothing and never alarm.
 *
 * The pure core already pins "a client no-show bills the floor FLAT"
 * (`packages/db/src/invariants/expert-paid-for-time-made-available.test.ts`). This suite pins
 * REACHABILITY: that the production terminal paths actually open a session on behalf of the
 * booker and settle it, when no client-side party was ever admitted to open one.
 *
 * ── WHAT IS DRIVEN ──────────────────────────────────────────────────────────────────────
 *
 * Only production entry points:
 *   · the booking row — `meetingsRepository.create` (with `actorUserId` = the booker, which is
 *     what writes the `meeting.booked` audit row the on-behalf open attributes to) + `setVenue`;
 *   · admission — `joinMeetingAsMember` / `joinMeetingAsGuest`, through their documented
 *     `minter` injection point (an object literal, never a module mock);
 *   · presence — the Daily webhook's three phases: `resolvePresenceEffect` →
 *     `applyPresenceEffect` → `reconcileMeetingStatus`;
 *   · termination — `runMeetingLifecycleSweep(now, noop, fakePresenceReader)` and the human
 *     `endMeeting`;
 *   · the durability backstop — `runSessionMeterSweep(now)`.
 * The floor is `resolveBillingFloorMinutes()`; the sweep's windows are `resolveMeetingTimers()`.
 *
 * ⚠ THE FAKE PRESENCE READER AGREES WITH BALO. `vendorRooms` mirrors every join/leave this file
 * reports through the webhook phases, so the sweep's reconciliation pass sees a roster that
 * matches the stored intervals and changes nothing. A teardown (the mocked `deleteRoom`) empties
 * the room, exactly as Daily would.
 *
 * ── MOCKS (and only these) ──────────────────────────────────────────────────────────────
 *
 *   · `../lib/queue.js` `getQueue` — BullMQ would open a live Redis connection;
 *   · `dailyRoomTeardown.deleteRoom` — a vendor call;
 *   · the Stripe provider's `createOffSessionCharge` — no wallet in this file holds a mandate,
 *     so it is never reached; it rejects loudly if it ever is;
 *   · `raiseAdminAlert` — a spy; the alarm contract is asserted on it.
 * `@balo/db` stays REAL.
 *
 * ── THE HARNESS ─────────────────────────────────────────────────────────────────────────
 *
 * This file runs from `packages/db/vitest.config.integration.ts` (it globs
 * `apps/api/src/**‍/*.integration.test.ts`). Every test runs inside ONE rolled-back transaction
 * on a `max: 1` pool; a nested `db.transaction()` is a SAVEPOINT. Two consequences shape the
 * assertions below:
 *   · `created_at` is `transaction_timestamp()`, so EVERY row written by one test shares it.
 *     A `created_at` equality therefore proves nothing about "same transaction" here. That
 *     property is pinned instead by the 'atomicity' block at the end of this file, which makes
 *     one write of the group FAIL (a `BEFORE INSERT` trigger on `audit_events`) and asserts the
 *     rest of the group did not survive.
 *   · a caught Postgres `23505` would abort the harness transaction, so nothing here relies on
 *     one.
 *
 * ⚠ NO CALENDAR LITERALS. Every instant is derived from a minute-aligned `scheduledStart` taken
 * from the real clock at test time. Admission reads the real clock (`assertMeetingJoinable`'s
 * token window), so a fixed date would turn this suite red on a future calendar day.
 *
 * ⚠ RATES ARE DERIVED, NOT RESTATED. The system open passes no `baloFeeBps`, so the session is
 * priced at the DEFAULT fee: `deriveSessionEstimate` turns the fixture's expert hourly rate into
 * the client and expert per-minute rates every money assertion uses.
 *
 * ⚠ LITERAL AUDIT ACTIONS. `credit_session.opened_on_behalf` and
 * `credit_session.sessionless_meeting_marked` are written as string literals rather than imported
 * constants, so this file loads against a tree where those constants do not exist yet.
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
  caseEngagementsRepository,
  companyMembers,
  creditHolds,
  creditLedger,
  creditLedgerRepository,
  creditReceivables,
  creditSessions,
  creditWalletsRepository,
  db,
  deriveIdempotencyKey,
  engagementsRepository,
  eq,
  expertPayoutRecords,
  expertsRepository,
  meetingGuestsRepository,
  meetings,
  meetingsRepository,
  softDeleteEngagementTx,
  sql,
  usersRepository,
  type AuditEvent,
  type CreditSession,
  type Meeting,
} from '@balo/db';
import { deriveSessionEstimate } from '@balo/shared/credit';
import {
  GUEST_TOKEN_TTL_AFTER_END_MS,
  dailyParticipantIdFor,
  dailyRoomNameForMeeting,
} from '@balo/shared/meetings';
import { resolveBillingFloorMinutes } from '../config/billing-floor.js';
import { resolveMeetingTimers } from '../config/meeting-timers.js';
import { runSessionMeterSweep } from '../jobs/credit-session-meter-sweep.js';
import { runMeetingLifecycleSweep } from '../jobs/meeting-lifecycle-sweep.js';
import { settleSessionlessCaseMeeting } from '../services/credit-session/settle-sessionless-case-meeting.js';
import { mintGuestInviteToken } from '../lib/guest-token.js';
import type { MeetingTokenMinter } from '../services/daily/meeting-tokens.js';
import type { PresenceReader } from '../services/daily/rooms.js';
import { endMeeting } from '../services/meetings/end-meeting.js';
import { joinMeetingAsGuest, joinMeetingAsMember } from '../services/meetings/join-meeting.js';
import {
  applyPresenceEffect,
  reconcileMeetingStatus,
  resolvePresenceEffect,
  type PresenceAction,
} from '../services/meetings/presence-writer.js';
import { seedBookingParties, type BookingParties } from '../test/fixtures/booking-graph.js';

// ── Constants — every one DERIVED ──────────────────────────────────────────────────────

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
/** How long before its start a fixture meeting's room became ready — any value > 0 will do. */
const BOOKING_LEAD_MINUTES = 60;

/** THE floor, from the same resolver the settlement path snapshots. */
const FLOOR = resolveBillingFloorMinutes();
const TIMERS = resolveMeetingTimers();
const MISSED_CALL_MINUTES = TIMERS.missedCallTerminationMs / MS_PER_MINUTE;
const IDLE_END_MINUTES = TIMERS.idleEndEmptyMs / MS_PER_MINUTE;

/** The fixture expert's hourly rate. At the default fee this is 700/min client, 560/min expert. */
const EXPERT_HOURLY_MINOR = 33_600;
const { clientRateMinorPerMinute: CLIENT_RATE, expertRateMinorPerMinute: EXPERT_RATE } =
  deriveSessionEstimate({ expertHourlyMinor: EXPERT_HOURLY_MINOR, estimatedMinutes: 1 });

/** Comfortably more than any hold or consumption in this file (a 30-minute estimate is 21,000). */
const FUNDED_BALANCE_MINOR = 50_000;
const BOOKED_WINDOW_MINUTES = 30;

const OPENED_ON_BEHALF_ACTION = 'credit_session.opened_on_behalf';
const SESSIONLESS_MARKER_ACTION = 'credit_session.sessionless_meeting_marked';
const EXPERT_ACCRUED_ACTION = 'credit_session.expert_accrued';
const PRESENCE_SETTLED_ACTION = 'credit_session.presence_settled';

const noop = (): void => {};

/** The documented `minter` injection point — no Daily account, no network. */
const testMinter: MeetingTokenMinter = {
  createMeetingToken: async () => ({ token: 'test-daily-meeting-token' }),
};

/**
 * The vendor roster, as Daily would report it: exactly the participants this file has reported
 * joined and not yet left, per room. See the module docblock.
 */
const fakePresenceReader: PresenceReader = {
  getAllPresence: async () =>
    Object.fromEntries(
      [...vendorRooms.entries()]
        .filter(([, participants]) => participants.size > 0)
        .map(([room, participants]) => [room, [...participants].map((userId) => ({ userId }))])
    ),
  // The per-room read answers from the same map: an emptied room is `[]`, which is what Daily
  // reports for a room nobody is in.
  getRoomPresence: async (roomName) =>
    [...(vendorRooms.get(roomName) ?? [])].map((userId) => ({ userId })),
  // Daily has no session history for these rooms; nothing here is a stranded close.
  getRoomSessionLeaves: async () => ({ leaves: new Map() }),
};

// ── Time ─────────────────────────────────────────────────────────────────────────────

/** A minute-aligned scheduled start an hour before the real clock. Never a calendar literal. */
function freshScheduledStart(): Date {
  const minute = Math.floor(Date.now() / MS_PER_MINUTE) * MS_PER_MINUTE;
  return new Date(minute - MS_PER_HOUR);
}

function plusMinutes(instant: Date, minutes: number): Date {
  return new Date(instant.getTime() + minutes * MS_PER_MINUTE);
}

function plusHours(instant: Date, hours: number): Date {
  return new Date(instant.getTime() + hours * MS_PER_HOUR);
}

// ── Fixture ──────────────────────────────────────────────────────────────────────────

interface Scenario {
  readonly parties: BookingParties;
  /** The booker — a live client `member`, and `meeting.booked`'s actor. */
  readonly bookerUserId: string;
  /** The delivering expert's user. */
  readonly expertUserId: string;
}

/**
 * The party graph, a priced expert, and (unless `fundedMinor` is `null`) a funded wallet with
 * no mandate. `null` leaves the company with NO wallet row at all.
 */
async function seedScenario(fundedMinor: number | null = FUNDED_BALANCE_MINOR): Promise<Scenario> {
  const parties = await seedBookingParties();
  await expertsRepository.updateProfile(parties.expertProfileId, {
    rateCents: EXPERT_HOURLY_MINOR,
  });
  const expert = await expertsRepository.findUserIdByProfileId(parties.expertProfileId);
  if (expert === undefined) {
    throw new Error('fixture: the seeded expert profile resolves no user');
  }
  if (fundedMinor !== null) {
    await fundWallet(parties.companyId, parties.memberUserId, fundedMinor);
  }
  return { parties, bookerUserId: parties.memberUserId, expertUserId: expert.user.id };
}

/** A cash top-up, through the ledger's one write seam. Provisions the wallet first. */
async function fundWallet(
  companyId: string,
  memberUserId: string,
  amountMinor: number
): Promise<void> {
  const wallet = await creditWalletsRepository.ensureForCompany(db, companyId);
  if (amountMinor === 0) return;
  const paymentIntentId = `pi_test_${randomUUID().replace(/-/g, '')}`;
  await creditLedgerRepository.postEntry({
    walletId: wallet.id,
    entryType: 'purchase',
    reason: 'manual_purchase',
    amountMinor,
    idempotencyKey: deriveIdempotencyKey({ reason: 'manual_purchase', paymentIntentId }),
    memberId: memberUserId,
    stripePaymentIntentId: paymentIntentId,
  });
}

/**
 * Book one provisioned Case meeting on the fixture engagement. `booker: null` records the
 * ADR-1030 unattributed `meeting.booked` row (the dev seeder's shape).
 */
async function bookCaseMeeting(
  scenario: Scenario,
  input: {
    readonly start: Date;
    readonly minutes?: number;
    readonly booker?: string | null;
    /** `false` ⇒ the call room was never provisioned (BAL-581). Defaults to a ready room. */
    readonly venue?: boolean;
  }
): Promise<string> {
  const { meeting } = await meetingsRepository.create({
    scheduledStart: input.start,
    scheduledEnd: plusMinutes(input.start, input.minutes ?? BOOKED_WINDOW_MINUTES),
    contexts: [{ contextType: 'case', contextId: scenario.parties.caseEngagementId }],
    actorUserId: input.booker === undefined ? scenario.bookerUserId : input.booker,
  });
  if (input.venue === false) {
    return meeting.id;
  }
  const roomName = dailyRoomNameForMeeting(meeting.id);
  await meetingsRepository.setVenue(meeting.id, {
    dailyRoomName: roomName,
    joinUrl: `https://balo.daily.co/${roomName}`,
  });
  // `setVenue` stamps `venue_provisioned_at` from the real clock, which is AFTER this fixture's
  // back-dated start. BAL-581 measures absence from max(start, room ready), so a room stamped
  // late would push every absence rule past the ticks below. A booking-time room is ready before
  // the start, so backdate the stamp to match.
  await db
    .update(meetings)
    .set({ venueProvisionedAt: plusMinutes(input.start, -BOOKING_LEAD_MINUTES) })
    .where(eq(meetings.id, meeting.id));
  return meeting.id;
}

/** A client-side, email-channel, pre-admitted guest — the row `inviteGuests` writes. */
async function inviteClientGuest(
  meetingId: string,
  invitedById: string,
  scheduledEnd: Date
): Promise<{ readonly guestId: string; readonly rawToken: string }> {
  const { rawToken, tokenHash } = mintGuestInviteToken();
  const [guest] = await meetingGuestsRepository.createMany({
    meetingId,
    invitedById,
    guests: [
      {
        email: `bal474-guest-${randomUUID()}@guest.test`,
        name: 'Colleague Guest',
        emailDomain: 'guest.test',
        party: 'client',
        participationRole: 'guest',
        accessScope: 'meeting',
        inviteChannel: 'email',
        admission: 'pre_admitted',
        tokenHash,
        expiresAt: new Date(scheduledEnd.getTime() + GUEST_TOKEN_TTL_AFTER_END_MS),
      },
    ],
  });
  if (guest === undefined) {
    throw new Error('fixture: guest invite returned no row');
  }
  return { guestId: guest.id, rawToken };
}

/** A second LIVE `member` of the company — a present client member who is NOT the booker. */
async function addCompanyMember(companyId: string): Promise<string> {
  const marker = randomUUID();
  const user = await usersRepository.create({
    workosId: `bal474_member_${marker}`,
    email: `bal474-member-${marker}@test.local`,
    firstName: 'Second',
    lastName: 'Member',
  });
  await db.insert(companyMembers).values({ companyId, userId: user.id, role: 'member' });
  return user.id;
}

// ── Production seams ─────────────────────────────────────────────────────────────────

async function mustFindMeeting(meetingId: string): Promise<Meeting> {
  const meeting = await meetingsRepository.findById(meetingId);
  if (meeting === undefined) {
    throw new Error(`fixture: meeting ${meetingId} not found`);
  }
  return meeting;
}

/** A client MEMBER is admitted — `joinMeetingAsMember`, the BAL-466 admission seam. */
async function admitMember(meetingId: string, userId: string): Promise<void> {
  const result = await joinMeetingAsMember({ meetingId, userId, minter: testMinter });
  if (!result.ok) {
    throw new Error(`fixture: member admission refused (${result.code})`);
  }
}

/** A GUEST is admitted — `joinMeetingAsGuest`. */
async function admitGuest(meetingId: string, rawGuestToken: string): Promise<void> {
  const result = await joinMeetingAsGuest({ meetingId, rawGuestToken, minter: testMinter });
  if (!result.ok || result.state !== 'admitted') {
    throw new Error(`fixture: guest admission did not mint (${JSON.stringify(result)})`);
  }
}

/**
 * ONE Daily presence observation, the way `routes/daily/webhook.ts` applies it: resolve (reads
 * only) → apply on the executor → reconcile the status post-commit. Mirrored into `vendorRooms`.
 */
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

function left(meetingId: string, participantId: string, at: Date): Promise<void> {
  return observe('close', meetingId, participantId, at);
}

function asUser(userId: string): string {
  return dailyParticipantIdFor('user', userId);
}

function asGuest(guestId: string): string {
  return dailyParticipantIdFor('guest', guestId);
}

/** One per-minute lifecycle sweep tick at `now`. */
async function lifecycleTick(now: Date): Promise<void> {
  await runMeetingLifecycleSweep(now, noop, fakePresenceReader);
}

/** One per-minute meter sweep tick at `now` — the durability backstop rides it. */
async function backstopTick(now: Date): Promise<void> {
  await runSessionMeterSweep(now);
}

// ── Reads ────────────────────────────────────────────────────────────────────────────

async function sessionsFor(meetingId: string): Promise<CreditSession[]> {
  const rows = await db
    .select()
    .from(creditSessions)
    .where(eq(creditSessions.meetingId, meetingId));
  return rows.filter((row) => row.deletedAt === null);
}

/** The meeting's ONE session — asserts exactly one exists, then narrows without `!`. */
async function theOnlySession(meetingId: string): Promise<CreditSession> {
  const sessions = await sessionsFor(meetingId);
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

function markersFor(meetingId: string): Promise<AuditEvent[]> {
  return auditRows('meeting', meetingId, SESSIONLESS_MARKER_ACTION);
}

/** The meeting's ONE sessionless marker — asserts exactly one exists. */
async function theOnlyMarker(meetingId: string): Promise<AuditEvent> {
  const markers = await markersFor(meetingId);
  expect(markers).toHaveLength(1);
  const [only] = markers;
  if (only === undefined) {
    throw new Error('unreachable: exactly one marker asserted above');
  }
  return only;
}

async function openReceivables(
  companyId: string
): Promise<Array<{ sessionId: string | null; amountMinor: number }>> {
  const rows = await db
    .select({
      sessionId: creditReceivables.sessionId,
      amountMinor: creditReceivables.amountMinor,
      status: creditReceivables.status,
      deletedAt: creditReceivables.deletedAt,
    })
    .from(creditReceivables)
    .where(eq(creditReceivables.companyId, companyId));
  return rows
    .filter((row) => row.status === 'open' && row.deletedAt === null)
    .map((row) => ({ sessionId: row.sessionId, amountMinor: row.amountMinor }));
}

/**
 * EXACTLY ONE `session.open_refused` alarm, and it is about THIS meeting and THIS reason — a count
 * alone would stay green if a different alert (or an alert for another meeting) fired instead.
 */
function expectOneOpenRefusedAlert(meetingId: string, reason: string): void {
  expect(mockRaiseAdminAlert).toHaveBeenCalledTimes(1);
  expect(mockRaiseAdminAlert).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: 'session.open_refused',
      entityType: 'meeting',
      entityId: meetingId,
      detail: expect.objectContaining({
        facts: expect.arrayContaining([['Reason', reason]]),
      }),
    })
  );
}

async function walletBalance(companyId: string): Promise<number | undefined> {
  return (await creditWalletsRepository.findByCompanyId(companyId))?.balanceMinor;
}

/**
 * WHICH terminal path ended the meeting, read from its one `meeting.ended` audit row. The sweep
 * swallows a per-meeting fault into a log line, so a billing assertion is only meaningful once
 * the terminal write it depends on is proven to have happened.
 *
 *   · the `no_show` rule            → `system_idle` + `no_show_client`
 *   · the `missed_call` rule        → `system_idle` + `missed_call`
 *   · the `idle_end` rule           → `system_idle` + `completed`
 *   · the `abandoned_wait` rule     → `system_idle` + NULL
 *   · the `venue_unavailable` rule  → `system_idle` + `venue_unavailable`
 *   · a human End                   → `expert_host` | `client_principal` + NULL
 */
async function expectTerminatedBy(
  meetingId: string,
  expected: {
    readonly endedBy: 'system_idle' | 'expert_host' | 'client_principal';
    readonly outcome: 'no_show_client' | 'missed_call' | 'completed' | 'venue_unavailable' | null;
  }
): Promise<void> {
  expect((await mustFindMeeting(meetingId)).status).toBe('ended');
  const ended = await auditRows('meeting', meetingId, 'meeting.ended');
  expect(ended).toHaveLength(1);
  expect(ended[0]?.metadata).toMatchObject(expected);
}

const NO_SHOW_RULE = { endedBy: 'system_idle', outcome: 'no_show_client' } as const;
const MISSED_CALL_RULE = { endedBy: 'system_idle', outcome: 'missed_call' } as const;
const IDLE_END_RULE = { endedBy: 'system_idle', outcome: 'completed' } as const;
const ABANDONED_WAIT_RULE = { endedBy: 'system_idle', outcome: null } as const;
const VENUE_UNAVAILABLE_RULE = { endedBy: 'system_idle', outcome: 'venue_unavailable' } as const;

/**
 * The floor-billed no-show shape, asserted field by field: a system open on behalf of the
 * booker, FLOOR connected minutes, FLOOR consume rows at the client rate, FLOOR at the expert
 * rate accrued.
 */
async function expectBilledExactlyTheFloor(
  meetingId: string,
  bookerUserId: string
): Promise<CreditSession> {
  const session = await theOnlySession(meetingId);
  expect(session.openedBy).toBe('system');
  expect(session.initiatingMemberId).toBe(bookerUserId);
  expect(session.connectedMinutes).toBe(FLOOR);
  expect(session.settlementShape).toBe('no_show_client');
  const consumed = await consumeRows(session.id);
  expect(consumed).toHaveLength(FLOOR);
  expect(sumMinor(consumed)).toBe(-FLOOR * CLIENT_RATE);
  expect(session.expertAccruedMinor).toBe(FLOOR * EXPERT_RATE);
  return session;
}

beforeEach(() => {
  vi.clearAllMocks();
  vendorRooms.clear();
});

// ── The cases ────────────────────────────────────────────────────────────────────────

describe('INVARIANT (end-to-end): a client no-show with the expert present the full floor consumes exactly the floor', () => {
  it('the no_show rule: exactly one session, billed exactly the floor, in one transaction', async () => {
    const scenario = await seedScenario();
    const start = freshScheduledStart();
    const meetingId = await bookCaseMeeting(scenario, { start });

    await joined(meetingId, asUser(scenario.expertUserId), start);
    await lifecycleTick(plusMinutes(start, FLOOR));
    await expectTerminatedBy(meetingId, NO_SHOW_RULE);

    const sessions = await sessionsFor(meetingId);
    expect(sessions).toHaveLength(1);
    const [session] = sessions;
    if (session === undefined) {
      throw new Error('unreachable: exactly one session asserted above');
    }
    expect(session.openedBy).toBe('system');
    expect(session.initiatingMemberId).toBe(scenario.bookerUserId);
    expect(session.connectedMinutes).toBe(FLOOR);
    expect(session.settlementShape).toBe('no_show_client');

    const consumed = await consumeRows(session.id);
    expect(consumed).toHaveLength(FLOOR);
    expect(sumMinor(consumed)).toBe(-FLOOR * CLIENT_RATE);
    expect(session.expertAccruedMinor).toBe(FLOOR * EXPERT_RATE);

    const payouts = await db
      .select({ amountMinor: expertPayoutRecords.amountMinor })
      .from(expertPayoutRecords)
      .where(eq(expertPayoutRecords.sessionId, session.id));
    expect(payouts).toEqual([{ amountMinor: FLOOR * EXPERT_RATE }]);

    const [onBehalfRows, accruedRows, settledRows] = await Promise.all([
      auditRows('credit_session', session.id, OPENED_ON_BEHALF_ACTION),
      auditRows('credit_session', session.id, EXPERT_ACCRUED_ACTION),
      auditRows('credit_session', session.id, PRESENCE_SETTLED_ACTION),
    ]);
    expect(onBehalfRows).toHaveLength(1);
    expect(accruedRows).toHaveLength(1);
    expect(settledRows).toHaveLength(1);
    const [onBehalf] = onBehalfRows;
    const [accrued] = accruedRows;
    const [settled] = settledRows;
    if (onBehalf === undefined || accrued === undefined || settled === undefined) {
      throw new Error('unreachable: one row of each asserted above');
    }
    expect(onBehalf.actorUserId).toBeNull();
    expect(onBehalf.metadata).toMatchObject({
      openedBy: 'system',
      onBehalfOfUserId: scenario.bookerUserId,
      meetingId,
      trigger: 'lifecycle_sweep',
    });
    expect(accrued.createdAt.getTime()).toBe(onBehalf.createdAt.getTime());
    expect(settled.createdAt.getTime()).toBe(onBehalf.createdAt.getTime());
  });

  it('⚠ a 40-minute wait bills the floor FLAT', async () => {
    const scenario = await seedScenario();
    const start = freshScheduledStart();
    const meetingId = await bookCaseMeeting(scenario, { start, minutes: 60 });

    await joined(meetingId, asUser(scenario.expertUserId), start);
    // No tick lands until minute 40 — the expert held the room the whole time.
    await lifecycleTick(plusMinutes(start, 40));
    await expectTerminatedBy(meetingId, NO_SHOW_RULE);

    const session = await expectBilledExactlyTheFloor(meetingId, scenario.bookerUserId);
    expect(session.actualMinutes).toBe(40);
  });

  it('⚠ the expert pressed End after the floor, before the next tick — paid the floor', async () => {
    const scenario = await seedScenario();
    const start = freshScheduledStart();
    const meetingId = await bookCaseMeeting(scenario, { start });

    await joined(meetingId, asUser(scenario.expertUserId), start);
    await lifecycleTick(plusMinutes(start, FLOOR - 1));

    const ended = await endMeeting({
      meetingId,
      userId: scenario.expertUserId,
      now: plusMinutes(start, FLOOR + 0.5),
    });
    expect(ended).toMatchObject({ ok: true, alreadyEnded: false });
    await expectTerminatedBy(meetingId, { endedBy: 'expert_host', outcome: null });

    await expectBilledExactlyTheFloor(meetingId, scenario.bookerUserId);
  });

  it('⚠ the expert left after the floor, before the next tick (abandoned_wait rule) — paid the floor', async () => {
    const scenario = await seedScenario();
    const start = freshScheduledStart();
    const meetingId = await bookCaseMeeting(scenario, { start });

    await joined(meetingId, asUser(scenario.expertUserId), start);
    await lifecycleTick(plusMinutes(start, FLOOR - 1));
    await left(meetingId, asUser(scenario.expertUserId), plusMinutes(start, FLOOR + 0.5));
    await lifecycleTick(plusMinutes(start, FLOOR + 1));
    expect((await mustFindMeeting(meetingId)).status).toBe('waiting_for_participants');

    await lifecycleTick(plusMinutes(start, FLOOR + 1 + IDLE_END_MINUTES));
    await expectTerminatedBy(meetingId, ABANDONED_WAIT_RULE);

    await expectBilledExactlyTheFloor(meetingId, scenario.bookerUserId);
  });

  it('⚠⚠ D6.4 — a client member who never joined cannot End before the floor; the no-show still bills the floor', async () => {
    const scenario = await seedScenario();
    const start = freshScheduledStart();
    const meetingId = await bookCaseMeeting(scenario, { start });

    await joined(meetingId, asUser(scenario.expertUserId), start);

    const refused = await endMeeting({
      meetingId,
      userId: scenario.bookerUserId,
      now: plusMinutes(start, 10),
    });
    expect(refused).toEqual({ ok: false, code: 'meeting_not_joined' });
    expect((await mustFindMeeting(meetingId)).status).toBe('waiting_for_participants');

    await lifecycleTick(plusMinutes(start, FLOOR));
    await expectTerminatedBy(meetingId, NO_SHOW_RULE);

    await expectBilledExactlyTheFloor(meetingId, scenario.bookerUserId);
  });

  it('⚠ D6.4 — a client member who DID join and ends early settles as held at the floor', async () => {
    const scenario = await seedScenario();
    const start = freshScheduledStart();
    const meetingId = await bookCaseMeeting(scenario, { start });

    await admitMember(meetingId, scenario.bookerUserId);
    await joined(meetingId, asUser(scenario.expertUserId), start);
    await joined(meetingId, asUser(scenario.bookerUserId), plusMinutes(start, 1));

    const ended = await endMeeting({
      meetingId,
      userId: scenario.bookerUserId,
      now: plusMinutes(start, 5),
    });
    expect(ended).toMatchObject({ ok: true, alreadyEnded: false, endedBy: 'client_principal' });
    await expectTerminatedBy(meetingId, { endedBy: 'client_principal', outcome: null });

    const session = await theOnlySession(meetingId);
    expect(session.settlementShape).toBe('held');
    expect(session.connectedMinutes).toBe(FLOOR);
    const consumed = await consumeRows(session.id);
    expect(consumed).toHaveLength(FLOOR);
    expect(sumMinor(consumed)).toBe(-FLOOR * CLIENT_RATE);
  });

  it('⚠ D6.4 — a client member who joined, with the expert never joining, ends as missed_call at zero', async () => {
    const scenario = await seedScenario();
    const start = freshScheduledStart();
    const meetingId = await bookCaseMeeting(scenario, { start });

    await admitMember(meetingId, scenario.bookerUserId);
    await joined(meetingId, asUser(scenario.bookerUserId), plusMinutes(start, 1));

    const ended = await endMeeting({
      meetingId,
      userId: scenario.bookerUserId,
      now: plusMinutes(start, 5),
    });
    expect(ended).toMatchObject({ ok: true, alreadyEnded: false, endedBy: 'client_principal' });
    await expectTerminatedBy(meetingId, { endedBy: 'client_principal', outcome: null });

    const session = await theOnlySession(meetingId);
    expect(session.settlementShape).toBe('missed_call');
    expect(session.connectedMinutes).toBe(0);
    expect(await consumeRows(session.id)).toHaveLength(0);
    expect(await walletBalance(scenario.parties.companyId)).toBe(FUNDED_BALANCE_MINOR);
    expect((await mustFindMeeting(meetingId)).outcome).toBe('missed_call');
  });

  it('⚠ D8.7 — a never-joined client member pressing End on a meeting the expert already ended gets the idempotent success', async () => {
    const scenario = await seedScenario();
    const start = freshScheduledStart();
    const meetingId = await bookCaseMeeting(scenario, { start });

    await joined(meetingId, asUser(scenario.expertUserId), start);
    const expertEnd = await endMeeting({
      meetingId,
      userId: scenario.expertUserId,
      now: plusMinutes(start, FLOOR + 1),
    });
    expect(expertEnd).toMatchObject({ ok: true, alreadyEnded: false });

    const lateEnd = await endMeeting({
      meetingId,
      userId: scenario.bookerUserId,
      now: plusMinutes(start, FLOOR + 2),
    });
    expect(lateEnd).toEqual({ ok: true, status: 'ended', alreadyEnded: true, endedBy: null });
  });

  it('⚠ idempotent: a second tick, a human End and the backstop open nothing further', async () => {
    const scenario = await seedScenario();
    const start = freshScheduledStart();
    const meetingId = await bookCaseMeeting(scenario, { start });

    await joined(meetingId, asUser(scenario.expertUserId), start);
    await lifecycleTick(plusMinutes(start, FLOOR));
    await expectTerminatedBy(meetingId, NO_SHOW_RULE);

    await lifecycleTick(plusMinutes(start, FLOOR + 1));
    const humanEnd = await endMeeting({
      meetingId,
      userId: scenario.expertUserId,
      now: plusMinutes(start, FLOOR + 2),
    });
    expect(humanEnd).toMatchObject({ ok: true, alreadyEnded: true });
    await backstopTick(plusMinutes(start, FLOOR + 3));

    const session = await expectBilledExactlyTheFloor(meetingId, scenario.bookerUserId);
    expect(await auditRows('credit_session', session.id, OPENED_ON_BEHALF_ACTION)).toHaveLength(1);
    const payouts = await db
      .select({ id: expertPayoutRecords.id })
      .from(expertPayoutRecords)
      .where(eq(expertPayoutRecords.sessionId, session.id));
    expect(payouts).toHaveLength(1);
    expect(await markersFor(meetingId)).toHaveLength(0);
  });

  it('⚠ no card, no balance, no wallet row: the wallet is provisioned and the no-show settles into a receivable of exactly the floor, never a silent zero', async () => {
    const scenario = await seedScenario(null);
    const { companyId } = scenario.parties;
    const start = freshScheduledStart();
    const meetingId = await bookCaseMeeting(scenario, { start });
    expect(await creditWalletsRepository.findByCompanyId(companyId)).toBeUndefined();

    await joined(meetingId, asUser(scenario.expertUserId), start);
    await lifecycleTick(plusMinutes(start, FLOOR));
    await expectTerminatedBy(meetingId, NO_SHOW_RULE);

    const session = await expectBilledExactlyTheFloor(meetingId, scenario.bookerUserId);
    expect(await walletBalance(companyId)).toBe(-FLOOR * CLIENT_RATE);
    expect(session.overdraftSettledMinor).toBe(FLOOR * CLIENT_RATE);
    expect(session.settlementStatus).toBe('failed');
    expect(await openReceivables(companyId)).toEqual([
      { sessionId: session.id, amountMinor: FLOOR * CLIENT_RATE },
    ]);
    expect(mockCreateOffSessionCharge).not.toHaveBeenCalled();
  });

  it('⚠ an open receivable does not stop the no-show, and the prior debt is not re-billed', async () => {
    // A prior consultation overran a card-less wallet: +4,000, held 20 minutes ⇒ −10,000 ⇒ R1.
    const priorFundedMinor = 4_000;
    const scenario = await seedScenario(priorFundedMinor);
    const { companyId } = scenario.parties;
    const start = freshScheduledStart();
    const priorStart = plusMinutes(start, -120);
    const priorMeetingId = await bookCaseMeeting(scenario, { start: priorStart, minutes: 5 });

    await admitMember(priorMeetingId, scenario.bookerUserId);
    await joined(priorMeetingId, asUser(scenario.expertUserId), priorStart);
    await joined(priorMeetingId, asUser(scenario.bookerUserId), priorStart);
    await left(priorMeetingId, asUser(scenario.bookerUserId), plusMinutes(priorStart, 20));
    await left(priorMeetingId, asUser(scenario.expertUserId), plusMinutes(priorStart, 20));
    const priorEnd = await endMeeting({
      meetingId: priorMeetingId,
      userId: scenario.bookerUserId,
      now: plusMinutes(priorStart, 21),
    });
    expect(priorEnd).toMatchObject({ ok: true, alreadyEnded: false });
    await expectTerminatedBy(priorMeetingId, { endedBy: 'client_principal', outcome: null });

    const priorSession = await theOnlySession(priorMeetingId);
    const priorDebtMinor = 20 * CLIENT_RATE - priorFundedMinor;
    expect(await walletBalance(companyId)).toBe(-priorDebtMinor);
    expect(await openReceivables(companyId)).toEqual([
      { sessionId: priorSession.id, amountMinor: priorDebtMinor },
    ]);

    // The no-show, with the account on hold.
    const meetingId = await bookCaseMeeting(scenario, { start });
    await joined(meetingId, asUser(scenario.expertUserId), start);
    await lifecycleTick(plusMinutes(start, FLOOR));
    await expectTerminatedBy(meetingId, NO_SHOW_RULE);

    const session = await expectBilledExactlyTheFloor(meetingId, scenario.bookerUserId);
    const floorMinor = FLOOR * CLIENT_RATE;
    // THIS session's share — never the wallet's whole negative balance (that would be
    // priorDebtMinor + floorMinor, re-billing R1).
    expect(session.overdraftSettledMinor).toBe(floorMinor);
    expect(await walletBalance(companyId)).toBe(-(priorDebtMinor + floorMinor));

    const receivables = await openReceivables(companyId);
    expect(receivables).toHaveLength(2);
    expect(receivables).toEqual(
      expect.arrayContaining([
        { sessionId: priorSession.id, amountMinor: priorDebtMinor },
        { sessionId: session.id, amountMinor: floorMinor },
      ])
    );
    expect(sumMinor(receivables)).toBe(priorDebtMinor + floorMinor);
  });

  it('⚠ the client resolved the case while the expert waited — the floor is still billed', async () => {
    const scenario = await seedScenario();
    const start = freshScheduledStart();
    const meetingId = await bookCaseMeeting(scenario, { start });

    await joined(meetingId, asUser(scenario.expertUserId), start);
    await caseEngagementsRepository.close({
      engagementId: scenario.parties.caseEngagementId,
      reason: 'resolved',
      userId: scenario.bookerUserId,
    });
    expect((await engagementsRepository.findById(scenario.parties.caseEngagementId))?.status).toBe(
      'completed'
    );

    await lifecycleTick(plusMinutes(start, FLOOR));
    await expectTerminatedBy(meetingId, NO_SHOW_RULE);

    await expectBilledExactlyTheFloor(meetingId, scenario.bookerUserId);
  });

  it('⚠ D10.5 — a case the client closed BEFORE the meeting started is NOT billed: a not_billable marker, no session, no alarm, and the backstop never retries it', async () => {
    const scenario = await seedScenario();
    // The meeting starts an hour in the REAL future, so the close below (stamped from the real clock)
    // lands strictly before `scheduled_start`; the sweep ticks are driven with explicit instants.
    const start = plusHours(freshScheduledStart(), 2);
    const meetingId = await bookCaseMeeting(scenario, { start });

    await caseEngagementsRepository.close({
      engagementId: scenario.parties.caseEngagementId,
      reason: 'resolved',
      userId: scenario.bookerUserId,
    });

    // The expert holds a token minted while the case was open and waits at the start.
    await joined(meetingId, asUser(scenario.expertUserId), start);
    await lifecycleTick(plusMinutes(start, FLOOR));
    await expectTerminatedBy(meetingId, NO_SHOW_RULE);

    expect(await sessionsFor(meetingId)).toHaveLength(0);
    expect(await walletBalance(scenario.parties.companyId)).toBe(FUNDED_BALANCE_MINOR);
    const marker = await theOnlyMarker(meetingId);
    expect(marker.actorUserId).toBeNull();
    expect(marker.metadata).toMatchObject({
      disposition: 'not_billable',
      reason: 'case_closed_before_start',
      shape: 'no_show_client',
      trigger: 'lifecycle_sweep',
    });
    expect((await mustFindMeeting(meetingId)).outcome).toBe('no_show_client');
    expect(mockRaiseAdminAlert).not.toHaveBeenCalled();

    // The marker takes the row out of the backstop's finder for good.
    await backstopTick(plusMinutes(start, FLOOR + 5));
    expect(await sessionsFor(meetingId)).toHaveLength(0);
    expect(await markersFor(meetingId)).toHaveLength(1);
    expect(mockRaiseAdminAlert).not.toHaveBeenCalled();
  });

  it('⚠ durability: a deferred open is opened and settled by the backstop', async () => {
    const scenario = await seedScenario();
    const start = freshScheduledStart();
    const meetingId = await bookCaseMeeting(scenario, { start });

    // Another Case consultation holds the wallet's one live session at the no-show tick. It
    // starts later, so its own missed-call rule is still unarmed at that tick.
    const busyStart = plusMinutes(start, 10);
    const busyMeetingId = await bookCaseMeeting(scenario, { start: busyStart });
    await admitMember(busyMeetingId, scenario.bookerUserId);
    const busySession = await theOnlySession(busyMeetingId);
    expect(busySession.status).toBe('pending');
    await joined(busyMeetingId, asUser(scenario.bookerUserId), busyStart);

    await joined(meetingId, asUser(scenario.expertUserId), start);
    await lifecycleTick(plusMinutes(start, FLOOR));
    await expectTerminatedBy(meetingId, NO_SHOW_RULE);
    expect(await sessionsFor(meetingId)).toHaveLength(0);
    expect((await mustFindMeeting(busyMeetingId)).status).toBe('waiting_for_participants');

    // Free the wallet: the busy consultation is ended by its client, who joined it.
    const busyEnd = await endMeeting({
      meetingId: busyMeetingId,
      userId: scenario.bookerUserId,
      now: plusMinutes(start, FLOOR + 1),
    });
    expect(busyEnd).toMatchObject({ ok: true, alreadyEnded: false });
    expect((await theOnlySession(busyMeetingId)).status).toBe('ended');

    await backstopTick(plusMinutes(start, FLOOR + 3));

    await expectBilledExactlyTheFloor(meetingId, scenario.bookerUserId);
  });

  it('⚠ durability: a crash between endMeeting and settlement is recovered by the backstop', async () => {
    const scenario = await seedScenario();
    const start = freshScheduledStart();
    const meetingId = await bookCaseMeeting(scenario, { start });

    await joined(meetingId, asUser(scenario.expertUserId), start);
    // The sweep's terminal write commits; the process dies before the settle call.
    const ended = await meetingsRepository.endMeeting({
      id: meetingId,
      outcome: 'no_show_client',
      endedBy: 'system_idle',
      endedAt: plusMinutes(start, FLOOR),
      actorUserId: null,
    });
    expect(ended?.meeting.status).toBe('ended');
    await expectTerminatedBy(meetingId, NO_SHOW_RULE);
    expect(await sessionsFor(meetingId)).toHaveLength(0);

    await backstopTick(plusMinutes(start, FLOOR + 3));

    await expectBilledExactlyTheFloor(meetingId, scenario.bookerUserId);
  });

  it('⚠ retry exhaustion: the first attempt past 25h marks and alarms once, even after missed ticks', async () => {
    const scenario = await seedScenario();
    const start = freshScheduledStart();
    const meetingId = await bookCaseMeeting(scenario, { start });

    // A permanently busy wallet: a consultation starting ten minutes later whose client was already
    // admitted, so its pending session holds the wallet for the whole of this test. (It sits INSIDE the
    // join window at admission: a far-future call opens no session — D10.4 — so it could not hold it.)
    const busyMeetingId = await bookCaseMeeting(scenario, { start: plusMinutes(start, 10) });
    await admitMember(busyMeetingId, scenario.bookerUserId);
    expect((await theOnlySession(busyMeetingId)).status).toBe('pending');

    await joined(meetingId, asUser(scenario.expertUserId), start);
    await lifecycleTick(plusMinutes(start, FLOOR));
    await expectTerminatedBy(meetingId, NO_SHOW_RULE);
    await backstopTick(plusMinutes(start, FLOOR + 3));
    await backstopTick(plusHours(start, 24));
    expect(await markersFor(meetingId)).toHaveLength(0);
    expect(mockRaiseAdminAlert).not.toHaveBeenCalled();

    // No tick runs between +24h and +30h.
    await backstopTick(plusHours(start, 30));

    const marker = await theOnlyMarker(meetingId);
    expect(marker.actorUserId).toBeNull();
    expect(marker.metadata).toMatchObject({
      disposition: 'retry_exhausted',
      reason: 'session_in_progress',
      trigger: 'backstop',
    });
    expectOneOpenRefusedAlert(meetingId, 'retry_exhausted');
    expect(await sessionsFor(meetingId)).toHaveLength(0);

    await backstopTick(plusHours(start, 31));

    expect(await markersFor(meetingId)).toHaveLength(1);
    expectOneOpenRefusedAlert(meetingId, 'retry_exhausted');
    expect(await sessionsFor(meetingId)).toHaveLength(0);
  });

  it('⚠ a NULL booker refuses and alarms once — never a fabricated actor', async () => {
    const scenario = await seedScenario();
    const start = freshScheduledStart();
    const meetingId = await bookCaseMeeting(scenario, { start, booker: null });
    const booked = await auditRows('meeting', meetingId, 'meeting.booked');
    expect(booked).toHaveLength(1);
    expect(booked[0]?.actorUserId).toBeNull();

    await joined(meetingId, asUser(scenario.expertUserId), start);
    await lifecycleTick(plusMinutes(start, FLOOR));
    await expectTerminatedBy(meetingId, NO_SHOW_RULE);

    expect(await sessionsFor(meetingId)).toHaveLength(0);
    const marker = await theOnlyMarker(meetingId);
    expect(marker.actorUserId).toBeNull();
    expect(marker.metadata).toMatchObject({
      disposition: 'refused',
      reason: 'booker_unattributable',
      shape: 'no_show_client',
      trigger: 'lifecycle_sweep',
    });
    expectOneOpenRefusedAlert(meetingId, 'booker_unattributable');

    await backstopTick(plusMinutes(start, FLOOR + 3));

    expect(await sessionsFor(meetingId)).toHaveLength(0);
    expect(await markersFor(meetingId)).toHaveLength(1);
    expectOneOpenRefusedAlert(meetingId, 'booker_unattributable');
  });
});

describe('…and a sessionless HELD Case call is billed post-hoc', () => {
  it('a guest-only call whose admission open was refused is billed at meeting end', async () => {
    const scenario = await seedScenario();
    const start = freshScheduledStart();
    const meetingId = await bookCaseMeeting(scenario, { start });
    const meeting = await mustFindMeeting(meetingId);
    const { guestId, rawToken } = await inviteClientGuest(
      meetingId,
      scenario.bookerUserId,
      meeting.scheduledEnd
    );

    // At the guest's admission the wallet's one live session belongs to another consultation,
    // so the admission-time open is refused `session_in_progress`.
    const busyMeetingId = await bookCaseMeeting(scenario, { start });
    await admitMember(busyMeetingId, scenario.bookerUserId);
    await joined(busyMeetingId, asUser(scenario.bookerUserId), start);

    await admitGuest(meetingId, rawToken);
    expect(await sessionsFor(meetingId)).toHaveLength(0);
    expect(mockRaiseAdminAlert).not.toHaveBeenCalled();

    await joined(meetingId, asUser(scenario.expertUserId), start);
    await joined(meetingId, asGuest(guestId), start);
    expect((await mustFindMeeting(meetingId)).status).toBe('in_progress');

    // The busy consultation's expert never comes: its missed-call rule frees the wallet.
    await lifecycleTick(plusMinutes(start, MISSED_CALL_MINUTES));
    await expectTerminatedBy(busyMeetingId, MISSED_CALL_RULE);
    expect((await theOnlySession(busyMeetingId)).status).toBe('ended');
    expect((await mustFindMeeting(meetingId)).status).toBe('in_progress');
    expect(await sessionsFor(meetingId)).toHaveLength(0);

    await left(meetingId, asGuest(guestId), plusMinutes(start, 20));
    await left(meetingId, asUser(scenario.expertUserId), plusMinutes(start, 20));
    await lifecycleTick(plusMinutes(start, 20 + IDLE_END_MINUTES));
    await expectTerminatedBy(meetingId, IDLE_END_RULE);

    const session = await theOnlySession(meetingId);
    expect(session.openedBy).toBe('system');
    expect(session.initiatingMemberId).toBe(scenario.bookerUserId);
    expect(session.settlementShape).toBe('held');
    expect(session.connectedMinutes).toBe(20);
    const consumed = await consumeRows(session.id);
    expect(consumed).toHaveLength(20);
    expect(sumMinor(consumed)).toBe(-20 * CLIENT_RATE);
    expect(session.expertAccruedMinor).toBe(20 * EXPERT_RATE);
  });

  it('a guest invited by the delivering expert does not make the call billable (D5.9)', async () => {
    const scenario = await seedScenario();
    const { companyId } = scenario.parties;
    // The delivering expert is ALSO a member of the client company, so the guest they invite
    // is resolved to the CLIENT side.
    await db
      .insert(companyMembers)
      .values({ companyId, userId: scenario.expertUserId, role: 'member' });
    const start = freshScheduledStart();
    const meetingId = await bookCaseMeeting(scenario, { start });
    const meeting = await mustFindMeeting(meetingId);
    const { guestId, rawToken } = await inviteClientGuest(
      meetingId,
      scenario.expertUserId,
      meeting.scheduledEnd
    );

    await admitGuest(meetingId, rawToken);
    await joined(meetingId, asUser(scenario.expertUserId), start);
    await joined(meetingId, asGuest(guestId), start);
    expect((await mustFindMeeting(meetingId)).status).toBe('in_progress');

    await left(meetingId, asGuest(guestId), plusMinutes(start, 20));
    await left(meetingId, asUser(scenario.expertUserId), plusMinutes(start, 20));
    await lifecycleTick(plusMinutes(start, 20 + IDLE_END_MINUTES));
    await expectTerminatedBy(meetingId, IDLE_END_RULE);

    expect(await sessionsFor(meetingId)).toHaveLength(0);
    const marker = await theOnlyMarker(meetingId);
    expect(marker.actorUserId).toBeNull();
    expect(marker.metadata).toMatchObject({
      disposition: 'not_billable',
      reason: 'expert_invited_guest_only',
      shape: 'held',
      trigger: 'lifecycle_sweep',
    });
    expect(await walletBalance(companyId)).toBe(FUNDED_BALANCE_MINOR);
  });
});

describe('…while the zero shapes still consume nothing, and never alarm', () => {
  it('the expert who never joined consumes nothing — end to end', async () => {
    const scenario = await seedScenario();
    const start = freshScheduledStart();
    const meetingId = await bookCaseMeeting(scenario, { start });

    await lifecycleTick(plusMinutes(start, MISSED_CALL_MINUTES));
    await expectTerminatedBy(meetingId, MISSED_CALL_RULE);

    expect((await mustFindMeeting(meetingId)).outcome).toBe('missed_call');
    expect(await sessionsFor(meetingId)).toHaveLength(0);
    expect(await walletBalance(scenario.parties.companyId)).toBe(FUNDED_BALANCE_MINOR);
    const marker = await theOnlyMarker(meetingId);
    expect(marker.actorUserId).toBeNull();
    expect(marker.metadata).toMatchObject({
      disposition: 'not_billable',
      reason: 'missed_call',
      shape: 'missed_call',
      trigger: 'lifecycle_sweep',
    });
    expect(mockRaiseAdminAlert).not.toHaveBeenCalled();
  });

  it('an expert who left below the floor consumes nothing — end to end', async () => {
    const scenario = await seedScenario();
    const start = freshScheduledStart();
    const meetingId = await bookCaseMeeting(scenario, { start });

    await joined(meetingId, asUser(scenario.expertUserId), start);
    await left(meetingId, asUser(scenario.expertUserId), plusMinutes(start, 8));
    await lifecycleTick(plusMinutes(start, 8 + IDLE_END_MINUTES));
    await expectTerminatedBy(meetingId, ABANDONED_WAIT_RULE);

    expect(await sessionsFor(meetingId)).toHaveLength(0);
    expect(await walletBalance(scenario.parties.companyId)).toBe(FUNDED_BALANCE_MINOR);
    expect((await mustFindMeeting(meetingId)).outcome).toBe('completed');

    const marker = await theOnlyMarker(meetingId);
    expect(marker.metadata).toMatchObject({
      disposition: 'not_billable',
      reason: 'abandoned_wait',
      shape: 'abandoned_wait',
      trigger: 'lifecycle_sweep',
    });
    const resolved = await auditRows('meeting', meetingId, 'meeting.outcome_resolved');
    expect(resolved).toHaveLength(1);
    const [outcomeRow] = resolved;
    if (outcomeRow === undefined) {
      throw new Error('unreachable: one outcome row asserted above');
    }
    expect(outcomeRow.actorUserId).toBeNull();
    expect(outcomeRow.metadata).toEqual({ outcome: 'completed' });
    expect(outcomeRow.createdAt.getTime()).toBe(marker.createdAt.getTime());
    expect(mockRaiseAdminAlert).not.toHaveBeenCalled();
  });

  it('⚠ BAL-581 — a meeting whose room was never provisioned consumes nothing and is never labelled missed_call', async () => {
    const scenario = await seedScenario();
    const start = freshScheduledStart();
    const meetingId = await bookCaseMeeting(scenario, { start, venue: false });

    await lifecycleTick(plusMinutes(start, MISSED_CALL_MINUTES));
    await expectTerminatedBy(meetingId, VENUE_UNAVAILABLE_RULE);

    expect((await mustFindMeeting(meetingId)).outcome).toBe('venue_unavailable');
    expect(await sessionsFor(meetingId)).toHaveLength(0);
    expect(await walletBalance(scenario.parties.companyId)).toBe(FUNDED_BALANCE_MINOR);
    const marker = await theOnlyMarker(meetingId);
    expect(marker.metadata).toMatchObject({
      disposition: 'not_billable',
      reason: 'missed_call',
      shape: 'missed_call',
      trigger: 'lifecycle_sweep',
    });
    expect(mockRaiseAdminAlert).not.toHaveBeenCalled();
  });

  it('⚠ BAL-581 — the expert Ending a roomless meeting resolves venue_unavailable, never missed_call, and bills nothing', async () => {
    const scenario = await seedScenario();
    const start = freshScheduledStart();
    const meetingId = await bookCaseMeeting(scenario, { start, venue: false });

    const ended = await endMeeting({
      meetingId,
      userId: scenario.expertUserId,
      now: plusMinutes(start, 5),
    });
    expect(ended).toMatchObject({ ok: true, alreadyEnded: false });
    await expectTerminatedBy(meetingId, { endedBy: 'expert_host', outcome: null });

    expect((await mustFindMeeting(meetingId)).outcome).toBe('venue_unavailable');
    expect(await sessionsFor(meetingId)).toHaveLength(0);
    expect(await walletBalance(scenario.parties.companyId)).toBe(FUNDED_BALANCE_MINOR);
    const marker = await theOnlyMarker(meetingId);
    expect(marker.metadata).toMatchObject({
      disposition: 'not_billable',
      shape: 'missed_call',
      trigger: 'human_end',
    });
    expect(mockRaiseAdminAlert).not.toHaveBeenCalled();
  });

  it('⚠ a missed_call meeting whose engagement row is gone is marked not_billable, never alarmed', async () => {
    const scenario = await seedScenario();
    const start = freshScheduledStart();
    const meetingId = await bookCaseMeeting(scenario, { start });

    await db.transaction((tx) => softDeleteEngagementTx(tx, scenario.parties.caseEngagementId));
    expect(await engagementsRepository.findById(scenario.parties.caseEngagementId)).toBeUndefined();

    await lifecycleTick(plusMinutes(start, MISSED_CALL_MINUTES));
    await expectTerminatedBy(meetingId, MISSED_CALL_RULE);

    expect((await mustFindMeeting(meetingId)).outcome).toBe('missed_call');
    expect(await sessionsFor(meetingId)).toHaveLength(0);
    const marker = await theOnlyMarker(meetingId);
    expect(marker.metadata).toMatchObject({
      disposition: 'not_billable',
      reason: 'missed_call',
      shape: 'missed_call',
    });
    expect(mockRaiseAdminAlert).not.toHaveBeenCalled();
  });
});

// ── Atomicity ──────────────────────────────────────────────────────────────────────────────────
//
// `created_at` equality cannot prove "same transaction" under the rollback harness (every write shares
// `transaction_timestamp()`), so atomicity is proven by FAILURE: a `BEFORE INSERT` trigger makes ONE
// audit write of the group throw, and everything the same transaction wrote must have gone with it.
// Moving the audit write out of the transaction (or the session insert out of it) turns these red.

/** Make every insert of an `audit_events` row with this action raise. Rolled back with the test. */
async function failAuditInsertsFor(action: string): Promise<void> {
  const functionName = `bal474_block_${randomUUID().replaceAll('-', '')}`;
  await db.execute(
    sql.raw(`
      CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = '${action}' THEN
          RAISE EXCEPTION 'bal474 test: audit insert blocked for ${action}';
        END IF;
        RETURN NEW;
      END $$;
    `)
  );
  await db.execute(
    sql.raw(`
      CREATE TRIGGER ${functionName} BEFORE INSERT ON audit_events
      FOR EACH ROW EXECUTE FUNCTION ${functionName}();
    `)
  );
}

describe('ATOMICITY — the open, its provenance and the settlement commit together or not at all', () => {
  it('⚠ a failing provenance audit row leaves NO session, NO ledger row and NO debit behind (open + settle are one transaction)', async () => {
    const scenario = await seedScenario();
    const start = freshScheduledStart();
    const meetingId = await bookCaseMeeting(scenario, { start });
    await failAuditInsertsFor(OPENED_ON_BEHALF_ACTION);

    await joined(meetingId, asUser(scenario.expertUserId), start);
    // The sweep swallows a per-meeting settlement fault into a log line; the meeting still ends.
    await lifecycleTick(plusMinutes(start, FLOOR));
    await expectTerminatedBy(meetingId, NO_SHOW_RULE);

    // The direct call surfaces the very failure the sweep swallowed — so the trigger really fired.
    await expect(
      settleSessionlessCaseMeeting({
        meetingId,
        trigger: 'backstop',
        actorUserId: null,
        now: plusMinutes(start, FLOOR + 5),
      })
    ).rejects.toThrow(/audit insert blocked/);

    expect(await sessionsFor(meetingId)).toHaveLength(0);
    expect(await walletBalance(scenario.parties.companyId)).toBe(FUNDED_BALANCE_MINOR);
    expect(await markersFor(meetingId)).toHaveLength(0);
  });

  it('⚠ a failing marker audit row leaves meetings.outcome UNRESOLVED (the marker and the outcome are one transaction)', async () => {
    const scenario = await seedScenario();
    const start = freshScheduledStart();
    const meetingId = await bookCaseMeeting(scenario, { start });
    await failAuditInsertsFor(SESSIONLESS_MARKER_ACTION);

    await joined(meetingId, asUser(scenario.expertUserId), start);
    await left(meetingId, asUser(scenario.expertUserId), plusMinutes(start, 8));
    await lifecycleTick(plusMinutes(start, 8 + IDLE_END_MINUTES));
    await expectTerminatedBy(meetingId, ABANDONED_WAIT_RULE);

    expect(await markersFor(meetingId)).toHaveLength(0);
    expect((await mustFindMeeting(meetingId)).outcome).toBeNull();
    expect(await auditRows('meeting', meetingId, 'meeting.outcome_resolved')).toHaveLength(0);
  });
});

// ── RULE A (D13) — before the start only time TOGETHER bills; the meter starts AT the start ─────────
//
// Presence instants are passed explicitly (the sweeps and the writer take `now`), but ADMISSION reads
// the real clock — the D10.4 join window is measured from `new Date()`. So every scenario below is
// laid out around a `T` that is a chosen number of minutes AHEAD of the real clock: 10 minutes ahead
// is INSIDE the join window (admission opens a pending session), 30 minutes ahead is OUTSIDE it
// (admission opens nothing). T is minute-aligned; every other instant is `T ± n` minutes.

/** A minute-aligned scheduled start `minutesAhead` minutes after the real clock. */
function startAhead(minutesAhead: number): Date {
  const minute = Math.floor(Date.now() / MS_PER_MINUTE) * MS_PER_MINUTE;
  return new Date(minute + minutesAhead * MS_PER_MINUTE);
}

// D16 — the join window is 3 minutes: an admission must be inside it, so this is the largest start-ahead that is.
const IN_WINDOW_MINUTES_AHEAD = 2;
const OUTSIDE_WINDOW_MINUTES_AHEAD = 30;

/** The wall-clock start of the meter, as the session row records it. */
async function connectedAtOf(meetingId: string): Promise<Date | null> {
  return (await theOnlySession(meetingId)).connectedAt;
}

async function holdStatusOf(holdId: string | null): Promise<string | undefined> {
  if (holdId === null) return undefined;
  const [hold] = await db.select().from(creditHolds).where(eq(creditHolds.id, holdId));
  return hold?.status;
}

/** The `presence_settled` audit row's metadata — the settlement's own reasoning record. */
async function presenceSettledMetadata(sessionId: string): Promise<Record<string, unknown>> {
  const rows = await auditRows('credit_session', sessionId, PRESENCE_SETTLED_ACTION);
  expect(rows).toHaveLength(1);
  return (rows[0]?.metadata ?? {}) as Record<string, unknown>;
}

describe('INVARIANT (F12): no presence session meters before its meeting’s scheduled start', () => {
  /** In-window admission, then the expert and the booker co-present from T−10 (D13's "09:50"). */
  async function earlyCoPresence(): Promise<{
    readonly scenario: Scenario;
    readonly start: Date;
    readonly meetingId: string;
  }> {
    const scenario = await seedScenario();
    const start = startAhead(IN_WINDOW_MINUTES_AHEAD);
    const meetingId = await bookCaseMeeting(scenario, { start, minutes: 60 });
    await admitMember(meetingId, scenario.bookerUserId);
    expect((await theOnlySession(meetingId)).status).toBe('pending');
    await joined(meetingId, asUser(scenario.expertUserId), plusMinutes(start, -10));
    await joined(meetingId, asUser(scenario.bookerUserId), plusMinutes(start, -10));
    return { scenario, start, meetingId };
  }

  it('(a) both present from T−10, with a pending session: at T−5 it is STILL pending and has no connect instant', async () => {
    const { start, meetingId } = await earlyCoPresence();
    // The meeting IS in progress (the co-presence transition is unchanged) — only the METER waits for T.
    expect((await mustFindMeeting(meetingId)).status).toBe('in_progress');
    await backstopTick(plusMinutes(start, -5));

    const session = await theOnlySession(meetingId);
    expect(session.status).toBe('pending');
    expect(session.connectedAt).toBeNull();
    expect(session.connectedMinutes).toBe(0);
    expect(await consumeRows(session.id)).toHaveLength(0);
  });

  it('(b) the billing-start pass at T+30s connects it at EXACTLY T — never at the early co-presence, never at the pass’s own instant', async () => {
    const { start, meetingId } = await earlyCoPresence();

    await backstopTick(plusMinutes(start, 0.5));

    const session = await theOnlySession(meetingId);
    expect(session.status).toBe('active');
    expect(session.connectedAt?.getTime()).toBe(start.getTime());
    // Ticks cover only [T, now): the 30 seconds since T are not yet a whole minute.
    expect(await consumeRows(session.id)).toHaveLength(0);
  });

  it('(c) control — a co-presence that first BEGINS at T+5 connects at T+5, through the writer', async () => {
    const scenario = await seedScenario();
    const start = startAhead(IN_WINDOW_MINUTES_AHEAD);
    const meetingId = await bookCaseMeeting(scenario, { start, minutes: 60 });
    await admitMember(meetingId, scenario.bookerUserId);

    await joined(meetingId, asUser(scenario.expertUserId), plusMinutes(start, 5));
    await joined(meetingId, asUser(scenario.bookerUserId), plusMinutes(start, 5));

    const session = await theOnlySession(meetingId);
    expect(session.status).toBe('active');
    expect(session.connectedAt?.getTime()).toBe(plusMinutes(start, 5).getTime());
  });

  it('(d) NO session (an admission 30 minutes early is refused, so it opened nothing) and both present from T−30: the pass opens ONE on behalf of the PRESENT member — who is NOT the booker — and connects it at T', async () => {
    const scenario = await seedScenario();
    const start = startAhead(OUTSIDE_WINDOW_MINUTES_AHEAD);
    const meetingId = await bookCaseMeeting(scenario, { start, minutes: 60 });
    // The booker never comes; a DIFFERENT live member of the company does.
    const presentMemberId = await addCompanyMember(scenario.parties.companyId);
    expect(presentMemberId).not.toBe(scenario.bookerUserId);
    // D16 — an admission 30 minutes early is REFUSED by the server (`meeting_not_open_yet`), so nothing opens; the
    // presence rows below are Daily webhooks, which the server does not gate.
    await expect(
      joinMeetingAsMember({ meetingId, userId: presentMemberId, minter: testMinter })
    ).resolves.toMatchObject({ ok: false, code: 'meeting_not_open_yet' });
    expect(await sessionsFor(meetingId)).toHaveLength(0);

    await joined(meetingId, asUser(scenario.expertUserId), plusMinutes(start, -30));
    await joined(meetingId, asUser(presentMemberId), plusMinutes(start, -30));
    expect(await sessionsFor(meetingId)).toHaveLength(0);

    await backstopTick(plusMinutes(start, 0.5));

    const session = await theOnlySession(meetingId);
    expect(session.openedBy).toBe('system');
    // ⚠ THE ATTRIBUTION CAN NOW TELL THE TWO ANSWERS APART: the present member, never the booker.
    expect(session.initiatingMemberId).toBe(presentMemberId);
    expect(session.initiatingMemberId).not.toBe(scenario.bookerUserId);
    expect(session.status).toBe('active');
    expect(session.connectedAt?.getTime()).toBe(start.getTime());
    const provenance = await auditRows('credit_session', session.id, OPENED_ON_BEHALF_ACTION);
    expect(provenance).toHaveLength(1);
    expect(provenance[0]?.metadata).toMatchObject({ openedBy: 'system', trigger: 'billing_start' });

    // A second tick never opens a second session.
    await backstopTick(plusMinutes(start, 1.5));
    expect(await sessionsFor(meetingId)).toHaveLength(1);
  });

  it('(e) ⚠ Q1 can never keep a charge for an EMPTY pre-start room: together 1 minute at T−14, both leave, the meter sweep runs every minute — billed 15 (floored), drawn 0', async () => {
    const scenario = await seedScenario();
    const start = startAhead(IN_WINDOW_MINUTES_AHEAD);
    const meetingId = await bookCaseMeeting(scenario, { start, minutes: 60 });
    await admitMember(meetingId, scenario.bookerUserId);

    await joined(meetingId, asUser(scenario.expertUserId), plusMinutes(start, -14));
    await joined(meetingId, asUser(scenario.bookerUserId), plusMinutes(start, -14));
    await left(meetingId, asUser(scenario.expertUserId), plusMinutes(start, -13));
    await left(meetingId, asUser(scenario.bookerUserId), plusMinutes(start, -13));

    for (let minute = -13; minute <= 4; minute += 1) {
      await backstopTick(plusMinutes(start, minute));
    }
    // Nothing metered the empty room, before or after T.
    const beforeEnd = await theOnlySession(meetingId);
    expect(beforeEnd.connectedAt).toBeNull();
    expect(beforeEnd.status).toBe('pending');
    expect(await consumeRows(beforeEnd.id)).toHaveLength(0);

    // The room emptied before T, so the idle end is five minutes after T (an early check-in never ends it).
    await lifecycleTick(plusMinutes(start, IDLE_END_MINUTES - 1));
    expect((await mustFindMeeting(meetingId)).status).toBe('in_progress');
    await lifecycleTick(plusMinutes(start, IDLE_END_MINUTES));
    await expectTerminatedBy(meetingId, IDLE_END_RULE);

    const session = await theOnlySession(meetingId);
    expect(session.settlementShape).toBe('held');
    expect(session.connectedMinutes).toBe(FLOOR);
    const consumed = await consumeRows(session.id);
    expect(consumed).toHaveLength(FLOOR);
    expect(sumMinor(consumed)).toBe(-FLOOR * CLIENT_RATE);
    const settled = await presenceSettledMetadata(session.id);
    // One minute together, floored to 15 — the FLOOR raised it, nothing was drawn beforehand.
    expect(settled).toMatchObject({
      billableMinutes: FLOOR,
      actualMinutes: 1,
      floorApplied: true,
      minutesAlreadyDrawn: 0,
    });
  });
});

describe('INVARIANT (F3, Rule A): D13’s worked examples, through the real writer, meter and settlement', () => {
  it('(f) example 1 — together 09:50–10:40 bills 50: connected at T, actual 50, rule = billed, and the meter drew only from T', async () => {
    const scenario = await seedScenario();
    const start = startAhead(IN_WINDOW_MINUTES_AHEAD);
    const meetingId = await bookCaseMeeting(scenario, { start, minutes: 60 });
    await admitMember(meetingId, scenario.bookerUserId);
    await joined(meetingId, asUser(scenario.expertUserId), plusMinutes(start, -10));
    await joined(meetingId, asUser(scenario.bookerUserId), plusMinutes(start, -10));

    await backstopTick(plusMinutes(start, 0.5));
    expect((await connectedAtOf(meetingId))?.getTime()).toBe(start.getTime());
    // The meter has drawn 40 minutes from T; settlement tops it up by the 10 minutes together before T.
    await backstopTick(plusMinutes(start, 40));
    const drawn = await theOnlySession(meetingId);
    expect(drawn.lastTickSeq).toBe(40);

    const ended = await endMeeting({
      meetingId,
      userId: scenario.expertUserId,
      now: plusMinutes(start, 40),
    });
    expect(ended).toMatchObject({ ok: true, alreadyEnded: false });

    const session = await theOnlySession(meetingId);
    expect(session.settlementShape).toBe('held');
    expect(session.connectedAt?.getTime()).toBe(start.getTime());
    expect(session.connectedMinutes).toBe(50);
    const consumed = await consumeRows(session.id);
    expect(consumed).toHaveLength(50);
    expect(sumMinor(consumed)).toBe(-50 * CLIENT_RATE);
    expect(session.expertAccruedMinor).toBe(50 * EXPERT_RATE);
    const settled = await presenceSettledMetadata(session.id);
    expect(settled).toMatchObject({
      actualMinutes: 50,
      billableMinutes: 50,
      floorApplied: false,
      minutesAlreadyDrawn: 40,
    });
  });

  it('(g) example 2 — together 09:00–09:01, the expert waits alone, the client is back at 10:00, End 11:00 → 61', async () => {
    const scenario = await seedScenario();
    const start = startAhead(IN_WINDOW_MINUTES_AHEAD);
    const meetingId = await bookCaseMeeting(scenario, { start, minutes: 60 });

    await joined(meetingId, asUser(scenario.expertUserId), plusMinutes(start, -60));
    await joined(meetingId, asUser(scenario.bookerUserId), plusMinutes(start, -60));
    await left(meetingId, asUser(scenario.bookerUserId), plusMinutes(start, -59));

    // The client is (re-)admitted inside the join window: a pending session and its hold open.
    await admitMember(meetingId, scenario.bookerUserId);
    expect((await theOnlySession(meetingId)).connectedAt).toBeNull();
    // …and their Daily join at T is what starts the meter — at T, never before.
    await joined(meetingId, asUser(scenario.bookerUserId), start);
    expect((await connectedAtOf(meetingId))?.getTime()).toBe(start.getTime());

    await backstopTick(plusMinutes(start, 60));
    const ended = await endMeeting({
      meetingId,
      userId: scenario.expertUserId,
      now: plusMinutes(start, 60),
    });
    expect(ended).toMatchObject({ ok: true, alreadyEnded: false });

    const session = await theOnlySession(meetingId);
    expect(session.connectedMinutes).toBe(61);
    expect(await consumeRows(session.id)).toHaveLength(61);
    expect(await presenceSettledMetadata(session.id)).toMatchObject({
      actualMinutes: 61,
      billableMinutes: 61,
    });
  });

  it('(h) example 4 — together 09:30–09:55, nobody returns: NO session ever, and the idle end at 10:05 bills 25 (sessionless)', async () => {
    const scenario = await seedScenario();
    const start = startAhead(OUTSIDE_WINDOW_MINUTES_AHEAD);
    const meetingId = await bookCaseMeeting(scenario, { start, minutes: 60 });

    await joined(meetingId, asUser(scenario.expertUserId), plusMinutes(start, -30));
    await joined(meetingId, asUser(scenario.bookerUserId), plusMinutes(start, -30));
    await left(meetingId, asUser(scenario.expertUserId), plusMinutes(start, -5));
    await left(meetingId, asUser(scenario.bookerUserId), plusMinutes(start, -5));

    await lifecycleTick(plusMinutes(start, IDLE_END_MINUTES - 1));
    expect((await mustFindMeeting(meetingId)).status).toBe('in_progress');
    await lifecycleTick(plusMinutes(start, IDLE_END_MINUTES));
    await expectTerminatedBy(meetingId, IDLE_END_RULE);

    const session = await theOnlySession(meetingId);
    expect(session.openedBy).toBe('system');
    expect(session.settlementShape).toBe('held');
    expect(session.connectedMinutes).toBe(25);
    const consumed = await consumeRows(session.id);
    expect(consumed).toHaveLength(25);
    expect(sumMinor(consumed)).toBe(-25 * CLIENT_RATE);
    expect(session.expertAccruedMinor).toBe(25 * EXPERT_RATE);
  });

  it('(i) ⚠ security N1 — both present from 09:30, the client closes the case before the start, End at 10:40: an ATTENDED call bills held 70; a closure never voids it', async () => {
    const scenario = await seedScenario();
    const start = startAhead(IN_WINDOW_MINUTES_AHEAD);
    const meetingId = await bookCaseMeeting(scenario, { start, minutes: 60 });

    await joined(meetingId, asUser(scenario.expertUserId), plusMinutes(start, -30));
    await joined(meetingId, asUser(scenario.bookerUserId), plusMinutes(start, -30));
    // Stamped from the real clock — strictly BEFORE the meeting's scheduled start.
    await caseEngagementsRepository.close({
      engagementId: scenario.parties.caseEngagementId,
      reason: 'resolved',
      userId: scenario.bookerUserId,
    });

    const ended = await endMeeting({
      meetingId,
      userId: scenario.expertUserId,
      now: plusMinutes(start, 40),
    });
    expect(ended).toMatchObject({ ok: true, alreadyEnded: false });

    expect(await markersFor(meetingId)).toHaveLength(0);
    const session = await theOnlySession(meetingId);
    expect(session.openedBy).toBe('system');
    expect(session.settlementShape).toBe('held');
    expect(session.connectedMinutes).toBe(70);
    expect(await consumeRows(session.id)).toHaveLength(70);
    expect(mockRaiseAdminAlert).not.toHaveBeenCalled();
  });

  it('(j) ⚠ security N4, in the REACHABLE order — a member loads the page in-window, the client closes the case, the expert waits, no-show: the pending session is RELEASED, not charged', async () => {
    const scenario = await seedScenario();
    const start = startAhead(IN_WINDOW_MINUTES_AHEAD);
    const meetingId = await bookCaseMeeting(scenario, { start });

    // A member cannot be admitted AFTER a close (`meeting-liveness`), so the session must already exist.
    await admitMember(meetingId, scenario.bookerUserId);
    const pending = await theOnlySession(meetingId);
    expect(pending.status).toBe('pending');
    expect(await holdStatusOf(pending.holdId)).toBe('active');
    await caseEngagementsRepository.close({
      engagementId: scenario.parties.caseEngagementId,
      reason: 'resolved',
      userId: scenario.bookerUserId,
    });

    await joined(meetingId, asUser(scenario.expertUserId), plusMinutes(start, -5));
    await lifecycleTick(plusMinutes(start, FLOOR));
    await expectTerminatedBy(meetingId, NO_SHOW_RULE);

    const session = await theOnlySession(meetingId);
    expect(session.status).toBe('cancelled');
    expect(await holdStatusOf(session.holdId)).toBe('released');
    expect(await consumeRows(session.id)).toHaveLength(0);
    expect(await walletBalance(scenario.parties.companyId)).toBe(FUNDED_BALANCE_MINOR);
    expect(await openReceivables(scenario.parties.companyId)).toHaveLength(0);
    const marker = await theOnlyMarker(meetingId);
    expect(marker.metadata).toMatchObject({
      disposition: 'not_billable',
      reason: 'case_closed_before_start',
      shape: 'no_show_client',
    });
    expect(mockRaiseAdminAlert).not.toHaveBeenCalled();
  });

  it('(k) control — a case closed AFTER the start plus a no-show still owes the floor (existing-session path)', async () => {
    const scenario = await seedScenario();
    const start = freshScheduledStart();
    const meetingId = await bookCaseMeeting(scenario, { start });
    await admitMember(meetingId, scenario.bookerUserId);
    await joined(meetingId, asUser(scenario.expertUserId), start);
    // Stamped from the real clock — an hour AFTER this fixture's back-dated start.
    await caseEngagementsRepository.close({
      engagementId: scenario.parties.caseEngagementId,
      reason: 'resolved',
      userId: scenario.bookerUserId,
    });

    await lifecycleTick(plusMinutes(start, FLOOR));
    await expectTerminatedBy(meetingId, NO_SHOW_RULE);

    const session = await theOnlySession(meetingId);
    expect(session.status).not.toBe('cancelled');
    expect(session.connectedMinutes).toBe(FLOOR);
    expect(await consumeRows(session.id)).toHaveLength(FLOOR);
    expect(await markersFor(meetingId)).toHaveLength(0);
  });

  it('(l) example 5 — together 09:30–09:31, the client never returns, the expert waits 10:00–10:15: the pass NEVER starts a meter for the lone expert, and the idle end at 10:20 bills held 16', async () => {
    const scenario = await seedScenario();
    const start = startAhead(OUTSIDE_WINDOW_MINUTES_AHEAD);
    const meetingId = await bookCaseMeeting(scenario, { start, minutes: 60 });

    await joined(meetingId, asUser(scenario.expertUserId), plusMinutes(start, -30));
    await joined(meetingId, asUser(scenario.bookerUserId), plusMinutes(start, -30));
    await left(meetingId, asUser(scenario.expertUserId), plusMinutes(start, -29));
    await left(meetingId, asUser(scenario.bookerUserId), plusMinutes(start, -29));
    // The expert comes back AT the start and waits alone — no client-side row is open.
    await joined(meetingId, asUser(scenario.expertUserId), start);

    for (const minute of [1, 5, 10, 14]) {
      await backstopTick(plusMinutes(start, minute));
      // ⚠ NOT co-present: no session may be opened, let alone metered, for a lone expert after the start.
      expect(await sessionsFor(meetingId)).toHaveLength(0);
    }
    await left(meetingId, asUser(scenario.expertUserId), plusMinutes(start, 15));

    await lifecycleTick(plusMinutes(start, 15 + IDLE_END_MINUTES - 1));
    expect((await mustFindMeeting(meetingId)).status).toBe('in_progress');
    await lifecycleTick(plusMinutes(start, 15 + IDLE_END_MINUTES));
    await expectTerminatedBy(meetingId, IDLE_END_RULE);

    const session = await theOnlySession(meetingId);
    expect(session.openedBy).toBe('system');
    expect(session.settlementShape).toBe('held');
    // 1 minute together + 15 from the start.
    expect(session.connectedMinutes).toBe(16);
    expect(await consumeRows(session.id)).toHaveLength(16);
    expect(session.expertAccruedMinor).toBe(16 * EXPERT_RATE);
    expect(await presenceSettledMetadata(session.id)).toMatchObject({
      actualMinutes: 16,
      billableMinutes: 16,
      minutesAlreadyDrawn: 0,
    });
  });

  it('(m) example 3 — together 09:50–09:54, both leave and are back at 10:00–10:45: the writer connects at T even though the compare-and-set at T is LOST, and it bills 49', async () => {
    const scenario = await seedScenario();
    const start = startAhead(IN_WINDOW_MINUTES_AHEAD);
    const meetingId = await bookCaseMeeting(scenario, { start, minutes: 60 });
    await admitMember(meetingId, scenario.bookerUserId);
    await joined(meetingId, asUser(scenario.expertUserId), plusMinutes(start, -10));
    await joined(meetingId, asUser(scenario.bookerUserId), plusMinutes(start, -10));
    await left(meetingId, asUser(scenario.expertUserId), plusMinutes(start, -6));
    await left(meetingId, asUser(scenario.bookerUserId), plusMinutes(start, -6));
    // The first co-presence already moved the meeting to in_progress, so the compare-and-set at T is lost.
    expect((await mustFindMeeting(meetingId)).status).toBe('in_progress');
    expect((await theOnlySession(meetingId)).status).toBe('pending');

    await joined(meetingId, asUser(scenario.expertUserId), start);
    await joined(meetingId, asUser(scenario.bookerUserId), start);

    // Level-triggered: the writer connects at T with no transition to piggy-back on.
    expect((await connectedAtOf(meetingId))?.getTime()).toBe(start.getTime());
    expect((await theOnlySession(meetingId)).status).toBe('active');

    await backstopTick(plusMinutes(start, 45));
    const ended = await endMeeting({
      meetingId,
      userId: scenario.expertUserId,
      now: plusMinutes(start, 45),
    });
    expect(ended).toMatchObject({ ok: true, alreadyEnded: false });

    const session = await theOnlySession(meetingId);
    expect(session.connectedMinutes).toBe(49);
    expect(await consumeRows(session.id)).toHaveLength(49);
    expect(await presenceSettledMetadata(session.id)).toMatchObject({
      actualMinutes: 49,
      billableMinutes: 49,
      minutesAlreadyDrawn: 45,
    });
  });

  it('(n) ⚠ security N1 through the billing-start PASS — both present from 09:30, the client closes the case before the start, a meter tick at 10:00:30 opens the session (attended, so the closure never voids it), End at 10:40 bills held 70', async () => {
    const scenario = await seedScenario();
    const start = startAhead(IN_WINDOW_MINUTES_AHEAD);
    const meetingId = await bookCaseMeeting(scenario, { start, minutes: 60 });

    await joined(meetingId, asUser(scenario.expertUserId), plusMinutes(start, -30));
    await joined(meetingId, asUser(scenario.bookerUserId), plusMinutes(start, -30));
    await caseEngagementsRepository.close({
      engagementId: scenario.parties.caseEngagementId,
      reason: 'resolved',
      userId: scenario.bookerUserId,
    });
    expect(await sessionsFor(meetingId)).toHaveLength(0);

    // The pass — NOT the terminal path — starts billing for the closed-case call.
    await backstopTick(plusMinutes(start, 0.5));
    const started = await theOnlySession(meetingId);
    expect(started.openedBy).toBe('system');
    expect(started.status).toBe('active');
    expect(started.connectedAt?.getTime()).toBe(start.getTime());
    const provenance = await auditRows('credit_session', started.id, OPENED_ON_BEHALF_ACTION);
    expect(provenance[0]?.metadata).toMatchObject({ openedBy: 'system', trigger: 'billing_start' });

    await backstopTick(plusMinutes(start, 40));
    const ended = await endMeeting({
      meetingId,
      userId: scenario.expertUserId,
      now: plusMinutes(start, 40),
    });
    expect(ended).toMatchObject({ ok: true, alreadyEnded: false });

    expect(await markersFor(meetingId)).toHaveLength(0);
    const session = await theOnlySession(meetingId);
    expect(session.settlementShape).toBe('held');
    expect(session.connectedMinutes).toBe(70);
    expect(await consumeRows(session.id)).toHaveLength(70);
    expect(mockRaiseAdminAlert).not.toHaveBeenCalled();
  });

  it('(o) example 4 with a PENDING session opened at in-window admission — together 09:30–09:55, nobody returns: the meter never starts and the idle end at 10:05 bills 25', async () => {
    const scenario = await seedScenario();
    const start = startAhead(IN_WINDOW_MINUTES_AHEAD);
    const meetingId = await bookCaseMeeting(scenario, { start, minutes: 60 });
    await admitMember(meetingId, scenario.bookerUserId);
    expect((await theOnlySession(meetingId)).status).toBe('pending');

    await joined(meetingId, asUser(scenario.expertUserId), plusMinutes(start, -30));
    await joined(meetingId, asUser(scenario.bookerUserId), plusMinutes(start, -30));
    await left(meetingId, asUser(scenario.expertUserId), plusMinutes(start, -5));
    await left(meetingId, asUser(scenario.bookerUserId), plusMinutes(start, -5));

    for (const minute of [-4, 0, 1, 3]) {
      await backstopTick(plusMinutes(start, minute));
    }
    const beforeEnd = await theOnlySession(meetingId);
    expect(beforeEnd.status).toBe('pending');
    expect(beforeEnd.connectedAt).toBeNull();
    expect(await consumeRows(beforeEnd.id)).toHaveLength(0);

    await lifecycleTick(plusMinutes(start, IDLE_END_MINUTES - 1));
    expect((await mustFindMeeting(meetingId)).status).toBe('in_progress');
    await lifecycleTick(plusMinutes(start, IDLE_END_MINUTES));
    await expectTerminatedBy(meetingId, IDLE_END_RULE);

    const session = await theOnlySession(meetingId);
    expect(session.settlementShape).toBe('held');
    expect(session.connectedMinutes).toBe(25);
    expect(await consumeRows(session.id)).toHaveLength(25);
    expect(await presenceSettledMetadata(session.id)).toMatchObject({
      actualMinutes: 25,
      billableMinutes: 25,
      minutesAlreadyDrawn: 0,
    });
  });

  it('(p) ⚠⚠ D15.3 — together 09:00–09:30, both back 10:10–11:00: the from-start clock counts from the RETURN, so it bills 30 + 50 = 80 (not 90)', async () => {
    const scenario = await seedScenario();
    const start = startAhead(IN_WINDOW_MINUTES_AHEAD);
    const meetingId = await bookCaseMeeting(scenario, { start, minutes: 90 });
    await admitMember(meetingId, scenario.bookerUserId);
    await joined(meetingId, asUser(scenario.expertUserId), plusMinutes(start, -60));
    await joined(meetingId, asUser(scenario.bookerUserId), plusMinutes(start, -60));
    await left(meetingId, asUser(scenario.expertUserId), plusMinutes(start, -30));
    await left(meetingId, asUser(scenario.bookerUserId), plusMinutes(start, -30));

    await joined(meetingId, asUser(scenario.expertUserId), plusMinutes(start, 10));
    await joined(meetingId, asUser(scenario.bookerUserId), plusMinutes(start, 10));
    // The meter starts at the co-presence that began AFTER the start: 10:10, never before.
    expect((await connectedAtOf(meetingId))?.getTime()).toBe(plusMinutes(start, 10).getTime());

    await backstopTick(plusMinutes(start, 60));
    const ended = await endMeeting({
      meetingId,
      userId: scenario.expertUserId,
      now: plusMinutes(start, 60),
    });
    expect(ended).toMatchObject({ ok: true, alreadyEnded: false });

    const session = await theOnlySession(meetingId);
    expect(session.connectedMinutes).toBe(80);
    expect(await consumeRows(session.id)).toHaveLength(80);
    expect(session.expertAccruedMinor).toBe(80 * EXPERT_RATE);
    // The meter drew 50 from 10:10; settlement tops it up by the 30 minutes together before the start.
    expect(await presenceSettledMetadata(session.id)).toMatchObject({
      actualMinutes: 80,
      billableMinutes: 80,
      minutesAlreadyDrawn: 50,
    });
  });
});

describe('INVARIANT (F3, §E): a guest the delivering expert invited does not open, start or bill a session — not at admission, not when billing starts, not after the call', () => {
  /** The delivering expert is ALSO a client-company member, so a guest they invite resolves to the CLIENT side. */
  async function expertWhoIsAlsoAMember(): Promise<Scenario> {
    const scenario = await seedScenario();
    await db.insert(companyMembers).values({
      companyId: scenario.parties.companyId,
      userId: scenario.expertUserId,
      role: 'member',
    });
    return scenario;
  }

  it('(q) R6F-4a — the expert’s OWN guest is not "together" before the start: expert + own guest from T−10, the booker joins at T, End at T+30 → 30 (not 40)', async () => {
    const scenario = await expertWhoIsAlsoAMember();
    const start = startAhead(IN_WINDOW_MINUTES_AHEAD);
    const meetingId = await bookCaseMeeting(scenario, { start, minutes: 60 });
    const meeting = await mustFindMeeting(meetingId);
    const { guestId, rawToken } = await inviteClientGuest(
      meetingId,
      scenario.expertUserId,
      meeting.scheduledEnd
    );
    await admitGuest(meetingId, rawToken);
    await admitMember(meetingId, scenario.bookerUserId);
    await joined(meetingId, asUser(scenario.expertUserId), plusMinutes(start, -10));
    await joined(meetingId, asGuest(guestId), plusMinutes(start, -10));
    // A REAL member arrives at the start; the meter starts at T (the member's session was pending).
    await joined(meetingId, asUser(scenario.bookerUserId), start);
    expect((await connectedAtOf(meetingId))?.getTime()).toBe(start.getTime());

    await backstopTick(plusMinutes(start, 30));
    const ended = await endMeeting({
      meetingId,
      userId: scenario.expertUserId,
      now: plusMinutes(start, 30),
    });
    expect(ended).toMatchObject({ ok: true, alreadyEnded: false });

    const session = await theOnlySession(meetingId);
    expect(session.connectedMinutes).toBe(30);
    expect(await consumeRows(session.id)).toHaveLength(30);
    expect(await presenceSettledMetadata(session.id)).toMatchObject({
      actualMinutes: 30,
      billableMinutes: 30,
    });
  });

  it('(r) R6F-4b/4c — a pending session left by a member’s in-window admission is NOT connected when only the expert’s own guest attends, and settlement releases it: not_billable, no charge', async () => {
    const scenario = await expertWhoIsAlsoAMember();
    const { companyId } = scenario.parties;
    const start = startAhead(IN_WINDOW_MINUTES_AHEAD);
    const meetingId = await bookCaseMeeting(scenario, { start, minutes: 60 });
    const meeting = await mustFindMeeting(meetingId);
    const { guestId, rawToken } = await inviteClientGuest(
      meetingId,
      scenario.expertUserId,
      meeting.scheduledEnd
    );
    // The booker loads the call page in-window (a pending session opens) but never reaches Daily.
    await admitMember(meetingId, scenario.bookerUserId);
    const pending = await theOnlySession(meetingId);
    expect(pending.status).toBe('pending');
    await admitGuest(meetingId, rawToken);
    await joined(meetingId, asUser(scenario.expertUserId), plusMinutes(start, -5));
    await joined(meetingId, asGuest(guestId), plusMinutes(start, -5));

    // R6F-4b — "not when billing starts": the pass must not connect the member's session for the own guest.
    await backstopTick(plusMinutes(start, 0.5));
    await backstopTick(plusMinutes(start, 5));
    const stillPending = await theOnlySession(meetingId);
    expect(stillPending.status).toBe('pending');
    expect(stillPending.connectedAt).toBeNull();

    await left(meetingId, asGuest(guestId), plusMinutes(start, 20));
    await left(meetingId, asUser(scenario.expertUserId), plusMinutes(start, 20));
    await lifecycleTick(plusMinutes(start, 20 + IDLE_END_MINUTES));
    await expectTerminatedBy(meetingId, IDLE_END_RULE);

    // R6F-4c — "not after the call": the existing session is released and the meeting marked not billable.
    const session = await theOnlySession(meetingId);
    expect(session.status).toBe('cancelled');
    expect(await holdStatusOf(session.holdId)).toBe('released');
    expect(await consumeRows(session.id)).toHaveLength(0);
    expect(await walletBalance(companyId)).toBe(FUNDED_BALANCE_MINOR);
    expect(await openReceivables(companyId)).toHaveLength(0);
    const marker = await theOnlyMarker(meetingId);
    expect(marker.metadata).toMatchObject({
      disposition: 'not_billable',
      reason: 'expert_invited_guest_only',
      shape: 'held',
    });
  });
});

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * BAL-474 (ADR-1040 Amendment 7 §E, D3, D5.9, D6.3) — A CLIENT-SIDE, EMAIL-INVITED GUEST'S ADMISSION
 * OPENS THE BILLED CASE SESSION, end to end against a real Postgres.
 *
 * Product intent (D3, verbatim): "a consultation attended by only client guest is still a billed
 * consultation" — a client admin books it and hands the call to the colleague who talks to the
 * expert. Before BAL-474 only `joinMeetingAsMember` opened a session, so a guest-only Case was
 * entirely unbilled.
 *
 * What this pins, through the REAL `joinMeetingAsGuest` / presence writer / `endMeeting`:
 *   · a client-party email guest's admission opens ONE session, `opened_by = 'guest'`, the booker as
 *     `initiating_member_id`, with a `credit_session.opened_on_behalf` audit row written in the same
 *     transaction (actor NULL — a system act — and the booker as `onBehalfOfUserId`);
 *   · a second admission (a rejoin, another guest) opens nothing more;
 *   · a LINK (lobby) guest opens NOTHING — its stored party is a placeholder nobody declared, and
 *     presence maps it to `observer` (a payment-manipulation surface; D6.3 / BAL-579);
 *   · D5.9 — a guest the DELIVERING EXPERT invited opens nothing;
 *   · the whole call is then billed as a `held` consultation for the minutes both were present.
 *
 * Mocks, and only these: the BullMQ queue, the Daily room teardown and the admin-alert writer (a
 * spy). `@balo/db` and every service in between are the production code.
 */

const { vendorRooms, mockDeleteRoom, mockGetQueue, mockRaiseAdminAlert } = vi.hoisted(() => {
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
  };
});

vi.mock('../../lib/queue.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/queue.js')>()),
  getQueue: mockGetQueue,
}));
vi.mock('../daily/rooms.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../daily/rooms.js')>()),
  dailyRoomTeardown: { deleteRoom: mockDeleteRoom },
}));
vi.mock('../admin-alerts/raise.js', () => ({ raiseAdminAlert: mockRaiseAdminAlert }));

import {
  and,
  auditEvents,
  creditLedger,
  creditLedgerRepository,
  creditSessions,
  creditWalletsRepository,
  db,
  deriveIdempotencyKey,
  eq,
  expertsRepository,
  meetingGuestsRepository,
  meetingsRepository,
  type CreditSession,
  type Meeting,
} from '@balo/db';
import { deriveSessionEstimate } from '@balo/shared/credit';
import {
  GUEST_TOKEN_TTL_AFTER_END_MS,
  dailyParticipantIdFor,
  dailyRoomNameForMeeting,
} from '@balo/shared/meetings';
import { mintGuestInviteToken } from '../../lib/guest-token.js';
import { seedBookingParties, type BookingParties } from '../../test/fixtures/booking-graph.js';
import type { MeetingTokenMinter } from '../daily/meeting-tokens.js';
import { endMeeting } from './end-meeting.js';
import { joinMeetingAsGuest } from './join-meeting.js';
import {
  applyPresenceEffect,
  reconcileMeetingStatus,
  resolvePresenceEffect,
  type PresenceAction,
} from './presence-writer.js';

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const OPENED_ON_BEHALF_ACTION = 'credit_session.opened_on_behalf';

/** The fixture expert's hourly rate; at the default fee, 700/min to the client and 560/min to the expert. */
const EXPERT_HOURLY_MINOR = 33_600;
const { clientRateMinorPerMinute: CLIENT_RATE, expertRateMinorPerMinute: EXPERT_RATE } =
  deriveSessionEstimate({ expertHourlyMinor: EXPERT_HOURLY_MINOR, estimatedMinutes: 1 });
const FUNDED_BALANCE_MINOR = 50_000;
const BOOKED_WINDOW_MINUTES = 30;
const HELD_MINUTES = 20;

const testMinter: MeetingTokenMinter = {
  createMeetingToken: async () => ({ token: 'test-daily-meeting-token' }),
};

function plusMinutes(instant: Date, minutes: number): Date {
  return new Date(instant.getTime() + minutes * MS_PER_MINUTE);
}

/** A minute-aligned scheduled start an hour before the real clock — never a calendar literal. */
function freshScheduledStart(): Date {
  const minute = Math.floor(Date.now() / MS_PER_MINUTE) * MS_PER_MINUTE;
  return new Date(minute - MS_PER_HOUR);
}

interface Scenario {
  readonly parties: BookingParties;
  readonly bookerUserId: string;
  readonly expertUserId: string;
}

async function seedScenario(): Promise<Scenario> {
  const parties = await seedBookingParties();
  await expertsRepository.updateProfile(parties.expertProfileId, {
    rateCents: EXPERT_HOURLY_MINOR,
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
  return { parties, bookerUserId: parties.memberUserId, expertUserId: expert.user.id };
}

async function bookCaseMeeting(scenario: Scenario, start: Date): Promise<Meeting> {
  const { meeting } = await meetingsRepository.create({
    scheduledStart: start,
    scheduledEnd: plusMinutes(start, BOOKED_WINDOW_MINUTES),
    contexts: [{ contextType: 'case', contextId: scenario.parties.caseEngagementId }],
    actorUserId: scenario.bookerUserId,
  });
  const roomName = dailyRoomNameForMeeting(meeting.id);
  await meetingsRepository.setVenue(meeting.id, {
    dailyRoomName: roomName,
    joinUrl: `https://balo.daily.co/${roomName}`,
  });
  return meeting;
}

async function inviteGuest(
  meeting: Meeting,
  invitedById: string,
  overrides: { party?: 'client' | 'expert' } = {}
): Promise<{ guestId: string; rawToken: string }> {
  const { rawToken, tokenHash } = mintGuestInviteToken();
  const [guest] = await meetingGuestsRepository.createMany({
    meetingId: meeting.id,
    invitedById,
    guests: [
      {
        email: `bal474-guest-${randomUUID()}@guest.test`,
        name: 'Colleague Guest',
        emailDomain: 'guest.test',
        party: overrides.party ?? 'client',
        participationRole: 'guest',
        accessScope: 'meeting',
        inviteChannel: 'email',
        // The admission is irrelevant to WHO may open (only the invite channel and party decide), so a
        // pre-admitted row is the simplest fixture that reaches the mint.
        admission: 'pre_admitted',
        tokenHash,
        expiresAt: new Date(meeting.scheduledEnd.getTime() + GUEST_TOKEN_TTL_AFTER_END_MS),
      },
    ],
  });
  if (guest === undefined) {
    throw new Error('fixture: guest invite returned no row');
  }
  return { guestId: guest.id, rawToken };
}

/**
 * A LOBBY (link-share) guest exactly as production writes one: `claimLobbyPlace` stores a NULL inviter
 * (the `meeting_guest_self_claimed_is_link` CHECK admits NULL ONLY on the `link` channel) and the
 * placeholder party `client`, and the delivering expert admits the knock. With no inviter, the D5.9
 * "invited by the delivering expert" guard cannot fire — so a session that opens for this guest could
 * only have got past the presence predicate, which is the ONE barrier this fixture exercises.
 */
async function admittedLobbyGuest(
  meeting: Meeting,
  deciderUserId: string
): Promise<{ guestId: string; rawToken: string }> {
  const { rawToken, tokenHash } = mintGuestInviteToken();
  const claimed = await meetingGuestsRepository.claimLobbyPlace({
    meetingId: meeting.id,
    email: `bal474-lobby-${randomUUID()}@guest.test`,
    name: 'Lobby Visitor',
    emailDomain: 'guest.test',
    party: 'client',
    accessScope: 'meeting',
    tokenHash,
    expiresAt: new Date(meeting.scheduledEnd.getTime() + GUEST_TOKEN_TTL_AFTER_END_MS),
  });
  if (claimed === undefined) {
    throw new Error('fixture: the lobby knock claimed no place');
  }
  const decided = await meetingGuestsRepository.decideAdmission({
    guestId: claimed.id,
    decision: 'admitted',
    deciderUserId,
  });
  if (decided === undefined) {
    throw new Error('fixture: the lobby knock was not admitted');
  }
  return { guestId: claimed.id, rawToken };
}

async function admitGuest(meetingId: string, rawGuestToken: string): Promise<void> {
  const result = await joinMeetingAsGuest({ meetingId, rawGuestToken, minter: testMinter });
  if (!result.ok || result.state !== 'admitted') {
    throw new Error(`fixture: guest admission did not mint (${JSON.stringify(result)})`);
  }
}

/** ONE Daily presence observation, the way the webhook applies it. */
async function observe(
  action: PresenceAction,
  meetingId: string,
  participantId: string,
  at: Date
): Promise<void> {
  const meeting = await meetingsRepository.findById(meetingId);
  if (meeting === undefined) {
    throw new Error(`fixture: meeting ${meetingId} not found`);
  }
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

async function sessionsFor(meetingId: string): Promise<CreditSession[]> {
  const rows = await db
    .select()
    .from(creditSessions)
    .where(eq(creditSessions.meetingId, meetingId));
  return rows.filter((row) => row.deletedAt === null);
}

async function theOnlySession(meetingId: string): Promise<CreditSession> {
  const sessions = await sessionsFor(meetingId);
  expect(sessions).toHaveLength(1);
  const [only] = sessions;
  if (only === undefined) {
    throw new Error('unreachable: exactly one session asserted above');
  }
  return only;
}

beforeEach(() => {
  vi.clearAllMocks();
  vendorRooms.clear();
});

describe('a client-side guest’s admission opens the billed Case session (BAL-474, D3)', () => {
  it('a client-party EMAIL guest opens ONE session on behalf of the booker, with its provenance row, and a second admission opens nothing more', async () => {
    const scenario = await seedScenario();
    const meeting = await bookCaseMeeting(scenario, freshScheduledStart());
    const { guestId, rawToken } = await inviteGuest(meeting, scenario.bookerUserId);

    await admitGuest(meeting.id, rawToken);

    const session = await theOnlySession(meeting.id);
    expect(session.openedBy).toBe('guest');
    expect(session.initiatingMemberId).toBe(scenario.bookerUserId);
    expect(session.status).toBe('pending');
    expect(session.durationSource).toBe('presence');
    expect(session.holdId).not.toBeNull();

    const provenance = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.entityType, 'credit_session'),
          eq(auditEvents.entityId, session.id),
          eq(auditEvents.action, OPENED_ON_BEHALF_ACTION)
        )
      );
    expect(provenance).toHaveLength(1);
    const [row] = provenance;
    expect(row?.actorUserId).toBeNull();
    expect(row?.metadata).toMatchObject({
      openedBy: 'guest',
      onBehalfOfUserId: scenario.bookerUserId,
      meetingId: meeting.id,
      meetingGuestId: guestId,
      fundingPolicy: 'overdraft_tolerant',
    });

    // A rejoin (the token still resolves) — the idempotency fast path opens nothing further.
    await admitGuest(meeting.id, rawToken);
    expect(await sessionsFor(meeting.id)).toHaveLength(1);
    expect(mockRaiseAdminAlert).not.toHaveBeenCalled();
  });

  it('⚠ a LINK (lobby) guest opens NOTHING — a NULL-inviter placeholder party; only the presence predicate stands in the way', async () => {
    const scenario = await seedScenario();
    const meeting = await bookCaseMeeting(scenario, freshScheduledStart());
    const { rawToken } = await admittedLobbyGuest(meeting, scenario.expertUserId);

    await admitGuest(meeting.id, rawToken);

    expect(await sessionsFor(meeting.id)).toHaveLength(0);
    expect(mockRaiseAdminAlert).not.toHaveBeenCalled();
  });

  it('an EXPERT-side email guest invited by a NON-delivering user opens nothing — the guest is an observer, so the D5.9 inviter guard is never what refused it', async () => {
    const scenario = await seedScenario();
    const meeting = await bookCaseMeeting(scenario, freshScheduledStart());
    // The inviter is the booker (a client member), NOT the delivering expert: D5.9 cannot fire, so the
    // only thing standing between this guest and a billed session is the presence predicate.
    const { rawToken } = await inviteGuest(meeting, scenario.bookerUserId, { party: 'expert' });

    await admitGuest(meeting.id, rawToken);

    expect(await sessionsFor(meeting.id)).toHaveLength(0);
    expect(mockRaiseAdminAlert).not.toHaveBeenCalled();
  });

  it('positive control — the same expert-invited-by-booker fixture as a CLIENT-party email guest DOES open a session', async () => {
    const scenario = await seedScenario();
    const meeting = await bookCaseMeeting(scenario, freshScheduledStart());
    const { rawToken } = await inviteGuest(meeting, scenario.bookerUserId, { party: 'client' });

    await admitGuest(meeting.id, rawToken);

    const session = await theOnlySession(meeting.id);
    expect(session.openedBy).toBe('guest');
    expect(mockRaiseAdminAlert).not.toHaveBeenCalled();
  });

  it('⚠ D16 — a client-party email guest admitted MORE than the join window before the start is REFUSED and opens nothing, and one admitted inside the window opens the session', async () => {
    const scenario = await seedScenario();
    const minute = Math.floor(Date.now() / MS_PER_MINUTE) * MS_PER_MINUTE;

    const early = await bookCaseMeeting(scenario, new Date(minute + 2 * MS_PER_HOUR));
    const earlyGuest = await inviteGuest(early, scenario.bookerUserId);
    const refused = await joinMeetingAsGuest({
      meetingId: early.id,
      rawGuestToken: earlyGuest.rawToken,
      minter: testMinter,
    });
    expect(refused).toMatchObject({ ok: false, code: 'meeting_not_open_yet' });
    expect(await sessionsFor(early.id)).toHaveLength(0);
    expect(mockRaiseAdminAlert).not.toHaveBeenCalled();

    // Inside the 3-minute window (the start is 1–2 minutes ahead of the real clock).
    const inside = await bookCaseMeeting(scenario, new Date(minute + 2 * MS_PER_MINUTE));
    const insideGuest = await inviteGuest(inside, scenario.bookerUserId);
    await admitGuest(inside.id, insideGuest.rawToken);
    const session = await theOnlySession(inside.id);
    expect(session.openedBy).toBe('guest');
  });

  it('⚠ D5.9 — a client-party guest invited by the DELIVERING EXPERT opens nothing (a floor no-show must not become a held bill)', async () => {
    const scenario = await seedScenario();
    const meeting = await bookCaseMeeting(scenario, freshScheduledStart());
    const { rawToken } = await inviteGuest(meeting, scenario.expertUserId);

    await admitGuest(meeting.id, rawToken);

    expect(await sessionsFor(meeting.id)).toHaveLength(0);
    expect(mockRaiseAdminAlert).not.toHaveBeenCalled();
  });

  it('a guest-only call is then billed as a HELD consultation for the minutes both were present, on the booker’s company', async () => {
    const scenario = await seedScenario();
    const start = freshScheduledStart();
    const meeting = await bookCaseMeeting(scenario, start);
    const { guestId, rawToken } = await inviteGuest(meeting, scenario.bookerUserId);

    // The guest is admitted (the session opens), then both are present for HELD_MINUTES.
    await admitGuest(meeting.id, rawToken);
    await observe('open', meeting.id, dailyParticipantIdFor('user', scenario.expertUserId), start);
    await observe('open', meeting.id, dailyParticipantIdFor('guest', guestId), start);

    const ended = await endMeeting({
      meetingId: meeting.id,
      userId: scenario.expertUserId,
      now: plusMinutes(start, HELD_MINUTES),
    });
    expect(ended).toMatchObject({ ok: true, alreadyEnded: false });

    const session = await theOnlySession(meeting.id);
    expect(session.openedBy).toBe('guest');
    expect(session.settlementShape).toBe('held');
    expect(session.connectedMinutes).toBe(HELD_MINUTES);
    expect(session.expertAccruedMinor).toBe(HELD_MINUTES * EXPERT_RATE);
    expect(session.billingFinalizedAt).not.toBeNull();

    const consumed = await db
      .select({ amountMinor: creditLedger.amountMinor })
      .from(creditLedger)
      .where(
        and(eq(creditLedger.sessionId, session.id), eq(creditLedger.reason, 'session_consume'))
      );
    expect(consumed).toHaveLength(HELD_MINUTES);
    expect(consumed.reduce((total, row) => total + row.amountMinor, 0)).toBe(
      -HELD_MINUTES * CLIENT_RATE
    );
    const wallet = await creditWalletsRepository.findByCompanyId(scenario.parties.companyId);
    expect(wallet?.balanceMinor).toBe(FUNDED_BALANCE_MINOR - HELD_MINUTES * CLIENT_RATE);
    expect(mockRaiseAdminAlert).not.toHaveBeenCalled();
  });
});

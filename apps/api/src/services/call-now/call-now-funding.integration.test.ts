import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * BAL-650 (ADR-1040 Amendment 8 §B) — THE CALL NOW FUNDING CHECK, END TO END AGAINST A REAL POSTGRES.
 *
 * The check is the booking funding guard (`checkCaseBookingFunding`) over a 15-minute window at the
 * expert's current rate, run when the CLIENT commits to a call: inside `startCallNow` for a
 * client-started `new_meeting` ring, and in `answerCallNow` for an expert-started one.
 *
 *   F1  no mandate, balance = exactly the same-day booking's estimate → an in-place start is ok
 *       (the booking already reserves its own money: no check runs for an in-place ring)
 *   F2  the same seed → a `new_meeting` start is `booking_reserved`, with the figure the verdict's own
 *       snapshot produces; nothing is written, no callee budget is spent
 *   F3  an expert-started ring, balance = exactly ONE 15-minute estimate → the booker's answer passes,
 *       because the ring's own meeting is EXCLUDED from the reserved total. (Mutation: drop
 *       `excludeMeetingId` from `answerCallNow` and this answers `booking_reserved`.)
 *   F4  zero balance, no mandate → the answer is `booking_unfunded` with a figure; the ring is still
 *       `ringing`, nothing is admitted and no session exists. After crediting the wallet the same
 *       answer is ok.
 *   F5  an active mandate with zero balance → the client start is ok, as at booking
 *
 * Mocked, and only these: `../../lib/queue.js` `getQueue` (BullMQ would open a live Redis
 * connection), `./call-now-gates.js` (its own tests cover the gate chain — this suite is about
 * funding), and the room provisioning dependency (the vendor call). `@balo/db`, the authorization,
 * the funding guard and the join are all REAL, inside one rolled-back transaction per test.
 */

const { mockGetQueue, mockLoadGates } = vi.hoisted(() => ({
  mockGetQueue: vi.fn(() => ({ add: vi.fn().mockResolvedValue({ id: 'test-job' }) })),
  mockLoadGates: vi.fn(),
}));

vi.mock('../../lib/queue.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/queue.js')>()),
  getQueue: mockGetQueue,
}));
vi.mock('./call-now-gates.js', () => ({ loadCallNowGates: mockLoadGates }));

import type { FastifyBaseLogger } from 'fastify';
import {
  bookingFundingRepository,
  creditLedgerRepository,
  creditSessions,
  creditWalletsRepository,
  db,
  deriveIdempotencyKey,
  eq,
  expertsRepository,
  meetingContextsRepository,
  meetingRingsRepository,
  meetings,
  meetingsRepository,
} from '@balo/db';
import { estimateCaseBookingMinor, suggestCaseBookingTopUpMinor } from '@balo/shared/credit';
import { CALL_NOW_SCHEDULED_MINUTES, dailyRoomNameForMeeting } from '@balo/shared/meetings';
import type { MeetingTokenMinter } from '../daily/meeting-tokens.js';
import { joinMeetingAsMember } from '../meetings/join-meeting.js';
import { seedBookingParties, type BookingParties } from '../../test/fixtures/booking-graph.js';
import { answerCallNow } from './answer-call.js';
import { startCallNow } from './start-call.js';

const MS_PER_MINUTE = 60_000;
const EXPERT_RATE_MINOR_PER_MINUTE = 560;
const BOOKING_AHEAD_HOURS = 4;
const BOOKED_WINDOW_MINUTES = 30;
const ROOM_LEAD_MINUTES = 60;

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger;

interface Scenario {
  readonly parties: BookingParties;
  readonly bookerUserId: string;
  readonly expertUserId: string;
  readonly walletId: string;
}

async function credit(scenario: Scenario, amountMinor: number): Promise<void> {
  const paymentIntentId = `pi_test_${randomUUID().replace(/-/g, '')}`;
  await creditLedgerRepository.postEntry({
    walletId: scenario.walletId,
    entryType: 'purchase',
    reason: 'manual_purchase',
    amountMinor,
    idempotencyKey: deriveIdempotencyKey({ reason: 'manual_purchase', paymentIntentId }),
    memberId: scenario.parties.memberUserId,
    stripePaymentIntentId: paymentIntentId,
  });
}

/** A client company with an expert at a known rate; `fundedMinor` of credit, none when 0. */
async function seedScenario(fundedMinor: number): Promise<Scenario> {
  const parties = await seedBookingParties();
  await expertsRepository.updateProfile(parties.expertProfileId, {
    rateCents: EXPERT_RATE_MINOR_PER_MINUTE,
  });
  const expert = await expertsRepository.findUserIdByProfileId(parties.expertProfileId);
  if (expert === undefined) {
    throw new Error('fixture: the seeded expert profile resolves no user');
  }
  const wallet = await creditWalletsRepository.ensureForCompany(db, parties.companyId);
  const scenario: Scenario = {
    parties,
    bookerUserId: parties.memberUserId,
    expertUserId: expert.user.id,
    walletId: wallet.id,
  };
  if (fundedMinor > 0) {
    await credit(scenario, fundedMinor);
  }
  return scenario;
}

function fifteenMinuteEstimate(now: Date): number {
  return estimateCaseBookingMinor(
    EXPERT_RATE_MINOR_PER_MINUTE,
    now,
    new Date(now.getTime() + CALL_NOW_SCHEDULED_MINUTES * MS_PER_MINUTE)
  );
}

/** The room the call-now service provisions after commit, with its readiness backdated. */
async function provisionRoom(meeting: { id: string; scheduledStart: Date }): Promise<{
  provisioned: true;
  dailyRoomName: string;
  joinUrl: string;
}> {
  const dailyRoomName = dailyRoomNameForMeeting(meeting.id);
  const joinUrl = `https://balo.daily.co/${dailyRoomName}`;
  await meetingsRepository.setVenue(meeting.id, { dailyRoomName, joinUrl });
  await db
    .update(meetings)
    .set({
      venueProvisionedAt: new Date(meeting.scheduledStart.getTime() - ROOM_LEAD_MINUTES * 60_000),
    })
    .where(eq(meetings.id, meeting.id));
  return { provisioned: true, dailyRoomName, joinUrl };
}

/** A booked case meeting `BOOKING_AHEAD_HOURS` from `now`, so it is a later slot, not a live call. */
async function bookSameDayMeeting(
  scenario: Scenario,
  now: Date
): Promise<{ meetingId: string; start: Date; end: Date }> {
  const start = new Date(now.getTime() + BOOKING_AHEAD_HOURS * 60 * MS_PER_MINUTE);
  const end = new Date(start.getTime() + BOOKED_WINDOW_MINUTES * MS_PER_MINUTE);
  const { meeting } = await meetingsRepository.create({
    scheduledStart: start,
    scheduledEnd: end,
    contexts: [{ contextType: 'case', contextId: scenario.parties.caseEngagementId }],
    actorUserId: scenario.bookerUserId,
  });
  return { meetingId: meeting.id, start, end };
}

function gatesFor(
  calleeUserId: string,
  inPlaceCandidate: { meetingId: string; scheduledStart: Date } | null = null
): Record<string, unknown> {
  return {
    availability: { canCallNow: true },
    callee: { userId: calleeUserId, timeZone: 'UTC' },
    inPlaceCandidate,
  };
}

const meterCallee = vi.fn(async (): Promise<boolean> => false);
const releaseCallee = vi.fn(async (): Promise<void> => undefined);

function startAs(
  scenario: Scenario,
  userId: string,
  now: Date,
  extra: { inPlaceOfMeetingId?: string } = {}
): ReturnType<typeof startCallNow> {
  return startCallNow({
    engagementId: scenario.parties.caseEngagementId,
    userId,
    now,
    log,
    meterCallee,
    releaseCallee,
    deps: { provision: provisionRoom as never },
    ...extra,
  });
}

function countingMinter(): MeetingTokenMinter & { readonly mintedFor: string[] } {
  const mintedFor: string[] = [];
  return {
    mintedFor,
    createMeetingToken: async (request) => {
      mintedFor.push(request.participantId);
      return { token: 'test-daily-meeting-token' };
    },
  };
}

async function sessionsForMeeting(meetingId: string): Promise<number> {
  const rows = await db
    .select({ id: creditSessions.id })
    .from(creditSessions)
    .where(eq(creditSessions.meetingId, meetingId));
  return rows.length;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Call now funding — a client-started ring', () => {
  it('F1 — balance = the same-day booking’s estimate: an in-place start is ok, no check runs', async () => {
    const now = new Date();
    const scenario = await seedScenario(0);
    const booked = await bookSameDayMeeting(scenario, now);
    await credit(
      scenario,
      estimateCaseBookingMinor(EXPERT_RATE_MINOR_PER_MINUTE, booked.start, booked.end)
    );
    mockLoadGates.mockResolvedValue(
      gatesFor(scenario.expertUserId, { meetingId: booked.meetingId, scheduledStart: booked.start })
    );

    const result = await startAs(scenario, scenario.bookerUserId, now, {
      inPlaceOfMeetingId: booked.meetingId,
    });

    expect(result).toMatchObject({ ok: true, placement: 'in_place', meetingId: booked.meetingId });
  });

  it('F2 — the same seed refuses a new_meeting start as booking_reserved, with the verdict’s own figure, writing nothing', async () => {
    const now = new Date();
    const scenario = await seedScenario(0);
    const booked = await bookSameDayMeeting(scenario, now);
    await credit(
      scenario,
      estimateCaseBookingMinor(EXPERT_RATE_MINOR_PER_MINUTE, booked.start, booked.end)
    );
    mockLoadGates.mockResolvedValue(gatesFor(scenario.expertUserId));
    const expected = suggestCaseBookingTopUpMinor(
      await bookingFundingRepository.readSnapshot({
        companyId: scenario.parties.companyId,
        expertProfileId: scenario.parties.expertProfileId,
        now,
      }),
      {
        scheduledStart: now,
        scheduledEnd: new Date(now.getTime() + CALL_NOW_SCHEDULED_MINUTES * MS_PER_MINUTE),
      }
    );

    const result = await startAs(scenario, scenario.bookerUserId, now);

    expect(result).toEqual({
      ok: false,
      code: 'booking_reserved',
      suggestedTopUpMinor: expected,
    });
    expect(expected).toBeGreaterThan(0);
    expect(meterCallee).not.toHaveBeenCalled();
    expect(
      await meetingRingsRepository.findRingingForEngagement(scenario.parties.caseEngagementId)
    ).toBeUndefined();
    const caseMeetings = await meetingContextsRepository.listMeetingsForContext(
      'case',
      scenario.parties.caseEngagementId
    );
    expect(caseMeetings.map((meeting) => meeting.id)).toEqual([booked.meetingId]);
  });

  it('F5 — an active mandate with a zero balance starts as at booking', async () => {
    const now = new Date();
    const scenario = await seedScenario(0);
    await creditWalletsRepository.applyMandate(db, {
      walletId: scenario.walletId,
      stripeCustomerId: 'cus_call_now_funding',
      stripePaymentMethodId: 'pm_call_now_funding',
      mandateRef: 'mandate_call_now_funding',
      mandateStatus: 'active',
    });
    mockLoadGates.mockResolvedValue(gatesFor(scenario.expertUserId));

    const result = await startAs(scenario, scenario.bookerUserId, now);

    expect(result).toMatchObject({ ok: true, placement: 'new_meeting' });
  });

  it('a zero balance with no mandate is booking_unfunded, with nothing written', async () => {
    const now = new Date();
    const scenario = await seedScenario(0);
    mockLoadGates.mockResolvedValue(gatesFor(scenario.expertUserId));

    const result = await startAs(scenario, scenario.bookerUserId, now);

    expect(result).toMatchObject({ ok: false, code: 'booking_unfunded' });
    expect(meterCallee).not.toHaveBeenCalled();
    expect(
      await meetingContextsRepository.listMeetingsForContext(
        'case',
        scenario.parties.caseEngagementId
      )
    ).toHaveLength(0);
  });
});

describe('Call now funding — an expert-started ring, committed by the client', () => {
  async function expertRings(
    scenario: Scenario,
    now: Date
  ): Promise<{
    ringId: string;
    meetingId: string;
  }> {
    mockLoadGates.mockResolvedValue(gatesFor(scenario.bookerUserId));
    const started = await startAs(scenario, scenario.expertUserId, now);
    if (!started.ok) {
      throw new Error(`fixture: the expert's start was refused: ${started.code}`);
    }
    return { ringId: started.ringId, meetingId: started.meetingId };
  }

  it('an expert-started start runs no funding check — the client has not committed yet', async () => {
    const now = new Date();
    const scenario = await seedScenario(0);

    await expect(expertRings(scenario, now)).resolves.toMatchObject({
      ringId: expect.any(String),
    });
  });

  it('F3 — balance = exactly one 15-minute estimate: the booker’s answer passes, the ring’s own meeting not reserving against it', async () => {
    const now = new Date();
    const scenario = await seedScenario(fifteenMinuteEstimate(now));
    const { ringId, meetingId } = await expertRings(scenario, now);
    const minter = countingMinter();

    const held = await joinMeetingAsMember({
      meetingId,
      userId: scenario.bookerUserId,
      minter,
    });
    expect(held).toMatchObject({ ok: false, code: 'call_answer_required', ringId });
    expect(minter.mintedFor).toHaveLength(0);

    const result = await answerCallNow({
      ringId,
      userId: scenario.bookerUserId,
      now,
      minter,
    });

    expect(result).toMatchObject({ ok: true });
    expect(minter.mintedFor).toHaveLength(1);
    expect(await sessionsForMeeting(meetingId)).toBe(0);
  });

  it('F4 — zero balance, no mandate: booking_unfunded with a figure, the ring still ringing and nobody admitted; after crediting, the answer is ok', async () => {
    const now = new Date();
    const scenario = await seedScenario(0);
    const { ringId, meetingId } = await expertRings(scenario, now);
    const minter = countingMinter();

    const refused = await answerCallNow({
      ringId,
      userId: scenario.bookerUserId,
      now,
      minter,
    });

    expect(refused).toMatchObject({ ok: false, code: 'booking_unfunded' });
    if (refused.ok || refused.code !== 'booking_unfunded') {
      throw new Error('expected a booking_unfunded refusal');
    }
    expect(refused.suggestedTopUpMinor).toBeGreaterThan(0);
    expect((await meetingRingsRepository.findById(ringId))?.status).toBe('ringing');
    expect(minter.mintedFor).toHaveLength(0);
    expect(await sessionsForMeeting(meetingId)).toBe(0);

    await credit(scenario, fifteenMinuteEstimate(now));

    await expect(
      answerCallNow({ ringId, userId: scenario.bookerUserId, now, minter })
    ).resolves.toMatchObject({ ok: true });
    expect(minter.mintedFor).toHaveLength(1);
  });

  it('only the ring’s callee may answer: the expert and a stranger are ring_not_found', async () => {
    const now = new Date();
    const scenario = await seedScenario(fifteenMinuteEstimate(now));
    const { ringId } = await expertRings(scenario, now);
    const stranger = await seedScenario(0);

    await expect(answerCallNow({ ringId, userId: scenario.expertUserId, now })).resolves.toEqual({
      ok: false,
      code: 'ring_not_found',
    });
    await expect(answerCallNow({ ringId, userId: stranger.bookerUserId, now })).resolves.toEqual({
      ok: false,
      code: 'ring_not_found',
    });
  });
});

import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { db } from '../client';
import {
  meetingCalendarDeliveries,
  meetings,
  meetingGuests,
  type MeetingCalendarDelivery,
  type NewMeetingCalendarDelivery,
} from '../schema';
import { meetingFactory, meetingGuestFactory, userFactory } from '../test/factories';
import { expectConstraintViolation } from '../test/helpers/expect-check-violation';
import {
  meetingCalendarDeliveriesRepository,
  type ClaimCalendarSendInput,
} from './meeting-calendar-deliveries';
import { meetingCalendarEventsRepository } from './meeting-calendar-events';

/**
 * BAL-475 (decision O4) — the calendar-invite send ledger against REAL Postgres.
 *
 * ⚠⚠ WHAT ONLY THIS FILE CAN PROVE (a mocked client never reaches a planner):
 *   · **42P10** — both uniques are PARTIAL, so each ON CONFLICT arbiter must restate its
 *     predicate. A missing / parameterised one fails the FIRST claim, on an EMPTY table.
 *   · **THE PROTOCOL** — the DO UPDATE `WHERE` reads the EXISTING row: `sent` is never
 *     re-claimed, a fresh `pending` is only re-claimable by its own token, a lapsed lease or a
 *     `failed` row by anyone, and `attempt_count + 1` increments the STORED count.
 *   · **THE CHECKs** — exactly one recipient, the channel / method vocabularies, and the
 *     outcome ⟺ `sent_at` / `failure_reason` pairings.
 *
 * ⚠ NO REAL CONCURRENCY: the harness holds each test in ONE transaction on a max:1 pool, so
 * `now()` is constant within a test (a lease is aged by back-dating `last_attempted_at`) and a
 * race between two jobs is simulated sequentially with two tokens. Raw constraint probes go
 * through `expectConstraintViolation` (its own SAVEPOINT); every repository call here either
 * succeeds or returns a refusal, so none aborts the outer transaction.
 */

// ── Fixtures ──────────────────────────────────────────────────────

interface Seeded {
  meetingId: string;
  calendarEventId: string;
  userId: string;
  guestId: string;
}

/** A meeting with a live client ICS row, a member recipient and a guest on that meeting. */
async function seed(): Promise<Seeded> {
  const { meeting } = await meetingFactory();
  const event = await meetingCalendarEventsRepository.recordIcsDelivery({
    meetingId: meeting.id,
    party: 'client',
  });
  const user = await userFactory();
  const { guest } = await meetingGuestFactory({ meetingId: meeting.id });
  return { meetingId: meeting.id, calendarEventId: event.id, userId: user.id, guestId: guest.id };
}

function userClaim(
  seeded: Seeded,
  overrides: Partial<ClaimCalendarSendInput> = {}
): ClaimCalendarSendInput {
  return {
    calendarEventId: seeded.calendarEventId,
    recipient: { kind: 'user', userId: seeded.userId },
    sequence: 0,
    method: 'REQUEST',
    channel: 'email',
    claimToken: 'job-a',
    ...overrides,
  };
}

function guestClaim(
  seeded: Seeded,
  overrides: Partial<ClaimCalendarSendInput> = {}
): ClaimCalendarSendInput {
  return userClaim(seeded, { recipient: { kind: 'guest', guestId: seeded.guestId }, ...overrides });
}

/** A row that satisfies every CHECK — probes override exactly one thing. */
function validRow(
  seeded: Seeded,
  overrides: Partial<NewMeetingCalendarDelivery> = {}
): NewMeetingCalendarDelivery {
  return {
    calendarEventId: seeded.calendarEventId,
    recipientUserId: seeded.userId,
    recipientGuestId: null,
    channel: 'email',
    method: 'REQUEST',
    sequence: 0,
    outcome: 'pending',
    claimToken: 'job-raw',
    attemptCount: 1,
    lastAttemptedAt: new Date(),
    ...overrides,
  };
}

async function storedRow(id: string): Promise<MeetingCalendarDelivery | undefined> {
  const [row] = await db
    .select()
    .from(meetingCalendarDeliveries)
    .where(eq(meetingCalendarDeliveries.id, id));
  return row;
}

async function ageLease(id: string, minutes: number): Promise<void> {
  await db
    .update(meetingCalendarDeliveries)
    .set({ lastAttemptedAt: sql`now() - make_interval(mins => ${minutes})` })
    .where(eq(meetingCalendarDeliveries.id, id));
}

/** Claim, asserting it was claimed, and hand back the row. */
async function claimOrFail(input: ClaimCalendarSendInput): Promise<MeetingCalendarDelivery> {
  const result = await meetingCalendarDeliveriesRepository.claimSend(input);
  expect(result.status).toBe('claimed');
  return result.delivery;
}

// ── claimSend ────────────────────────────────────────────────────

describe('meetingCalendarDeliveriesRepository.claimSend', () => {
  /** ⚠⚠ THE 42P10 GATE for the USER arbiter — first claim, empty table. */
  it('claims a MEMBER send on an empty table: pending, attempt 1, this token', async () => {
    const seeded = await seed();

    const result = await meetingCalendarDeliveriesRepository.claimSend(userClaim(seeded));

    expect(result.status).toBe('claimed');
    expect(result.delivery).toMatchObject({
      calendarEventId: seeded.calendarEventId,
      recipientUserId: seeded.userId,
      recipientGuestId: null,
      channel: 'email',
      method: 'REQUEST',
      sequence: 0,
      outcome: 'pending',
      claimToken: 'job-a',
      attemptCount: 1,
      sentAt: null,
      failureReason: null,
      providerMessageId: null,
      deletedAt: null,
    });
    expect(result.delivery.lastAttemptedAt).toBeInstanceOf(Date);
  });

  /** ⚠⚠ THE 42P10 GATE for the GUEST arbiter — a different partial unique. */
  it('claims a GUEST send on an empty table', async () => {
    const seeded = await seed();

    const result = await meetingCalendarDeliveriesRepository.claimSend(guestClaim(seeded));

    expect(result.status).toBe('claimed');
    expect(result.delivery).toMatchObject({
      recipientUserId: null,
      recipientGuestId: seeded.guestId,
      outcome: 'pending',
      attemptCount: 1,
    });
  });

  /** A BullMQ retry / stall re-run keeps its job id — it must be able to pick its claim up. */
  it('the SAME token re-claims its own pending row — same row, attempt 2', async () => {
    const seeded = await seed();
    const first = await claimOrFail(userClaim(seeded));

    const again = await claimOrFail(userClaim(seeded));

    expect(again.id).toBe(first.id);
    expect(again.claimToken).toBe('job-a');
    expect(again.attemptCount).toBe(2);
  });

  it('a DIFFERENT token against a fresh pending claim is in_flight — the row is untouched', async () => {
    const seeded = await seed();
    const held = await claimOrFail(userClaim(seeded));
    // Still inside the lease, even well into it.
    await ageLease(held.id, 14);

    const result = await meetingCalendarDeliveriesRepository.claimSend(
      userClaim(seeded, { claimToken: 'job-b' })
    );

    expect(result.status).toBe('in_flight');
    expect(result.delivery.id).toBe(held.id);
    expect(await storedRow(held.id)).toMatchObject({
      outcome: 'pending',
      claimToken: 'job-a',
      attemptCount: 1,
    });
  });

  /** A crashed holder: once the lease lapses, another job takes the claim over. */
  it('a DIFFERENT token takes over a pending claim whose lease lapsed', async () => {
    const seeded = await seed();
    const held = await claimOrFail(userClaim(seeded));
    await ageLease(held.id, 16);
    const aged = await storedRow(held.id);

    const taken = await claimOrFail(userClaim(seeded, { claimToken: 'job-b' }));

    expect(taken.id).toBe(held.id);
    expect(taken.claimToken).toBe('job-b');
    expect(taken.attemptCount).toBe(2);
    expect(taken.lastAttemptedAt.getTime()).toBeGreaterThan(aged?.lastAttemptedAt.getTime() ?? 0);
  });

  it('any token re-claims a FAILED row, clearing failure_reason', async () => {
    const seeded = await seed();
    const held = await claimOrFail(guestClaim(seeded));
    await meetingCalendarDeliveriesRepository.markFailed({
      id: held.id,
      claimToken: 'job-a',
      failureReason: 'Error:EAUTH:535',
    });

    const retaken = await claimOrFail(guestClaim(seeded, { claimToken: 'job-b' }));

    expect(retaken.id).toBe(held.id);
    expect(retaken).toMatchObject({
      outcome: 'pending',
      claimToken: 'job-b',
      attemptCount: 2,
      failureReason: null,
      sentAt: null,
    });
  });

  /** ⚠⚠ THE WHOLE POINT: no duplicate ICS at the same SEQUENCE for the same recipient. */
  it('a SENT row is never re-claimed — already_sent for any token, row unchanged', async () => {
    const seeded = await seed();
    const held = await claimOrFail(userClaim(seeded));
    const sent = await meetingCalendarDeliveriesRepository.markSent({
      id: held.id,
      claimToken: 'job-a',
      providerMessageId: '<msg-1@balo>',
    });
    expect(sent?.outcome).toBe('sent');

    const sameToken = await meetingCalendarDeliveriesRepository.claimSend(userClaim(seeded));
    await ageLease(held.id, 60);
    const otherToken = await meetingCalendarDeliveriesRepository.claimSend(
      userClaim(seeded, { claimToken: 'job-b' })
    );

    expect(sameToken.status).toBe('already_sent');
    expect(otherToken.status).toBe('already_sent');
    expect(otherToken.delivery.id).toBe(held.id);
    expect(await storedRow(held.id)).toMatchObject({
      outcome: 'sent',
      claimToken: 'job-a',
      attemptCount: 1,
      providerMessageId: '<msg-1@balo>',
    });
  });

  /** A reschedule bumps the SEQUENCE, so its re-send is a NEW row even after a sent one. */
  it('keys independently on sequence, recipient and recipient kind', async () => {
    const seeded = await seed();
    const otherUser = await userFactory();

    const base = await claimOrFail(userClaim(seeded));
    await meetingCalendarDeliveriesRepository.markSent({
      id: base.id,
      claimToken: 'job-a',
      providerMessageId: null,
    });
    const nextSequence = await claimOrFail(userClaim(seeded, { sequence: 1 }));
    const otherRecipient = await claimOrFail(
      userClaim(seeded, { recipient: { kind: 'user', userId: otherUser.id } })
    );
    const guest = await claimOrFail(guestClaim(seeded));

    const ids = [base.id, nextSequence.id, otherRecipient.id, guest.id];
    expect(new Set(ids).size).toBe(4);
    const rows = await db
      .select()
      .from(meetingCalendarDeliveries)
      .where(eq(meetingCalendarDeliveries.calendarEventId, seeded.calendarEventId));
    expect(rows).toHaveLength(4);
  });

  /** The arbiters are partial on `deleted_at IS NULL`: a retired ledger row is invisible. */
  it('a SOFT-DELETED sent row does not block a new claim — a fresh row beside it', async () => {
    const seeded = await seed();
    const retired = await claimOrFail(userClaim(seeded));
    await meetingCalendarDeliveriesRepository.markSent({
      id: retired.id,
      claimToken: 'job-a',
      providerMessageId: null,
    });
    await db
      .update(meetingCalendarDeliveries)
      .set({ deletedAt: new Date() })
      .where(eq(meetingCalendarDeliveries.id, retired.id));

    const fresh = await claimOrFail(userClaim(seeded, { claimToken: 'job-b' }));

    expect(fresh.id).not.toBe(retired.id);
    expect(fresh.attemptCount).toBe(1);
  });
});

// ── markSent / markFailed ────────────────────────────────────────

describe('meetingCalendarDeliveriesRepository.markSent / markFailed', () => {
  it('markSent resolves this claim: sent, sent_at stamped, message id stored', async () => {
    const seeded = await seed();
    const held = await claimOrFail(userClaim(seeded));

    const sent = await meetingCalendarDeliveriesRepository.markSent({
      id: held.id,
      claimToken: 'job-a',
      providerMessageId: '<msg-2@balo>',
    });

    expect(sent).toMatchObject({
      id: held.id,
      outcome: 'sent',
      providerMessageId: '<msg-2@balo>',
      failureReason: null,
    });
    expect(sent?.sentAt).toBeInstanceOf(Date);
  });

  it('markFailed resolves this claim: failed, with the class/code reason', async () => {
    const seeded = await seed();
    const held = await claimOrFail(userClaim(seeded));

    const failed = await meetingCalendarDeliveriesRepository.markFailed({
      id: held.id,
      claimToken: 'job-a',
      failureReason: 'Error:ECONNECTION',
    });

    expect(failed).toMatchObject({
      id: held.id,
      outcome: 'failed',
      failureReason: 'Error:ECONNECTION',
      sentAt: null,
    });
  });

  /**
   * ⚠ A TAKEN-OVER CLAIM CANNOT BE RESOLVED BY ITS OLD HOLDER. Job A's lease lapsed and job B
   * holds the row: A's late `markSent` / `markFailed` must change nothing.
   */
  it('a WRONG token resolves nothing — undefined, row unchanged', async () => {
    const seeded = await seed();
    const held = await claimOrFail(userClaim(seeded));
    await ageLease(held.id, 16);
    await claimOrFail(userClaim(seeded, { claimToken: 'job-b' }));

    const lateSent = await meetingCalendarDeliveriesRepository.markSent({
      id: held.id,
      claimToken: 'job-a',
      providerMessageId: '<late@balo>',
    });
    const lateFailed = await meetingCalendarDeliveriesRepository.markFailed({
      id: held.id,
      claimToken: 'job-a',
      failureReason: 'Error:LATE',
    });

    expect(lateSent).toBeUndefined();
    expect(lateFailed).toBeUndefined();
    expect(await storedRow(held.id)).toMatchObject({
      outcome: 'pending',
      claimToken: 'job-b',
      attemptCount: 2,
      providerMessageId: null,
      failureReason: null,
    });
  });

  it('never re-resolves a row that is no longer pending', async () => {
    const seeded = await seed();
    const held = await claimOrFail(userClaim(seeded));
    await meetingCalendarDeliveriesRepository.markSent({
      id: held.id,
      claimToken: 'job-a',
      providerMessageId: null,
    });

    const flipped = await meetingCalendarDeliveriesRepository.markFailed({
      id: held.id,
      claimToken: 'job-a',
      failureReason: 'Error:AFTER_SEND',
    });

    expect(flipped).toBeUndefined();
    expect((await storedRow(held.id))?.outcome).toBe('sent');
  });
});

// ── constraints ──────────────────────────────────────────────────

describe('meeting_calendar_deliveries — constraints', () => {
  it('requires EXACTLY one recipient — neither and both are rejected (23514)', async () => {
    const seeded = await seed();

    await expectConstraintViolation(
      '23514',
      (tx) =>
        tx
          .insert(meetingCalendarDeliveries)
          .values(validRow(seeded, { recipientUserId: null, recipientGuestId: null })),
      'meeting_calendar_delivery_recipient_exactly_one'
    );
    await expectConstraintViolation(
      '23514',
      (tx) =>
        tx
          .insert(meetingCalendarDeliveries)
          .values(validRow(seeded, { recipientGuestId: seeded.guestId })),
      'meeting_calendar_delivery_recipient_exactly_one'
    );
  });

  /** Typed out of reach in TS (`$type<'REQUEST'>` / `$type<'email'>`), so probed as raw SQL. */
  it('rejects an unknown method or channel (23514)', async () => {
    const seeded = await seed();

    await expectConstraintViolation(
      '23514',
      (tx) =>
        tx.execute(sql`
          INSERT INTO meeting_calendar_deliveries
            (calendar_event_id, recipient_user_id, channel, method, sequence, outcome, claim_token, attempt_count, last_attempted_at)
          VALUES (${seeded.calendarEventId}, ${seeded.userId}, 'email', 'CANCEL', 0, 'pending', 'job-raw', 1, now())
        `),
      'meeting_calendar_delivery_method_known'
    );
    await expectConstraintViolation(
      '23514',
      (tx) =>
        tx.execute(sql`
          INSERT INTO meeting_calendar_deliveries
            (calendar_event_id, recipient_user_id, channel, method, sequence, outcome, claim_token, attempt_count, last_attempted_at)
          VALUES (${seeded.calendarEventId}, ${seeded.userId}, 'sms', 'REQUEST', 0, 'pending', 'job-raw', 1, now())
        `),
      'meeting_calendar_delivery_channel_known'
    );
  });

  it('rejects a negative sequence and a zero attempt count (23514)', async () => {
    const seeded = await seed();

    await expectConstraintViolation(
      '23514',
      (tx) => tx.insert(meetingCalendarDeliveries).values(validRow(seeded, { sequence: -1 })),
      'meeting_calendar_delivery_sequence_non_negative'
    );
    await expectConstraintViolation(
      '23514',
      (tx) => tx.insert(meetingCalendarDeliveries).values(validRow(seeded, { attemptCount: 0 })),
      'meeting_calendar_delivery_attempt_count_positive'
    );
  });

  it('pairs sent ⟺ sent_at, both directions (23514)', async () => {
    const seeded = await seed();

    await expectConstraintViolation(
      '23514',
      (tx) =>
        tx
          .insert(meetingCalendarDeliveries)
          .values(validRow(seeded, { outcome: 'sent', sentAt: null })),
      'meeting_calendar_delivery_sent_at_paired'
    );
    await expectConstraintViolation(
      '23514',
      (tx) =>
        tx
          .insert(meetingCalendarDeliveries)
          .values(validRow(seeded, { outcome: 'pending', sentAt: new Date() })),
      'meeting_calendar_delivery_sent_at_paired'
    );
  });

  it('pairs failed ⟺ failure_reason, both directions (23514)', async () => {
    const seeded = await seed();

    await expectConstraintViolation(
      '23514',
      (tx) =>
        tx
          .insert(meetingCalendarDeliveries)
          .values(validRow(seeded, { outcome: 'failed', failureReason: null })),
      'meeting_calendar_delivery_failure_reason_paired'
    );
    await expectConstraintViolation(
      '23514',
      (tx) =>
        tx
          .insert(meetingCalendarDeliveries)
          .values(validRow(seeded, { outcome: 'pending', failureReason: 'Error:X' })),
      'meeting_calendar_delivery_failure_reason_paired'
    );
  });

  it('rejects a second LIVE row for the same send key, per recipient kind (23505)', async () => {
    const seeded = await seed();
    await db.insert(meetingCalendarDeliveries).values(validRow(seeded));
    await db
      .insert(meetingCalendarDeliveries)
      .values(validRow(seeded, { recipientUserId: null, recipientGuestId: seeded.guestId }));

    await expectConstraintViolation(
      '23505',
      (tx) => tx.insert(meetingCalendarDeliveries).values(validRow(seeded)),
      'meeting_calendar_delivery_user_send_uq'
    );
    await expectConstraintViolation(
      '23505',
      (tx) =>
        tx
          .insert(meetingCalendarDeliveries)
          .values(validRow(seeded, { recipientUserId: null, recipientGuestId: seeded.guestId })),
      'meeting_calendar_delivery_guest_send_uq'
    );
  });

  it('permits the same send key again once the earlier row is soft-deleted', async () => {
    const seeded = await seed();
    const [first] = await db
      .insert(meetingCalendarDeliveries)
      .values(validRow(seeded, { deletedAt: new Date() }))
      .returning();

    const [second] = await db
      .insert(meetingCalendarDeliveries)
      .values(validRow(seeded))
      .returning();

    expect(first?.id).toEqual(expect.any(String));
    expect(second?.id).toEqual(expect.any(String));
    expect(second?.id).not.toBe(first?.id);
  });

  it('refuses a row that names no real calendar event (23503)', async () => {
    const seeded = await seed();

    await expectConstraintViolation(
      '23503',
      (tx) =>
        tx
          .insert(meetingCalendarDeliveries)
          .values(validRow(seeded, { calendarEventId: randomUUID() })),
      // ⚠ TRUNCATED, as Postgres stores it: drizzle-kit's generated FK name is 77 characters and
      // identifiers are cut to 63 (NAMEDATALEN) in every statement, so the migration's
      // `…_meeting_calendar_events_id_fk` lands as this. 18 earlier FKs share the behaviour.
      'meeting_calendar_deliveries_calendar_event_id_meeting_calendar_'
    );
  });
});

// ── cascades ─────────────────────────────────────────────────────

describe('meeting_calendar_deliveries — FK cascades', () => {
  it('hard-deleting the meeting removes its calendar rows AND their send ledger', async () => {
    const seeded = await seed();
    const held = await claimOrFail(userClaim(seeded));

    await db.delete(meetings).where(eq(meetings.id, seeded.meetingId));

    expect(await storedRow(held.id)).toBeUndefined();
  });

  it('hard-deleting a guest removes that guest’s ledger rows only', async () => {
    const seeded = await seed();
    const guestRow = await claimOrFail(guestClaim(seeded));
    const userRow = await claimOrFail(userClaim(seeded));

    await db.delete(meetingGuests).where(eq(meetingGuests.id, seeded.guestId));

    expect(await storedRow(guestRow.id)).toBeUndefined();
    expect((await storedRow(userRow.id))?.id).toBe(userRow.id);
  });
});

/**
 * F11 (fix round 1, R10) — a mocked `db` cannot prove an index EXISTS; only the real planner
 * catalog can. Confirms the FK's own non-partial index landed, distinct from the two PARTIAL
 * uniques that cannot serve it.
 */
describe('meeting_calendar_deliveries — the FK index (F11)', () => {
  it('meeting_calendar_delivery_calendar_event_idx exists and is NOT one of the partial uniques', async () => {
    const rows = await db.execute(sql`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'meeting_calendar_deliveries'
        AND indexname = 'meeting_calendar_delivery_calendar_event_idx'
    `);

    expect(rows).toHaveLength(1);
    const [row] = rows;
    if (row === undefined) {
      throw new Error('expected meeting_calendar_delivery_calendar_event_idx to exist');
    }
    const indexdef = String((row as { indexdef: unknown }).indexdef);
    expect(indexdef).toContain('calendar_event_id');
    expect(indexdef).not.toContain('WHERE');
  });
});

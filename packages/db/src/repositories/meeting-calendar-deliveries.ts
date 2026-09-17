import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { db } from '../client';
import { meetingCalendarDeliveries } from '../schema';
import type {
  MeetingCalendarDelivery,
  MeetingCalendarDeliveryChannel,
  MeetingCalendarDeliveryMethod,
} from '../schema';

/**
 * BAL-475 (decision O4) — the per-recipient CALENDAR-INVITE SEND LEDGER.
 *
 * ── WHY THIS EXISTS BESIDE `meeting_calendar_events` ───────────────────────────────────
 * The `(meeting, party)` row + `delivery_mode` does NOT supersede it: that row has no
 * per-RECIPIENT grain (one party row fans out to its member AND that side's admitted guests),
 * no SEQUENCE history and no outcome. This ledger is what makes "no duplicate ICS at the same
 * SEQUENCE for the same recipient" ENFORCEABLE rather than hoped for.
 *
 * ── THE CLAIM PROTOCOL ─────────────────────────────────────────────────────────────────
 * The email channel CLAIMS the (event, recipient, sequence, method) row immediately before
 * sending, then resolves it with `markSent` / `markFailed`:
 *
 *   | existing row                                   | same token | different token |
 *   | ---------------------------------------------- | ---------- | --------------- |
 *   | none                                           | claimed    | claimed         |
 *   | `pending`, lease fresh                         | claimed    | in_flight       |
 *   | `pending`, lease lapsed (> lease minutes)      | claimed    | claimed         |
 *   | `failed`                                       | claimed    | claimed         |
 *   | `sent`                                         | already_sent | already_sent  |
 *
 * The SAME job (a BullMQ retry or stall re-run keeps its job id, which is the token) can always
 * re-claim; a DIFFERENT job can take over only a `failed` row or a crashed holder's lapsed
 * `pending` row; a `sent` row is never re-claimed. That is exactly "retry-safe, and no duplicate
 * at the same sequence".
 *
 * ⚠ THIS REPOSITORY NEVER NOTIFIES AND NEVER SENDS. It records what the email channel did;
 * the transport lives in apps/api. Pinned by `invariants/repositories-never-notify.test.ts`.
 *
 * ⚠ NO RELATIONAL `with:` HERE, EVER. The schema defines only a `calendarEvent` relation; a
 * user / guest hydration would pull recipient addresses into callers
 * (`reference_drizzle_with_hydration_leaks_secrets`). Core select builder only.
 */

/** Who one send went to. Exactly one of the two recipient columns, by CHECK. */
export type CalendarSendRecipient =
  | { readonly kind: 'user'; readonly userId: string }
  | { readonly kind: 'guest'; readonly guestId: string };

export interface ClaimCalendarSendInput {
  /** The live `meeting_calendar_events.id` whose `uid` the ICS carries. */
  readonly calendarEventId: string;
  readonly recipient: CalendarSendRecipient;
  /** The SEQUENCE read from the calendar row at send time — part of the dedupe key. */
  readonly sequence: number;
  readonly method: MeetingCalendarDeliveryMethod;
  readonly channel: MeetingCalendarDeliveryChannel;
  /** The BullMQ job id. Stable across that job's retries, which is what lets it re-claim. */
  readonly claimToken: string;
}

export type ClaimCalendarSendResult =
  /** This job holds the claim — send now, then `markSent` / `markFailed`. */
  | { readonly status: 'claimed'; readonly delivery: MeetingCalendarDelivery }
  /** Already delivered at this SEQUENCE — do NOT send. */
  | { readonly status: 'already_sent'; readonly delivery: MeetingCalendarDelivery }
  /** Another job holds a fresh claim — do NOT send; that job resolves it. */
  | { readonly status: 'in_flight'; readonly delivery: MeetingCalendarDelivery };

export interface MarkCalendarSendSentInput {
  readonly id: string;
  readonly claimToken: string;
  /** The transport's message id (nodemailer `info.messageId`), when it gave one. */
  readonly providerMessageId: string | null;
}

export interface MarkCalendarSendFailedInput {
  readonly id: string;
  readonly claimToken: string;
  /** CLASS / CODE ONLY (e.g. `Error:EAUTH:535`) — never a transport message, which can echo addresses. */
  readonly failureReason: string;
}

/** Lease after which ANOTHER job may take over a `pending` claim (a crashed holder). */
export const CALENDAR_SEND_CLAIM_LEASE_MINUTES = 15;

/**
 * The arbiter predicates, as INLINE `sql` — they must restate the partial uniques'
 * predicates for Postgres to select them as ON CONFLICT arbiters, and a bound parameter in an
 * arbiter's WHERE raises 42P10 (`reference_pg_partial_index_arbiter_param_42p10`). Both are
 * `IS [NOT] NULL` only, so there is nothing to bind.
 */
const USER_SEND_ARBITER: SQL = sql`${meetingCalendarDeliveries.recipientUserId} IS NOT NULL AND ${meetingCalendarDeliveries.deletedAt} IS NULL`;
const GUEST_SEND_ARBITER: SQL = sql`${meetingCalendarDeliveries.recipientGuestId} IS NOT NULL AND ${meetingCalendarDeliveries.deletedAt} IS NULL`;

/** How many times `claimSend` retries after observing a concurrently-failed row. */
const CLAIM_PASSES = 2;

/** The recipient half of the send key, for the refusal read. */
function recipientKey(recipient: CalendarSendRecipient): SQL {
  return recipient.kind === 'user'
    ? eq(meetingCalendarDeliveries.recipientUserId, recipient.userId)
    : eq(meetingCalendarDeliveries.recipientGuestId, recipient.guestId);
}

/**
 * ONE statement: insert the claim, or take over an existing row when the protocol allows.
 * Returns the claimed row, or `undefined` when the existing row refused the takeover.
 *
 * ⚠ UNQUALIFIED-OR-TABLE-QUALIFIED COLUMNS IN THE DO UPDATE `SET` / `WHERE` READ THE EXISTING
 * ROW (Postgres names the target table there; `excluded` would be the proposed one) — the same
 * rule `meetingCalendarEventsRepository.recordIcsDelivery`'s orphan guard relies on. So
 * `attempt_count + 1` increments the stored count and the lease compares the stored
 * `last_attempted_at`. The integration suite is the proof.
 */
async function tryClaim(
  input: ClaimCalendarSendInput
): Promise<MeetingCalendarDelivery | undefined> {
  const { recipient } = input;
  const isUser = recipient.kind === 'user';
  const t = meetingCalendarDeliveries;

  const [row] = await db
    .insert(t)
    .values({
      calendarEventId: input.calendarEventId,
      recipientUserId: recipient.kind === 'user' ? recipient.userId : null,
      recipientGuestId: recipient.kind === 'guest' ? recipient.guestId : null,
      channel: input.channel,
      method: input.method,
      sequence: input.sequence,
      outcome: 'pending',
      claimToken: input.claimToken,
      attemptCount: 1,
      lastAttemptedAt: sql`now()`,
    })
    .onConflictDoUpdate({
      target: isUser
        ? [t.calendarEventId, t.recipientUserId, t.sequence, t.method]
        : [t.calendarEventId, t.recipientGuestId, t.sequence, t.method],
      // ⚠⚠ Removing this breaks EVERY claim with 42P10 — the uniques are partial.
      targetWhere: isUser ? USER_SEND_ARBITER : GUEST_SEND_ARBITER,
      set: {
        outcome: 'pending',
        claimToken: input.claimToken,
        attemptCount: sql`${t.attemptCount} + 1`,
        lastAttemptedAt: sql`now()`,
        failureReason: null,
        updatedAt: sql`now()`,
      },
      // ⚠⚠ THE PROTOCOL. A `sent` row matches no arm, so it is never re-claimed.
      setWhere: sql`${t.outcome} = 'failed' OR (${t.outcome} = 'pending' AND (${t.claimToken} = ${input.claimToken} OR ${t.lastAttemptedAt} < now() - make_interval(mins => ${CALENDAR_SEND_CLAIM_LEASE_MINUTES})))`,
    })
    .returning();
  return row;
}

/** The live ledger row for one send key, if any. */
async function findLiveByKey(
  input: ClaimCalendarSendInput
): Promise<MeetingCalendarDelivery | undefined> {
  const t = meetingCalendarDeliveries;
  const [row] = await db
    .select()
    .from(t)
    .where(
      and(
        eq(t.calendarEventId, input.calendarEventId),
        recipientKey(input.recipient),
        eq(t.sequence, input.sequence),
        eq(t.method, input.method),
        isNull(t.deletedAt)
      )
    )
    .limit(1);
  return row;
}

export const meetingCalendarDeliveriesRepository = {
  /**
   * Claim the send of one ICS (event × recipient × SEQUENCE × method) for the job
   * `claimToken`, per the protocol table in the file docblock. Call it IMMEDIATELY before the
   * transport send.
   *
   * ONE write statement, then — only on a refusal — one read to say WHY (`already_sent` /
   * `in_flight`). ⚠ If that read finds a `failed` row, a concurrent `markFailed` landed
   * between the two statements; the row is re-claimable now, so the claim is attempted ONCE
   * more rather than reporting a stale `in_flight` that no job would ever resolve. A refused
   * claim with no live row is impossible (no writer soft-deletes a delivery) and THROWS.
   */
  async claimSend(input: ClaimCalendarSendInput): Promise<ClaimCalendarSendResult> {
    for (let pass = 0; pass < CLAIM_PASSES; pass++) {
      const claimed = await tryClaim(input);
      if (claimed !== undefined) {
        return { status: 'claimed', delivery: claimed };
      }

      const existing = await findLiveByKey(input);
      if (existing === undefined) {
        throw new Error(
          `Calendar send claim refused but no live delivery row exists for calendar event ${input.calendarEventId}`
        );
      }
      if (existing.outcome === 'sent') {
        return { status: 'already_sent', delivery: existing };
      }
      if (existing.outcome === 'pending') {
        return { status: 'in_flight', delivery: existing };
      }
      // `failed`: raced a concurrent markFailed — loop and claim it.
    }
    throw new Error(
      `Calendar send claim for calendar event ${input.calendarEventId} kept racing concurrent failures`
    );
  },

  /**
   * Resolve THIS job's claim as sent. Compare-and-set on `(id, claim_token, outcome =
   * 'pending')`, so a job whose lapsed claim was taken over cannot overwrite the new holder.
   * `undefined` ⇒ the claim was taken over; the caller logs a warn and never throws (the
   * message is already out — a rethrow would make BullMQ send it again).
   */
  async markSent(input: MarkCalendarSendSentInput): Promise<MeetingCalendarDelivery | undefined> {
    const t = meetingCalendarDeliveries;
    const [row] = await db
      .update(t)
      .set({
        outcome: 'sent',
        sentAt: sql`now()`,
        providerMessageId: input.providerMessageId,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(t.id, input.id),
          eq(t.claimToken, input.claimToken),
          eq(t.outcome, 'pending'),
          isNull(t.deletedAt)
        )
      )
      .returning();
    return row;
  },

  /**
   * Resolve THIS job's claim as failed — same compare-and-set as `markSent`. A `failed` row is
   * re-claimable by any job. `undefined` ⇒ the claim was taken over.
   */
  async markFailed(
    input: MarkCalendarSendFailedInput
  ): Promise<MeetingCalendarDelivery | undefined> {
    const t = meetingCalendarDeliveries;
    const [row] = await db
      .update(t)
      .set({
        outcome: 'failed',
        failureReason: input.failureReason,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(t.id, input.id),
          eq(t.claimToken, input.claimToken),
          eq(t.outcome, 'pending'),
          isNull(t.deletedAt)
        )
      )
      .returning();
    return row;
  },
};

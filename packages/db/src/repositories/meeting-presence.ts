import { and, asc, eq, inArray, isNotNull, isNull, type SQL } from 'drizzle-orm';
import {
  computeMeetingClocks,
  type MeetingClocks,
  type PresenceInterval,
} from '@balo/shared/meetings';
import { db } from '../client';
import {
  meetingContexts,
  meetingPresence,
  meetings,
  type MeetingParticipantParty,
  type MeetingPresence,
} from '../schema';

export interface OpenPresenceInput {
  meetingId: string;
  /** `null` for a guest (`meeting_guests` carries no user until conversion). */
  userId: string | null;
  /**
   * ⚠ MUST BE SERVER-DERIVED. See the "party is a billing input" warning on
   * `meetingPresenceRepository` — this argument decides whether an attendee makes the
   * meeting billable, so it may never come from vendor metadata or client input.
   */
  party: MeetingParticipantParty;
  /** Defaults to now. */
  joinedAt?: Date;
}

/** `user_id` is NULLABLE, and `= NULL` is never TRUE — every read must branch to `IS NULL`. */
function userIdMatches(userId: string | null): SQL | undefined {
  return userId === null ? isNull(meetingPresence.userId) : eq(meetingPresence.userId, userId);
}

/**
 * Resolve the instant an open interval is measured TO, when the caller supplies no `now`.
 *
 * ⚠ WHY THIS IS NOT JUST `new Date()`. An interval with `left_at IS NULL` runs to whatever
 * instant it is measured against — forever. If both Daily `participant-left` webhooks are
 * dropped on a call that ran 10:00 → 10:30, a settlement job running at 02:00 the next
 * morning would compute a 16-hour `billableMs` instead of 30 minutes. SIXTEEN, not the
 * 15.5 of overshoot past the true end: the clock is a SPAN anchored at the FIRST
 * both-present instant — the 10:00 JOIN — so it runs 10:00 → 02:00 in full. A silent,
 * large OVER-BILL against a real client. Both numbers are PINNED by the docblock test in
 * `meeting-presence.integration.test.ts` so this example cannot drift.
 *
 * So: once the meeting is TERMINAL, the wall clock is no longer a legitimate ceiling —
 * `meetings.ended_at` is. Falling back to the wall clock is correct ONLY while the meeting
 * is still running, where "to now" is exactly what an in-session panel (BAL-403) wants.
 *
 * ⚠ RESIDUAL, ASSIGNED IN WRITING: a meeting that is `ended` with a NULL `ended_at` still
 * measures to the wall clock, because this ticket owns no transition logic and will not
 * invent a ceiling out of `scheduled_end`. **BAL-134 must stamp `ended_at` in the SAME
 * statement that sets `status='ended'`** — that is what closes this last gap. BAL-412
 * additionally holds the settlement-side policy cap (it already carries
 * `effectiveCeilingMinor`).
 *
 * ⚠ `'cancelled'` (added to `meeting_status` by BAL-428) IS ALSO TERMINAL, AND IS NOT
 * HANDLED HERE — deliberately, and only because of a guard in another file. `cancel()` is
 * gated on `status='scheduled'`, and a `scheduled` meeting has no presence intervals (the
 * first join is what moves it to `waiting_for_participants`), so a cancelled meeting cannot
 * carry an open interval for this function to mis-measure. THAT IS THE WHOLE ARGUMENT — it
 * is a property of `meetingsRepository.cancel`'s guard, not of anything here. If cancel is
 * ever widened to a state a participant can have joined from, a cancelled meeting with an
 * open interval will measure to `new Date()` FOREVER, which is exactly the silent over-bill
 * the paragraphs above exist to prevent. Widen this check in the same change.
 *
 * ⚠ AND THE GENERAL RULE THIS INSTANCE ILLUSTRATES: every `ALTER TYPE meeting_status ADD
 * VALUE` must sweep the readers that branch on the label, not just the writers. See
 * `schema/enums.ts`'s `meetingStatusEnum` docblock for the current list.
 */
async function resolveClockCeiling(meetingId: string): Promise<Date> {
  const [meeting] = await db
    .select({ status: meetings.status, endedAt: meetings.endedAt })
    .from(meetings)
    .where(and(eq(meetings.id, meetingId), isNull(meetings.deletedAt)))
    .limit(1);

  if (meeting !== undefined && meeting.status === 'ended' && meeting.endedAt !== null) {
    return meeting.endedAt;
  }
  return new Date();
}

/**
 * `meetingPresenceRepository` (BAL-418 / ADR-1045 §6) — the per-interval presence store
 * plus BAL-412's settlement read.
 *
 * BAL-134 owns the WRITE LOGIC (which webhook opens/closes which interval, and how the
 * meeting's status moves with it); this repository owns the storage primitives and the
 * read. The clock arithmetic itself lives in `@balo/shared/meetings` — PURE, so BAL-403's
 * in-session client panel can render it without value-importing `@balo/db`.
 *
 * ⚠⚠ `party` IS A BILLING INPUT AND MUST BE SERVER-DERIVED. It is the ONLY thing keeping a
 * Balo staffer from making a meeting billable: `observer` is excluded from BOTH sides of
 * the billable intersection in `computeMeetingClocks`, so an attendee recorded as `client`
 * instead of `observer` silently converts a `no_show_client` (nothing owed) into a fully
 * billable call. **BAL-134 MUST derive `party` server-side from engagement / agency
 * identity** — never from Daily `userData`, never from a join-link query parameter, never
 * from anything the joining browser can influence. This repository cannot enforce that
 * (authorization is the service layer's, per ADR-1029/ADR-1046); it states the obligation.
 *
 * ⚠ PRESENCE INTERVALS ARE UNBOUNDED RELATIVE TO THE MEETING WINDOW. The only DB CHECK is
 * `left_at >= joined_at` (`meeting_presence_left_after_joined`) — nothing rejects a
 * `joinedAt` six hours before `scheduled_start`, or a `leftAt` a day after `scheduled_end`.
 * Clamping presence to the meeting window is **BAL-134's** (it owns the webhook writes) with
 * **BAL-412** holding the settlement-side cap. Assigned here in writing so it is not
 * rediscovered as a billing incident.
 *
 * ⚠ ADR-1030 RESIDUAL, ASSIGNED IN WRITING. The system-actor attribution exemption stated on
 * the `meeting_presence` schema docblock covers the MACHINE path ONLY — `open`/`close` are
 * webhook seams with no human actor, and this ticket ships no `adjust`. A HUMAN-INITIATED
 * presence write is a different class: an admin correcting an interval to fix a disputed bill
 * is a PERSON CHANGING A MONEY INPUT and is NOT exempt — it must carry an actor and write an
 * `audit_events` row in the SAME transaction as the correction, per ADR-1030's floor+ceiling
 * spine, composed at the action layer (ADR-1030 keeps repositories actor-agnostic, so the
 * actor threads in from the caller, as `recordDeliveryAudit` does). **BAL-134 owns this if it
 * adds a manual correction path; BAL-412 owns it if settlement does.** Assigned here so it is
 * not rediscovered as a billing incident.
 */
export const meetingPresenceRepository = {
  /**
   * BAL-134 WRITE SEAM — open a presence interval.
   *
   * IDEMPOTENT on `meeting_presence_one_open_per_user_idx`: a duplicate join webhook for
   * an AUTHENTICATED participant returns the EXISTING open interval instead of opening a
   * second one that would double-count the clocks.
   *
   * ⚠ GUEST GAP (documented on the index too): `user_id` is NULL for a guest and NULLs are
   * DISTINCT in a unique index, so a guest join is NOT deduplicated — each call opens a
   * new interval. Accepted here (guests carry no presence identity until BAL-408);
   * BAL-134/BAL-408 must add the guest-keyed equivalent when guest identity lands.
   */
  async open(input: OpenPresenceInput): Promise<MeetingPresence> {
    const [inserted] = await db
      .insert(meetingPresence)
      .values({
        meetingId: input.meetingId,
        userId: input.userId,
        party: input.party,
        joinedAt: input.joinedAt ?? new Date(),
      })
      .onConflictDoNothing({
        target: [meetingPresence.meetingId, meetingPresence.userId],
        // predicate MUST match `meeting_presence_one_open_per_user_idx` exactly
        where: and(isNull(meetingPresence.leftAt), isNull(meetingPresence.deletedAt)),
      })
      .returning();

    if (inserted !== undefined) {
      return inserted;
    }

    const existing = await this.findOpen(input.meetingId, input.userId);
    if (existing === undefined) {
      throw new Error(
        `meetingPresence.open conflicted but no open interval was found for meeting ${input.meetingId}`
      );
    }
    return existing;
  },

  /** The participant's OPEN interval, if any. Rides `meeting_presence_open_idx`. */
  async findOpen(meetingId: string, userId: string | null): Promise<MeetingPresence | undefined> {
    const [row] = await db
      .select()
      .from(meetingPresence)
      .where(
        and(
          eq(meetingPresence.meetingId, meetingId),
          userIdMatches(userId),
          isNull(meetingPresence.leftAt),
          isNull(meetingPresence.deletedAt)
        )
      )
      .orderBy(asc(meetingPresence.joinedAt), asc(meetingPresence.id))
      .limit(1);
    return row;
  },

  /**
   * BAL-134 WRITE SEAM — close the participant's OPEN interval. IDEMPOTENT: returns
   * `undefined` when none is open (a duplicate leave webhook is a no-op, never an error).
   *
   * `leftAt` defaults to now. A `leftAt` before `joined_at` is rejected by the DB CHECK
   * `meeting_presence_left_after_joined` (`>=`, so a zero-length blip is legal).
   *
   * ⚠ THE `isNull(leftAt)` IN THE `where` IS A COMPARE-AND-SET, NOT DECORATION. Without it
   * this is a read-then-write race on a MONEY path: two retried Daily `participant-left`
   * webhooks can both pass `findOpen` before either commits, and the LATER write would
   * silently overwrite `left_at` with its own (later) timestamp. Because the clock is a
   * SPAN, that extends the billable window — a silent over-bill. With the CAS, the second
   * writer matches zero rows and returns `undefined`, which is exactly the "duplicate leave
   * webhook is a no-op" contract this docblock already promises. FIRST CLOSE WINS.
   */
  async close(input: {
    meetingId: string;
    userId: string | null;
    leftAt?: Date;
  }): Promise<MeetingPresence | undefined> {
    const open = await this.findOpen(input.meetingId, input.userId);
    if (open === undefined) {
      return undefined;
    }

    const now = new Date();
    const [updated] = await db
      .update(meetingPresence)
      .set({ leftAt: input.leftAt ?? now, updatedAt: now })
      // CAS: re-assert the interval is STILL open at write time (see the warning above).
      .where(and(eq(meetingPresence.id, open.id), isNull(meetingPresence.leftAt)))
      .returning();
    return updated;
  },

  /**
   * Every LIVE presence interval for a meeting, in join order. Queryable AFTER the meeting
   * ends — the rows are the durable billing input (BAL-412), not ephemeral room state.
   */
  async listByMeeting(meetingId: string): Promise<MeetingPresence[]> {
    return db
      .select()
      .from(meetingPresence)
      .where(and(eq(meetingPresence.meetingId, meetingId), isNull(meetingPresence.deletedAt)))
      .orderBy(asc(meetingPresence.joinedAt), asc(meetingPresence.id));
  },

  /**
   * BAL-412's SETTLEMENT READ — both clocks for a meeting. A thin wrapper: fetch the live
   * intervals, then delegate to the pure `computeMeetingClocks`.
   *
   * `now` is the instant any still-OPEN interval is measured to. When omitted it defaults
   * to `meetings.ended_at` for a TERMINAL meeting and to the wall clock only while the
   * meeting is still running — see `resolveClockCeiling` for why the wall clock alone is an
   * over-bill hazard on a dropped leave webhook. An explicit `now` always wins (BAL-403's
   * in-session panel and the tests both pass one).
   */
  async clocks(meetingId: string, now?: Date): Promise<MeetingClocks> {
    const rows = await this.listByMeeting(meetingId);
    const intervals: PresenceInterval[] = rows.map((row) => ({
      party: row.party,
      joinedAt: row.joinedAt,
      leftAt: row.leftAt,
    }));
    return computeMeetingClocks(intervals, now ?? (await resolveClockCeiling(meetingId)));
  },

  /**
   * BAL-390 — the DISTINCT authenticated CLIENT-SIDE people who actually attended any
   * live meeting held for this engagement. The review nudge's participant source: an ask
   * goes to people who were IN THE ROOM, not to everyone with a membership.
   *
   * `meeting_presence ⋈ meetings ⋈ meeting_contexts`, filtered to
   * `meeting_contexts.context_id = engagementId` over the ENGAGEMENT-SCOPED context types
   * (ADR-1045 §2). `project_discovery` is EXCLUDED because its `context_id` is a
   * `project_requests.id`, not an engagement id, and `admin` because its `context_id` is
   * NULL — `context_id` is POLYMORPHIC, so matching on it alone is not sufficient. Naming
   * the types also puts the leading column of `meeting_context_reverse_idx`
   * (`context_type, context_id`) in the predicate, so the read rides it. Enum literals at
   * QUERY time are safe; the house restriction is index predicates and CHECKs only.
   *
   * `party = 'client'` excludes the delivering expert (who must never be nudged to review
   * themselves) and `observer` Balo staff. `user_id IS NOT NULL` drops guests, who carry
   * no user identity until BAL-408 and therefore cannot hold a capability or a review.
   * All three tables' `deleted_at` are guarded.
   *
   * ⚠ THIS RETURNS `[]` TODAY. `meetings` has NO production writer (BAL-129/134 are
   * unbuilt), so no presence row exists for any engagement. The code is real and tested;
   * a builder running a manual end-to-end test and expecting nudges from participation
   * will be confused unless they read this line. The client company's owner is therefore
   * the only nudge recipient today — but NOT as a fallback: the sweep unions the owner in
   * UNCONDITIONALLY on every tick, participants or not (`review-nudge-sweep.ts`, pinned by
   * "ALWAYS asks the company owner, even when participants were recorded"). Calling it a
   * fallback invites precisely the "guard it on participants being empty" change that that
   * test exists to block.
   */
  async listClientUserIdsForEngagement(engagementId: string): Promise<string[]> {
    const rows = await db
      .selectDistinct({ userId: meetingPresence.userId })
      .from(meetingPresence)
      .innerJoin(meetings, eq(meetings.id, meetingPresence.meetingId))
      .innerJoin(meetingContexts, eq(meetingContexts.meetingId, meetings.id))
      .where(
        and(
          eq(meetingContexts.contextId, engagementId),
          inArray(meetingContexts.contextType, [
            'case',
            'project_kickoff',
            'package_session',
            'retainer_checkin',
          ]),
          eq(meetingPresence.party, 'client'),
          isNotNull(meetingPresence.userId),
          isNull(meetingPresence.deletedAt),
          isNull(meetings.deletedAt),
          isNull(meetingContexts.deletedAt)
        )
      );

    return rows.flatMap((row) => (row.userId === null ? [] : [row.userId]));
  },
};

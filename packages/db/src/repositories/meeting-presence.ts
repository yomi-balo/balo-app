import { and, asc, eq, inArray, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import {
  computeMeetingClocks,
  summarisePresence,
  type LifecyclePresenceInterval,
  type MeetingClocks,
  type PresenceFacts,
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
import type { DbExecutor } from './_shared/db-executor';

/**
 * WHO an interval belongs to. The two columns are MUTUALLY EXCLUSIVE (the DB CHECK
 * `meeting_presence_identity_not_both`), and BOTH may be null — that third arm is a real,
 * intended state, not a defect: BAL-134's webhook writer may legitimately observe a Daily
 * participant it cannot map to either table, and `meeting_presence` was designed to permit a
 * NULL identity beside a KNOWN `party` rather than force the writer to guess. A guess would
 * anchor a billing clock on the wrong person.
 *
 * ⚠ A CALLER MUST SET AT MOST ONE. `open()` rejects both-set in-process
 * (`InvalidPresenceIdentityError`) rather than letting the CHECK raise a bare `23514`.
 */
export interface PresenceIdentity {
  /** The Balo user, for an authenticated participant. NULL for a guest or an unmapped one. */
  userId: string | null;
  /**
   * BAL-408 — the `meeting_guests` row, for a token-authenticated guest. NULL for an
   * authenticated participant or an unmapped one.
   *
   * ⚠ NEVER SET BOTH THIS AND `userId` FOR THE SAME GUEST. `schema/meeting-presence.ts`'s
   * hand-off spells out why: writing `user_id` for a guest would violate the identity CHECK
   * (if both were set) or silently re-open the duplicate-interval gap (if only `user_id`
   * were), because the guest-keyed unique index would then not cover the row.
   */
  meetingGuestId: string | null;
}

/**
 * BAL-134 (R10) — the MEETING WINDOW a presence instant is clamped into on the WRITE side.
 *
 * ⚠⚠ WHY THE CLAMP IS HERE AND NOT IN `computeMeetingClocks`. That pure function anchors
 * `expertPresentMs` at the first expert join UN-CLAMPED, and its numbers are pinned by
 * executed tests — so clamping there would change shipped, asserted arithmetic. The presence
 * schema docblock assigns the window bound to the WRITE side by name ("nothing rejects… a
 * `leftAt` a day after `scheduled_end`… Clamping presence to the meeting window is
 * **BAL-134's**"), and this is that seam.
 *
 * ⚠ IT IS OPT-IN, AND THAT IS DELIBERATE. The repository does NOT read the meeting row to
 * derive the window itself, for the same reason `meetingsRepository.cancel()` does not read
 * the wall clock: the upper bound is a POLICY value (`scheduled_end + MEETING_TOKEN_TTL_
 * AFTER_END_MS`, an `apps/api` constant), and a repository that resolved policy would make
 * every fixture and every backfill subject to a number that can change. The caller — which
 * already holds the meeting row — supplies both halves together so it cannot pass one and
 * forget the other.
 */
export interface PresenceWindow {
  /**
   * `joined_at` is RAISED to this. In production it is `meetings.scheduled_start`, and the
   * rule it encodes is the ticket's verbatim: **an expert arriving at 09:55 for a 10:00 call
   * is not credited for arriving early.**
   */
  notBefore: Date;
  /**
   * `left_at` is LOWERED to this. In production it is `scheduled_end` plus the token TTL —
   * GENEROUS ON PURPOSE, because a legitimately over-running call must not be truncated into
   * an under-bill. This bound exists to stop a nonsense timestamp (a `left_at` a day late),
   * NOT to cap a long call; the settlement-side policy cap remains BAL-412's
   * `effectiveCeilingMinor`.
   */
  notAfter: Date;
}

export interface OpenPresenceInput extends PresenceIdentity {
  meetingId: string;
  /**
   * ⚠ MUST BE SERVER-DERIVED. See the "party is a billing input" warning on
   * `meetingPresenceRepository` — this argument decides whether an attendee makes the
   * meeting billable, so it may never come from vendor metadata or client input.
   */
  party: MeetingParticipantParty;
  /** Defaults to now. Rejected when non-finite (see `InvalidPresenceTimestampError`). */
  joinedAt?: Date;
  /** BAL-134's R10 clamp. Omit to store the instant exactly as given. */
  window?: PresenceWindow;
}

export interface ClosePresenceInput extends PresenceIdentity {
  meetingId: string;
  /** Defaults to now. Rejected when non-finite (see `InvalidPresenceTimestampError`). */
  leftAt?: Date;
  /** BAL-134's R10 clamp. Omit to store the instant exactly as given. */
  window?: PresenceWindow;
}

/**
 * Thrown when a presence instant is not a finite time.
 *
 * ⚠ THIS OBLIGATION IS ASSIGNED TO BAL-134 BY NAME. `computeMeetingClocks`'s docblock says
 * the write seam "must reject a non-finite timestamp", and this is that seam. `new Date(x)`
 * on a malformed vendor field yields an Invalid Date, whose `getTime()` is `NaN`; every
 * comparison against it is FALSE, so it would not be caught by the `left_at >= joined_at`
 * CHECK either — it would persist as a NULL-ish timestamp and poison every clock read of that
 * meeting forever. Loud and early, at the one door it can enter through.
 *
 * The webhook route logs this at `error` and still answers `200`: Daily must not retry a body
 * that will never be writable (edge case 22).
 */
export class InvalidPresenceTimestampError extends Error {
  constructor(
    public readonly field: string,
    public readonly value: Date
  ) {
    super(`meeting_presence.${field} must be a finite timestamp (received ${String(value)})`);
    this.name = 'InvalidPresenceTimestampError';
  }
}

/**
 * Thrown when a caller supplies BOTH identity columns — the in-process mirror of the DB CHECK
 * `meeting_presence_identity_not_both`. A named error rather than a raw `23514` because the
 * webhook writer branches on identity kind and a both-set call is a WRITER bug, not a data
 * condition; it should read as one at the point it happens.
 */
export class InvalidPresenceIdentityError extends Error {
  constructor(public readonly meetingId: string) {
    super(
      `A presence interval carries AT MOST ONE identity — user_id and meeting_guest_id were both set (meeting ${meetingId})`
    );
    this.name = 'InvalidPresenceIdentityError';
  }
}

/** Guard every instant that reaches a `timestamptz` on this money path. */
function assertFiniteInstant(field: string, value: Date): void {
  if (!Number.isFinite(value.getTime())) {
    throw new InvalidPresenceTimestampError(field, value);
  }
}

/** Guard a supplied window's own two instants — a NaN bound would clamp to nonsense. */
function assertFiniteWindow(window: PresenceWindow | undefined): void {
  if (window === undefined) {
    return;
  }
  assertFiniteInstant('window.notBefore', window.notBefore);
  assertFiniteInstant('window.notAfter', window.notAfter);
}

/**
 * The LOWER half of the R10 clamp. Early arrival earns nothing.
 *
 * ⚠ NO UPPER CLAMP ON A JOIN, on purpose. A join AFTER `notAfter` is a real event (someone
 * wandered into a room long after the window) and rewriting it downwards would fabricate
 * attendance that did not happen. It self-corrects instead: the matching close is clamped
 * DOWN to `notAfter`, lands below this `joined_at`, and `clampLeftAt` degrades the pair to a
 * zero-length interval — which bills nothing and is legal (`meeting_presence_left_after_joined`
 * is `>=`).
 */
function clampJoinedAt(instant: Date, window: PresenceWindow | undefined): Date {
  if (window === undefined) {
    return instant;
  }
  return instant.getTime() < window.notBefore.getTime() ? window.notBefore : instant;
}

/**
 * The UPPER half of the R10 clamp, then the zero-length degradation.
 *
 * ⚠ THE `joinedAt` RAISE APPLIES ONLY UNDER A WINDOW, and only because the clamp itself can
 * produce the inversion (a call ended before a `joined_at` that was clamped UP to
 * `scheduled_start` — the expert who joined at 09:55 and left at 09:58 on a 10:00 call). It is
 * NOT a general "fix the caller's timestamp" rule: without a `window`, an explicit `leftAt`
 * before `joined_at` still reaches `meeting_presence_left_after_joined` and raises `23514`,
 * loudly, exactly as it does today. A repository that silently rewrote every caller's instant
 * would hide writer bugs on a money path.
 */
function clampLeftAt(instant: Date, joinedAt: Date, window: PresenceWindow | undefined): Date {
  if (window === undefined) {
    return instant;
  }
  const lowered = instant.getTime() > window.notAfter.getTime() ? window.notAfter : instant;
  return lowered.getTime() < joinedAt.getTime() ? joinedAt : lowered;
}

/**
 * Match the ONE interval belonging to this identity.
 *
 * ⚠ THE THIRD ARM IS THE LOAD-BEARING ONE, AND IT IS A FIX. Before guest identity existed,
 * a null `userId` matched on `user_id IS NULL` alone — which, now that guest rows exist,
 * would ALSO match every guest's interval. Closing "the unmapped participant" would then close
 * an arbitrary GUEST's interval instead, truncating a real attendee's billable span. Both
 * columns are therefore constrained on that arm. The other two arms need no such widening:
 * `user_id = $1` cannot match a guest row (guests carry a NULL `user_id`) and vice versa.
 */
function identityMatches(identity: PresenceIdentity): SQL {
  if (identity.meetingGuestId !== null) {
    return eq(meetingPresence.meetingGuestId, identity.meetingGuestId);
  }
  if (identity.userId !== null) {
    return eq(meetingPresence.userId, identity.userId);
  }
  return sql`${meetingPresence.userId} IS NULL AND ${meetingPresence.meetingGuestId} IS NULL`;
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
 * ⚠ THE RESIDUAL THIS DOCBLOCK ASSIGNED TO BAL-134 IS NOW DISCHARGED — AND THE FALLBACK STAYS
 * ANYWAY. The ask was: "**BAL-134 must stamp `ended_at` in the SAME statement that sets
 * `status='ended'`**". `meetingsRepository.endMeeting` does exactly that — ONE `UPDATE` setting
 * `status`, `ended_at`, `ended_by` and `outcome` together, so the two can never be observed
 * out of step and this function's `ended` + `ended_at` branch is now genuinely reachable for
 * the first time. That is also why `endMeeting` closes every open interval on the SAME
 * transaction: a terminal meeting with an open interval is the state this ceiling exists to
 * survive, and after `endMeeting` it does not occur.
 *
 * The wall-clock fallback below is NOT dead code and must not be deleted. It still covers
 * (a) rows that were `ended` before migration 0066, (b) any meeting force-ended by a manual
 * `UPDATE` or a fixture that bypasses `endMeeting`, and (c) every NON-terminal meeting, where
 * "to now" is the wanted answer. BAL-412 additionally holds the settlement-side policy cap (it
 * already carries `effectiveCeilingMinor`).
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
 * ⚠ PRESENCE INTERVALS ARE UNBOUNDED RELATIVE TO THE MEETING WINDOW **AT THE DB LEVEL**. The
 * only DB CHECK is `left_at >= joined_at` (`meeting_presence_left_after_joined`) — nothing
 * rejects a `joinedAt` six hours before `scheduled_start`, or a `leftAt` a day after
 * `scheduled_end`. Clamping presence to the meeting window was assigned to **BAL-134** (it
 * owns the webhook writes) with **BAL-412** holding the settlement-side cap.
 *
 * **BAL-134 HAS DISCHARGED ITS HALF, AS AN OPT-IN `PresenceWindow` ON `open`/`close` — READ
 * THAT TYPE'S DOCBLOCK BEFORE ASSUMING A CLAMP HAPPENED.** The bound is NOT enforced by this
 * table and NOT enforced by default: a caller that omits `window` stores the instant exactly
 * as given, which is what every fixture and backfill wants. Production's webhook writer
 * supplies it from the meeting row on every call. So "presence is clamped" is true of the
 * PRODUCTION PATH, not of the storage — do not read a row back and infer it was bounded.
 *
 * ⚠ AND THE CLOCKS STILL RUN TO `now` FOR AN OPEN INTERVAL regardless of any clamp — the
 * clamp bounds the two ENDPOINTS a webhook writes, never the measurement of an interval that
 * was never closed. That hazard is closed from the other end, by `closeAllOpen` +
 * `meetings.ended_at` (see `resolveClockCeiling`).
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
   * IDEMPOTENT ON BOTH IDENTITY KINDS (the gap BAL-418 documented here is now CLOSED). The
   * arbiter is chosen by which identity column is set:
   *
   *   · authenticated → `meeting_presence_one_open_per_user_idx` on `(meeting_id, user_id)`;
   *   · guest (BAL-408) → `meeting_presence_one_open_per_guest_idx` on
   *     `(meeting_id, meeting_guest_id)`, whose predicate additionally names
   *     `meeting_guest_id IS NOT NULL`.
   *
   * Either way a duplicate join webhook returns the EXISTING open interval instead of opening
   * a second one that would double-count the clocks.
   *
   * ⚠ THE GUEST ARBITER PREDICATE IS RAW `sql` AND MUST STAY THAT WAY, restated byte-for-byte
   * against the index. Postgres infers the target index by proving the supplied predicate
   * implies the index's, and its prover works on `Const` nodes: a drizzle `eq()` emits a BIND
   * PARAMETER, which it cannot match, and the upsert fails `42P10` at runtime with every local
   * gate green (memory `reference_pg_partial_index_arbiter_param_42p10`). This particular
   * predicate happens to contain only `IS [NOT] NULL` tests and so binds nothing — but it is
   * written raw anyway, beside a comment saying why, because the failure mode is invisible
   * until an integration test hits a real Postgres. The user arm is left exactly as BAL-418
   * shipped it (also parameter-free) rather than churned for cosmetic symmetry.
   *
   * ⚠ THE ONE CLASS THAT STILL IS NOT DEDUPLICATED: an interval with NO identity at all
   * (both columns NULL — the unmappable Daily participant of §5.3). NULLs are distinct in a
   * unique index, so each such call opens a fresh interval. That is IRREDUCIBLE rather than
   * an oversight: there is no key to deduplicate on. It is also the SAFE side of the trade —
   * such a participant is written `party='observer'`, which `computeMeetingClocks` excludes
   * from BOTH sides of the billable intersection, so a duplicated one bills nothing.
   *
   * Takes an executor so the webhook's marker insert, this effect and the `processed_at`
   * stamp commit or roll back TOGETHER (§5.1) — a marker committed without its effect would
   * suppress the very retry that would have applied it.
   */
  async open(input: OpenPresenceInput, exec: DbExecutor = db): Promise<MeetingPresence> {
    if (input.userId !== null && input.meetingGuestId !== null) {
      throw new InvalidPresenceIdentityError(input.meetingId);
    }
    const requestedJoinedAt = input.joinedAt ?? new Date();
    assertFiniteInstant('joined_at', requestedJoinedAt);
    assertFiniteWindow(input.window);
    const joinedAt = clampJoinedAt(requestedJoinedAt, input.window);

    const values = {
      meetingId: input.meetingId,
      userId: input.userId,
      meetingGuestId: input.meetingGuestId,
      party: input.party,
      joinedAt,
    };

    const inserted =
      input.meetingGuestId === null
        ? await exec
            .insert(meetingPresence)
            .values(values)
            .onConflictDoNothing({
              target: [meetingPresence.meetingId, meetingPresence.userId],
              // predicate MUST match `meeting_presence_one_open_per_user_idx` exactly
              where: and(isNull(meetingPresence.leftAt), isNull(meetingPresence.deletedAt)),
            })
            .returning()
        : await exec
            .insert(meetingPresence)
            .values(values)
            .onConflictDoNothing({
              target: [meetingPresence.meetingId, meetingPresence.meetingGuestId],
              // ⚠ RAW `sql`, restating `meeting_presence_one_open_per_guest_idx`'s predicate
              // byte-for-byte — see the 42P10 note in this method's docblock.
              where: sql`${meetingPresence.meetingGuestId} IS NOT NULL AND ${meetingPresence.leftAt} IS NULL AND ${meetingPresence.deletedAt} IS NULL`,
            })
            .returning();

    const [row] = inserted;
    if (row !== undefined) {
      return row;
    }

    const existing = await this.findOpen(input.meetingId, input, exec);
    if (existing === undefined) {
      throw new Error(
        `meetingPresence.open conflicted but no open interval was found for meeting ${input.meetingId}`
      );
    }
    return existing;
  },

  /**
   * The participant's OPEN interval, if any. Rides `meeting_presence_open_idx`.
   *
   * Takes the whole `PresenceIdentity` rather than a bare `userId` (changed by BAL-134): a
   * positional user id cannot express a guest, and the null case had to stop meaning "any row
   * with no user", which now includes every guest. See `identityMatches`.
   */
  async findOpen(
    meetingId: string,
    identity: PresenceIdentity,
    exec: DbExecutor = db
  ): Promise<MeetingPresence | undefined> {
    const [row] = await exec
      .select()
      .from(meetingPresence)
      .where(
        and(
          eq(meetingPresence.meetingId, meetingId),
          identityMatches(identity),
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
  async close(
    input: ClosePresenceInput,
    exec: DbExecutor = db
  ): Promise<MeetingPresence | undefined> {
    const requestedLeftAt = input.leftAt ?? new Date();
    assertFiniteInstant('left_at', requestedLeftAt);
    assertFiniteWindow(input.window);

    const open = await this.findOpen(input.meetingId, input, exec);
    if (open === undefined) {
      return undefined;
    }

    const leftAt = clampLeftAt(requestedLeftAt, open.joinedAt, input.window);
    const [updated] = await exec
      .update(meetingPresence)
      .set({ leftAt, updatedAt: new Date() })
      // CAS: re-assert the interval is STILL open at write time (see the warning above).
      .where(and(eq(meetingPresence.id, open.id), isNull(meetingPresence.leftAt)))
      .returning();
    return updated;
  },

  /**
   * BAL-134 — close EVERY open interval on a meeting in ONE statement, returning how many
   * were closed. The bulk sibling of `close()`, and the reason it exists is timing, not
   * convenience:
   *
   *   · `meetingsRepository.endMeeting` calls it on ITS transaction, so a meeting can never
   *     be `ended` while an interval is still open — which is what makes
   *     `resolveClockCeiling`'s `ended_at` ceiling actually bite;
   *   · the Daily `meeting.ended` webhook calls it when the last participant leaves, which
   *     repairs the DROPPED-`participant.left` case in under a second instead of waiting for
   *     the reconciliation tick.
   *
   * ⚠ `left_at = GREATEST(joined_at, $leftAt)`, NOT a bare `$leftAt`, AND THIS IS NOT
   * DEFENSIVE PADDING — without it `endMeeting` can fail outright on a real sequence. An
   * expert joins at 09:55 for a 10:00 call, so the R10 clamp stores `joined_at = 10:00`; they
   * then end the call at 09:58. A bare assignment writes `left_at < joined_at`, trips
   * `meeting_presence_left_after_joined` with `23514`, and — because this runs inside
   * `endMeeting`'s transaction — ROLLS BACK THE WHOLE TERMINATION, leaving the meeting
   * un-endable by that path forever. `GREATEST` degrades the pair to a zero-length interval
   * instead, which bills nothing and is explicitly legal (the CHECK is `>=`, "a zero-length
   * join blip is a real event, not a data error").
   *
   * ⚠ NO UPPER CLAMP HERE, deliberately, unlike `close()`'s optional window. The instant
   * passed by `endMeeting` IS the authoritative end of the meeting, and a call that legitimately
   * over-ran its scheduled window must not be truncated into an under-bill (edge case 20:
   * nothing terminates on `scheduled_end`).
   */
  async closeAllOpen(meetingId: string, leftAt: Date, exec: DbExecutor = db): Promise<number> {
    assertFiniteInstant('left_at', leftAt);

    const closed = await exec
      .update(meetingPresence)
      .set({
        leftAt: sql`greatest(${meetingPresence.joinedAt}, ${leftAt.toISOString()}::timestamptz)`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(meetingPresence.meetingId, meetingId),
          isNull(meetingPresence.leftAt),
          isNull(meetingPresence.deletedAt)
        )
      )
      .returning({ id: meetingPresence.id });

    return closed.length;
  },

  /**
   * Every OPEN live interval for a meeting, in join order — the lifecycle sweep's
   * RECONCILIATION read (D1 leg 2): whatever this returns that Daily's roster does not
   * confirm is a DROPPED `participant.left`, and gets closed at the sweep's `now`.
   *
   * Rides `meeting_presence_open_idx`, whose predicate is exactly this filter.
   *
   * ⚠ RETURNS FULL ROWS, INCLUDING THE IDENTITY COLUMNS — which is the point (the reconciler
   * must compare them against the vendor roster), but it means this read must NOT be handed
   * to a route unprojected. It carries no secret of its own (`meeting_presence` stores none),
   * but `meeting_guest_id` is a join key to a table that holds `token_hash` and `email`; a
   * caller that hydrates the `guest` relation off the back of it without an explicit
   * `columns:` projection leaks both (memory `reference_drizzle_with_hydration_leaks_secrets`).
   */
  async listOpen(meetingId: string, exec: DbExecutor = db): Promise<MeetingPresence[]> {
    return exec
      .select()
      .from(meetingPresence)
      .where(
        and(
          eq(meetingPresence.meetingId, meetingId),
          isNull(meetingPresence.leftAt),
          isNull(meetingPresence.deletedAt)
        )
      )
      .orderBy(asc(meetingPresence.joinedAt), asc(meetingPresence.id));
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
   * BOTH CLOCKS for a meeting. A thin wrapper: fetch the live intervals, then delegate to
   * the pure `computeMeetingClocks`.
   *
   * `now` is the instant any still-OPEN interval is measured to. When omitted it defaults
   * to `meetings.ended_at` for a TERMINAL meeting and to the wall clock only while the
   * meeting is still running — see `resolveClockCeiling` for why the wall clock alone is an
   * over-bill hazard on a dropped leave webhook. An explicit `now` always wins (BAL-403's
   * in-session panel and the tests both pass one).
   *
   * ⚠ THIS IS THE SINGLE-CLOCK SEAM, AND IT IS **NOT** WHAT SETTLEMENT READS. It stays
   * exactly as BAL-418 shipped it — BAL-403's in-session panel and `GET /meetings/:id/state`
   * are its callers. BAL-412 HAS landed and reads through {@link settlementFacts} instead,
   * because settlement additionally needs `clientSideEverPresent`, which is NOT derivable
   * from these four fields; see that method for why one read rather than two.
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
   * BAL-412's SETTLEMENT READ — the clocks AND the structural facts, from **ONE** query.
   *
   * ⚠⚠ ONE `listByMeeting`, REDUCED BY BOTH PURE FUNCTIONS, AND THE SINGLE READ IS THE
   * POINT. `computeMeetingClocks` gives the two durations; `summarisePresence` gives
   * `clientSideEverPresent`, which settlement needs and which **cannot be derived from
   * `MeetingClocks`**: `billableStartedAt === null` ALSO covers a client who joined and left
   * BEFORE the expert arrived, so reading absence off the clocks would settle a
   * client-attended call as a client no-show. Calling `clocks()` and a separate facts read
   * would issue two queries against a table a webhook can be writing to, and the two could
   * disagree about which rows exist — on the MONEY path, where the disagreement decides
   * whether anybody is charged at all.
   *
   * `now` resolves exactly as {@link clocks} resolves it (an explicit instant wins; otherwise
   * `meetings.ended_at` for a terminal meeting, else the wall clock), and the SAME instant is
   * used for both reductions — a second `resolveClockCeiling` call could land a millisecond
   * later and give the two answers different ceilings.
   *
   * ⚠ `summarisePresence` READS NO CEILING — it reports booleans and instants only, so an
   * open interval affects `expertOpen`/`anyOpen` and nothing time-valued. That is why passing
   * `now` to one reducer and not the other is correct rather than an oversight.
   *
   * ⚠ INERT ON MAIN (decision D10): its caller is the presence-settlement service, which
   * only ever acts on a `duration_source='presence'` session, and nothing on main opens one
   * (BAL-400 booking → BAL-466 session open would).
   */
  async settlementFacts(
    meetingId: string,
    now?: Date
  ): Promise<{ clocks: MeetingClocks; facts: PresenceFacts }> {
    const rows = await this.listByMeeting(meetingId);
    const ceiling = now ?? (await resolveClockCeiling(meetingId));

    const clockIntervals: PresenceInterval[] = rows.map((row) => ({
      party: row.party,
      joinedAt: row.joinedAt,
      leftAt: row.leftAt,
    }));
    const factIntervals: LifecyclePresenceInterval[] = rows.map((row) => ({
      party: row.party,
      joinedAt: row.joinedAt,
      leftAt: row.leftAt,
    }));

    return {
      clocks: computeMeetingClocks(clockIntervals, ceiling),
      facts: summarisePresence(factIntervals),
    };
  },

  /**
   * BAL-390 — the DISTINCT authenticated CLIENT-SIDE people who actually attended any
   * live meeting held for this engagement. The review nudge's participant source: an ask
   * goes to people who were IN THE ROOM, not to everyone with a membership.
   *
   * `meeting_presence ⋈ meetings ⋈ meeting_contexts`, filtered to
   * `meeting_contexts.context_id = engagementId` over the ENGAGEMENT-SCOPED context types
   * (ADR-1045 §2). `project_discovery` is EXCLUDED because its `context_id` is a
   * `project_requests.id`, not an engagement id; `request_interaction` (BAL-413) likewise,
   * its `context_id` being a `request_expert_relationships.id`; and `admin` because its
   * `context_id` is NULL — `context_id` is POLYMORPHIC, so matching on it alone is not
   * sufficient. Naming
   * the types also puts the leading column of `meeting_context_reverse_idx`
   * (`context_type, context_id`) in the predicate, so the read rides it. Enum literals at
   * QUERY time are safe; the house restriction is index predicates and CHECKs only.
   *
   * `party = 'client'` excludes the delivering expert (who must never be nudged to review
   * themselves) and `observer` Balo staff. `user_id IS NOT NULL` drops guests, who carry
   * no user identity until BAL-408 and therefore cannot hold a capability or a review.
   * All three tables' `deleted_at` are guarded.
   *
   * ⚠ THIS RETURNS `[]` TODAY — the conclusion still holds, but the reason has narrowed.
   * BAL-129 HAS shipped `POST /meetings`, so `meetings` now has a production WRITER; what it
   * has no production PRODUCER for is that route (it ships INERT — no UI calls it until
   * BAL-400) and, more decisively, presence rows are BAL-134's and BAL-134 is unbuilt. So no
   * `meeting_presence` row exists for any engagement either way. The code is real and tested;
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
          // ⚠ AN ALLOW-LIST, SO A NEW `meeting_context_type` LABEL IS SILENTLY EXCLUDED —
          // nothing here typechecks against the enum. Correct for every label added so
          // far (only these four carry an `engagements.id`), but a future
          // ENGAGEMENT-GRAIN label would silently drop client participants from the
          // review-nudge fan-out with no failure anywhere. `invariants/
          // meeting-context-type-labels.test.ts` names this line in its sweep list.
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

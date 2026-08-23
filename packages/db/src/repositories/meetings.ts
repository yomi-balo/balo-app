import { and, asc, eq, gte, inArray, isNull, notInArray } from 'drizzle-orm';
import { assertMeetingTransition, type MeetingLifecycleStatus } from '@balo/shared/meetings';
import { db } from '../client';
import {
  meetings,
  meetingContexts,
  type Meeting,
  type MeetingContext,
  type MeetingContextType,
  type MeetingEndedBy,
  type MeetingOutcome,
  type MeetingStatus,
  type NewMeeting,
} from '../schema';
import {
  cancelProjectionTx,
  projectNewMeetingTx,
  softDeleteProjectionTx,
  syncProjectionScheduleTx,
} from './_shared/consultation-projection';
import type { DbExecutor } from './_shared/db-executor';
import { recordMeetingAudit, recordMeetingBooked } from './_shared/meeting-audit';
import { meetingPresenceRepository } from './meeting-presence';

/**
 * ⚠⚠ THE THREE STATUS MUTATORS' COMPARE-AND-SET **FROM** SETS, DECLARED ONCE AND CHECKED
 * AGAINST `MEETING_TRANSITIONS` ON EVERY CALL.
 *
 * `@balo/shared/meetings`'s `assertMeetingTransition` shipped with NO production caller while
 * its docblock claimed it was "consulted by EVERY writer" and that the map and the CAS were
 * "two independent guards". That was one guard and a false comment. These arrays make it true:
 * each is BOTH the `inArray` predicate the CAS uses AND the list asserted against the map, so
 * the two cannot drift — widening a CAS to an edge the map does not declare now THROWS on the
 * next call instead of silently writing an illegal transition.
 *
 * ⚠ IT IS AN ASSERTION ABOUT THE WRITER'S DECLARED EDGES, NOT ABOUT ONE ROW. A CAS writer never
 * reads the row before it writes, so its `from` is a SET, not an observed value — checking the
 * set is the strongest statement available here, and the CAS itself still catches the race.
 * Pure and allocation-free, so it costs nothing to run on every call.
 */
export const WAITING_FOR_PARTICIPANTS_FROM = ['scheduled'] as const;
export const IN_PROGRESS_FROM = ['scheduled', 'waiting_for_participants'] as const;
/** The complement of `endMeeting`'s exclusion CAS (`NOT IN ('ended','cancelled')`). */
export const END_MEETING_FROM = ['scheduled', 'waiting_for_participants', 'in_progress'] as const;

/** Throw unless EVERY declared `from` may legally reach `to`. See the block above. */
function assertEveryEdgeLegal(
  from: readonly MeetingLifecycleStatus[],
  to: MeetingLifecycleStatus
): void {
  for (const status of from) {
    assertMeetingTransition(status, to);
  }
}

/**
 * Thrown by `create` when the `contexts` array is empty.
 *
 * "Every meeting has ≥1 context row" CANNOT be a DB constraint (it needs a deferrable
 * constraint or a trigger — out of scope), so it is enforced at the SINGLE write path.
 */
export class MeetingContextRequiredError extends Error {
  constructor() {
    super('A meeting requires at least one context (decision B / ADR-1045 §2)');
    this.name = 'MeetingContextRequiredError';
  }
}

/**
 * Thrown by `cancel` when the meeting is not in a cancellable state — already cancelled,
 * already started or ended, soft-deleted, or simply not there. A NAMED error so BAL-410's
 * route branches on a type rather than string-matching.
 */
export class MeetingNotCancellableError extends Error {
  constructor(public readonly meetingId: string) {
    super(`Meeting ${meetingId} is not cancellable (must be live and status='scheduled')`);
    this.name = 'MeetingNotCancellableError';
  }
}

/**
 * Thrown by `updateSchedule` when the meeting is not in a reschedulable state — cancelled,
 * in progress, ended, soft-deleted, or simply not there. A NAMED error so BAL-409/BAL-411's
 * routes branch on a type rather than string-matching.
 *
 * The cancelled case is the load-bearing one: rescheduling a cancelled meeting used to
 * succeed and produce a live meeting whose projection stayed `cancelled` — a booking that
 * blocked nobody, invisible to `findProjectionDrift`. See `updateSchedule`'s docblock.
 */
export class MeetingNotReschedulableError extends Error {
  constructor(public readonly meetingId: string) {
    super(
      `Meeting ${meetingId} is not reschedulable (must be live and status='scheduled' or 'waiting_for_participants')`
    );
    this.name = 'MeetingNotReschedulableError';
  }
}

/**
 * BAL-134 — the lifecycle sweep's candidate scan (§4.3).
 *
 * `statuses` is the CALLER'S, not a hard-coded set: the sweep passes the three non-terminal
 * labels, and a test may pass one. See `meetingStatusEnum`'s reader-sweep list for what a new
 * label owes this method.
 */
export interface ListLifecycleCandidatesInput {
  statuses: readonly MeetingStatus[];
  /**
   * A LOOKBACK FLOOR — never scan all history. Production passes `now − 24h`; anything older
   * is a data-repair problem, not a live meeting.
   */
  scheduledStartAfter: Date;
  /** Hard batch bound. ⚠ The CALLER must `log.warn` when the batch FILLS (no silent caps). */
  limit: number;
}

/** BAL-134 — the terminal transition's input (§4.3). */
export interface EndMeetingInput {
  id: string;
  /**
   * WHY it ended, or NULL. ⚠ NULL IS A REAL, CORRECT VALUE, NOT "unknown" (D5): the two HUMAN
   * paths and the abandoned-wait path deliberately leave it unset — "the ender never sets the
   * outcome" (ADR-1049); BAL-412 resolves it from `meeting_presence`. Only the three system
   * paths that are DEFINED by their outcome (`completed` / `no_show_client` / `missed_call`)
   * pass one.
   */
  outcome: MeetingOutcome | null;
  /** WHO ended it. Required on EVERY path — unlike `outcome`, this is never unknown. */
  endedBy: MeetingEndedBy;
  /** The authoritative end instant. Becomes `meetings.ended_at` AND the presence ceiling. */
  endedAt: Date;
  /**
   * The acting human, or NULL for the four system paths (the ADR-1030 system-actor
   * exemption — an unattributed row, never a fabricated actor).
   */
  actorUserId: string | null;
}

/** BAL-134 — what `endMeeting` returns when it actually terminated the meeting. */
export interface EndMeetingResult {
  meeting: Meeting;
  /**
   * How many open presence intervals this termination closed. Surfaced (not swallowed)
   * because it is the caller's analytics input and its own health signal: a large count means
   * a lot of `participant.left` webhooks were dropped.
   */
  closedIntervals: number;
}

/**
 * Internal control signal — the meeting was ALREADY terminal, so `endMeeting`'s transaction
 * must roll back and the method must answer `undefined`. Never escapes the repository.
 *
 * ⚠ WHY A THROW RATHER THAN AN EARLY RETURN. The presence close runs BEFORE the status
 * compare-and-set (the R5 ordering, preserved), so by the time the CAS reports "already
 * terminal" this transaction may already have closed intervals. Returning at that point would
 * COMMIT those closures on a call that is meant to be a pure no-op (D10: the losing ender gets
 * an idempotent `200` with no second effect, no second audit row, no second teardown).
 * Throwing rolls the whole thing back, so "returned undefined" and "changed nothing" become
 * the same statement — which is the only contract a caller can safely retry against.
 */
class MeetingAlreadyTerminalSignal extends Error {
  constructor() {
    super('meeting already terminal');
    this.name = 'MeetingAlreadyTerminalSignal';
  }
}

/** One context attachment. `contextId` is NULL only for `'admin'` (the DB CHECK enforces it). */
export interface MeetingContextInput {
  contextType: MeetingContextType;
  contextId: string | null;
}

export interface CreateMeetingInput {
  scheduledStart: Date;
  scheduledEnd: Date;
  /** ≥1 required — the "every meeting has a context row" invariant (decision B). */
  contexts: MeetingContextInput[];
  dailyRoomName?: string | null;
  joinUrl?: string | null;
  /**
   * The human who booked, written into the `meeting.booked` audit row in the SAME transaction
   * (ADR-1044 §5 → ADR-1030: "state change and audit event in the same transaction").
   *
   * OPTIONAL and NULLABLE. An omitted/`null` value is the ADR-1030 SYSTEM-ACTOR ATTRIBUTION
   * EXEMPTION — an unattributed row, never a fabricated actor — and the dev seeder
   * (`services/seed/seed-service.ts`) relies on it, exactly as it already does for
   * `caseEngagementsRepository.create`. The production booking surface (`POST /meetings` →
   * `bookAndProvisionMeeting`) passes the authenticated user.
   */
  actorUserId?: string | null;
  /**
   * BAL-400 — the BOOKING-LEVEL idempotency key (a lowercase 64-char sha256 hex digest,
   * hashed SERVER-SIDE from the actor id and a stable client nonce). Written to
   * `meetings.booking_idempotency_key`, whose partial unique makes a second meeting for the
   * same submit impossible.
   *
   * OPTIONAL and NULLABLE. The dev seeder and the three non-`case` booking paths pass
   * none, and `POST /meetings` keeps accepting requests without one.
   *
   * ⚠ THE CALLER OWNS THE COLLISION. `create` does NOT use `ON CONFLICT` — the arbiter is a
   * PARTIAL index, so a Drizzle `eq()` predicate there fails 42P10 at runtime (memory
   * `reference_pg_partial_index_arbiter_param_42p10`), and swallowing the conflict would
   * silently hand back a meeting the caller never inspected. A concurrent duplicate raises
   * a bare `23505` on `meeting_booking_idempotency_key_idx`; the booking service catches it
   * and re-reads via {@link meetingsRepository.findByBookingIdempotencyKey}.
   *
   * ⚠ A malformed key (anything that is not lowercase 64-hex) fails 23514 on
   * `meeting_booking_idempotency_key_format` rather than being stored. That is the backstop
   * against a caller forwarding a RAW CLIENT NONCE, which would turn the lookup into an
   * IDOR — see the column docblock.
   */
  bookingIdempotencyKey?: string | null;
}

export interface MeetingWithContexts {
  meeting: Meeting;
  contexts: MeetingContext[];
}

/**
 * The return shape of EVERY mutator that can move an expert's availability (BAL-428).
 *
 * ⚠ `expertProfileId` IS PART OF THE RETURN TYPE ON PURPOSE, and the caller's obligation is
 * spelled out on `meetingsRepository` below: whoever mutates a meeting must rebuild that
 * expert's availability cache POST-COMMIT. Returning it means the caller cannot forget WHO
 * to rebuild for, and cannot get it wrong by re-deriving it.
 *
 * `null` means "nothing to rebuild" — an admin meeting, which projects no consultation row
 * and occupies nobody's calendar.
 */
export interface MeetingMutationResult {
  meeting: Meeting;
  expertProfileId: string | null;
}

/** `create`'s result: the meeting, its context rows, AND who was booked. */
export interface CreatedMeeting extends MeetingMutationResult {
  contexts: MeetingContext[];
}

/**
 * Re-assert `scheduled_start < scheduled_end` in-process. Shared by `create` and
 * `updateSchedule` so both entry points reject an inverted window with the SAME typed
 * error, rather than one raising a raw `23514` and the other a named one. The DB CHECK
 * `meeting_scheduled_start_before_end` is still the backstop.
 */
function assertScheduleOrder(scheduledStart: Date, scheduledEnd: Date): void {
  if (scheduledStart.getTime() >= scheduledEnd.getTime()) {
    throw new Error('Meeting scheduled_start must be before scheduled_end');
  }
}

/**
 * Patch ONE live meeting, stamping `updated_at`, and throw a named not-found error when
 * nothing live matches. Shared by every field-level mutator so the live-row guard and the
 * error text are defined exactly once.
 *
 * Takes an optional executor so a mutator that must also move the `consultations`
 * projection can run BOTH writes on the SAME transaction (BAL-428). Defaults to the base
 * client for the standalone mutators.
 */
async function updateLiveMeeting(
  id: string,
  set: Partial<NewMeeting>,
  exec: DbExecutor = db
): Promise<Meeting> {
  const [updated] = await exec
    .update(meetings)
    .set({ ...set, updatedAt: new Date() })
    .where(and(eq(meetings.id, id), isNull(meetings.deletedAt)))
    .returning();
  if (updated === undefined) {
    throw new Error(`Meeting not found: ${id}`);
  }
  return updated;
}

/**
 * `meetingsRepository` (BAL-418 / ADR-1045 §2) — the Meeting primitive's write + read
 * surface.
 *
 * ⚠ DELIBERATELY NO STATUS MUTATOR — WITH ONE EXCEPTION. `start()` / `end()` / the
 * transition map are **BAL-134's**, so the lifecycle is defined in exactly ONE place. The
 * exception is `cancel()`, added by BAL-428: cancelling is what FREES A BOOKED SLOT, so it
 * cannot live outside the module that owns the projection. Tests drive every other
 * non-`scheduled` state through `meetingFactory`'s `values` override (the
 * `transcript.factory` precedent).
 *
 * ⚠⚠ THE CALLER'S POST-COMMIT OBLIGATION (BAL-428) — READ THIS BEFORE WIRING THE FIRST
 * CALLER, in the same register as `caseEngagementsRepository.close()`'s BAL-390 contract.
 *
 * `create` / `updateSchedule` / `cancel` / `softDelete` all MOVE AN EXPERT'S AVAILABILITY,
 * because each writes the `consultations` projection the availability resolver subtracts
 * from. The cached `earliest_available_at` for that expert is stale the instant any of them
 * commits. This repository CANNOT refresh it: the rebuild runs on a BullMQ queue that lives
 * only in `apps/api`, and `@balo/db` depends on nothing that can reach a queue (the
 * `repositories-never-notify` invariant pins that). So EVERY caller MUST, POST-COMMIT,
 * enqueue an availability-cache rebuild for the `expertProfileId` these methods return.
 * That id is returned FOR THAT PURPOSE — `null` means there is nothing to rebuild.
 *
 * ⚠ A COROLLARY WORTH STATING PLAINLY: **a booking cannot be a pure web Server Action.**
 * The queue exists only in `apps/api`, so a `apps/web` action that called `create` directly
 * would commit a booking and leave every expert-facing surface advertising a slot that is
 * already taken. Booking goes through the API service layer.
 *
 * ⚠ AND THE INVERSE: none of these methods notifies. Booking confirmations are **BAL-400's**
 * (amended by BAL-129: it built `POST /meetings` and deliberately publishes NOTHING — the
 * route resolves a company and a context row, but `booking.confirmed`'s rules address
 * `recipient: 'expert'` and its templates need a name and a local time this route cannot
 * resolve). The `'booking.confirmed'` rule in `apps/api/src/notifications/engine/rules.ts`
 * is therefore a DOCUMENTED orphan — rules and templates with no publisher — and wiring it
 * is BAL-400's. Cancellations are BAL-410's, reschedules BAL-409/BAL-411's. Publishing from
 * here would fire on a dev seed run, since the seeder is a live caller of `create`/`cancel`.
 */
export const meetingsRepository = {
  /**
   * Insert the meeting, its context rows AND its `consultations` projection in ONE
   * transaction — a meeting can never exist without a context, even transiently, and
   * (BAL-428) a booked meeting can never exist without blocking its expert's calendar.
   * Throws `MeetingContextRequiredError` on an empty `contexts` array (before any write).
   *
   * THE EXPERT IS RESOLVED HERE, AT WRITE TIME, from the contexts (see
   * `_shared/consultation-projection.ts`). A booking that cannot name exactly one expert
   * throws — `MeetingExpertAmbiguousError`, `MatchModeDiscoveryNotBookableError`,
   * `MeetingContextUnresolvableError` or `MeetingContextNotProjectableError` (a label with
   * no projection rule yet, i.e. `request_interaction`) — and the WHOLE meeting rolls
   * back. An admin-only meeting resolves to `null`, writes no projection row, and blocks
   * nobody.
   *
   * `scheduledStart < scheduledEnd` is re-asserted in-process, MIRRORING `updateSchedule`,
   * so the SAME invariant surfaces as the SAME typed error from BOTH entry points rather
   * than a raw `23514` from one and a named error from the other. The CHECK
   * `meeting_scheduled_start_before_end` remains the backstop.
   *
   * ⚠ EMITS ONE `meeting.booked` AUDIT ROW ON THE SAME `tx` (BAL-129), so the booking and the
   * record of WHO MADE IT commit or roll back together — ADR-1030's rule, reasserted by
   * ADR-1044 §5 over this exact fan-out ("booking row … Daily room … state change and audit
   * event in the same transaction"). Before this, a committed booking was recorded in THREE
   * tables (`meetings`, `meeting_contexts`, `consultations`) and NONE of them named a person:
   * the route's `userId` reached only PostHog and the Pino/Axiom log, and `trackServer` is a
   * silent no-op without `POSTHOG_API_KEY`. The party stayed recoverable through
   * `meeting_contexts` → engagement → `company_id`; the individual did not.
   *
   * ⚠⚠ WHY AN AUDIT ROW SHIPS HERE AND AN ATTRIBUTION COLUMN **NEVER WILL** — the
   * ceiling/floor split, SETTLED. RESOLVED BY BAL-400 (architect Decision 8, ratified by the
   * owner as D5): **`meetings.booked_by_user_id` was deliberately NOT added, and this is the
   * record of that decision.** An earlier revision of this block told the next reader the
   * floor would ride BAL-400's idempotency-key migration. It did not. Do not finish the job.
   *
   * ADR-1030's floor for a money-or-authority action is a DURABLE ATTRIBUTION COLUMN on the
   * row itself (`credit_ledger.member_id`); its ceiling is an `audit_events` row in the same
   * transaction. The ceiling was reachable without a migration because
   * `audit_events.action`/`entityType` are open TEXT ("the audit vocabulary is open-ended and
   * grows without a migration per event" — `schema/audit-events.ts`), and it SHIPS, right
   * here, at `recordMeetingBooked` below. That is what discharges the ADR requirement; the
   * BAL-400 ticket concedes as much in writing.
   *
   * The floor was rejected for three reasons, in descending order of weight:
   *
   *   1. **IT COSTS A SHIPPED STRUCTURAL INVARIANT.**
   *      `booked_by_user_id uuid ... -> users.id` fails THREE of the five assertions in
   *      `invariants/meetings-no-context-column.test.ts` (no column name ending `_id`;
   *      exactly one uuid column; ZERO foreign keys). The third is the naming-independent
   *      one that actually holds the line, and the FIRST exception is the expensive one — it
   *      converts "`meetings` declares no FK, full stop" into "`meetings` declares the FKs on
   *      this list", and every later request inherits a worked precedent. `meetings` is the
   *      ROOT of this subgraph: `meeting_contexts` and `meeting_presence` point AT it and
   *      nothing points out. This would have been the first outbound edge, permanently.
   *   2. **NOTHING READS IT.** No shipped or in-scope consumer asks "who booked this meeting"
   *      off `meetings`. Cancel authorization is on the ADR-1046 ENGAGEMENT axis (delivery
   *      identity, `hasEngagementCapability`), not on "did you book it".
   *   3. The house rule quoted at `schema/meeting-presence.ts` — "an attribution column with
   *      no writer is a worse lie than its absence" — is a rule against HALF-MEASURES:
   *      column-and-writer-together, or not at all. "Not at all" is a legal reading of it,
   *      and the audit row means the fact is not lost either way.
   *
   * ⚠ IF THE FLOOR IS EVER GENUINELY WANTED it is a STRUCTURAL change reviewed on its own
   * merits: amend ADR-1045 §2 in the Notion Decision Register FIRST, then edit the invariant
   * with a written justification (exact-match and closed-world — a regex or prefix allow-list
   * re-opens the rename escape the invariant's own comments describe). Never a carve-out
   * smuggled into a feature PR.
   *
   * ⚠ WHAT BAL-400 DID ADD to this table is `booking_idempotency_key` — `text`, no `_id`
   * suffix, no `.references(` — which passes all five assertions by construction. See
   * {@link CreateMeetingInput.bookingIdempotencyKey}.
   *
   * The surviving half of BAL-129 D12 is its FOURTH acceptance criterion, and it is the real
   * substance: EVERY booking entry point must thread the authenticated user into
   * `actorUserId`. An omitted actor records NULL (the ADR-1030 system-actor exemption), never
   * a fabricated one — asserted in `meetings.integration.test.ts`.
   */
  async create(input: CreateMeetingInput): Promise<CreatedMeeting> {
    if (input.contexts.length === 0) {
      throw new MeetingContextRequiredError();
    }
    assertScheduleOrder(input.scheduledStart, input.scheduledEnd);

    return db.transaction(async (tx) => {
      const [meeting] = await tx
        .insert(meetings)
        .values({
          scheduledStart: input.scheduledStart,
          scheduledEnd: input.scheduledEnd,
          dailyRoomName: input.dailyRoomName ?? null,
          joinUrl: input.joinUrl ?? null,
          bookingIdempotencyKey: input.bookingIdempotencyKey ?? null,
        })
        .returning();
      if (meeting === undefined) {
        throw new Error('Failed to insert meeting');
      }

      const contexts = await tx
        .insert(meetingContexts)
        .values(
          input.contexts.map((context) => ({
            meetingId: meeting.id,
            contextType: context.contextType,
            contextId: context.contextId,
          }))
        )
        .returning();
      if (contexts.length !== input.contexts.length) {
        throw new Error(`Failed to attach contexts to meeting: ${meeting.id}`);
      }

      const expertProfileId = await projectNewMeetingTx(tx, meeting, input.contexts);

      // LAST, and on `tx` — never the base `db`. Written after the projection because
      // `expertProfileId` (whose calendar this booking blocked) is resolved there and is not
      // re-derivable later. Passing `db` here would leave an audit row behind after a
      // rolled-back booking, which is worse than no row: it would attest to a booking that
      // never existed.
      await recordMeetingBooked(tx, {
        meetingId: meeting.id,
        actorUserId: input.actorUserId ?? null,
        contexts: input.contexts,
        scheduledStart: meeting.scheduledStart,
        scheduledEnd: meeting.scheduledEnd,
        expertProfileId,
      });

      return { meeting, contexts, expertProfileId };
    });
  },

  /** ONE live meeting by id. `undefined` when missing or soft-deleted. */
  async findById(id: string): Promise<Meeting | undefined> {
    const [row] = await db
      .select()
      .from(meetings)
      .where(and(eq(meetings.id, id), isNull(meetings.deletedAt)))
      .limit(1);
    return row;
  },

  /**
   * ONE live meeting plus its live context rows — "what is this meeting, and what is it
   * FOR". `undefined` when the meeting is missing or soft-deleted.
   */
  async findWithContexts(id: string): Promise<MeetingWithContexts | undefined> {
    const meeting = await this.findById(id);
    if (meeting === undefined) {
      return undefined;
    }
    const contexts = await db
      .select()
      .from(meetingContexts)
      .where(and(eq(meetingContexts.meetingId, meeting.id), isNull(meetingContexts.deletedAt)));
    return { meeting, contexts };
  },

  /**
   * BAL-400 — THE IDEMPOTENT-REPLAY LOOKUP. The one live meeting booked under this
   * booking key, or `undefined`. Rides `meeting_booking_idempotency_key_idx`.
   *
   * ⚠⚠ ACTOR-SCOPED BY CONSTRUCTION, AND THAT IS WHY THIS TAKES NO `userId`. The stored key
   * is `sha256(userId:nonce)`, hashed SERVER-SIDE, so a key that resolves to a meeting can
   * only have been minted by that meeting's booker — cross-user collision is not merely
   * unlikely, it is unreachable. A RAW CLIENT-SUPPLIED KEY WOULD MAKE THIS AN IDOR: a
   * stranger replaying someone else's key would be handed their meeting. If a future caller
   * ever wants to key this on something the client chooses, it must add an ownership check
   * here in the same change — or, better, keep the derivation and change nothing.
   *
   * LIVE ROWS ONLY (`deleted_at IS NULL`), matching the index predicate, so a soft-deleted
   * meeting neither answers a replay nor blocks re-booking under the same key.
   *
   * ⚠ THIS IS THE **MEETING** GRAIN ONLY. A booking is two non-atomic hops, and after a
   * case-created / meeting-failed partial there is no `meetings` row at all — the retry's
   * first question ("has a case already been created?") is answered by
   * `caseEngagementsRepository.findByBookingIdempotencyKey`, not here.
   */
  async findByBookingIdempotencyKey(key: string): Promise<Meeting | undefined> {
    const [row] = await db
      .select()
      .from(meetings)
      .where(and(eq(meetings.bookingIdempotencyKey, key), isNull(meetings.deletedAt)))
      .limit(1);
    return row;
  },

  /**
   * BAL-129/BAL-131 webhook resolution — a Daily room resolves to exactly ONE live
   * meeting. Rides `meeting_daily_room_name_idx`.
   */
  async findByDailyRoomName(dailyRoomName: string): Promise<Meeting | undefined> {
    const [row] = await db
      .select()
      .from(meetings)
      .where(and(eq(meetings.dailyRoomName, dailyRoomName), isNull(meetings.deletedAt)))
      .limit(1);
    return row;
  },

  /**
   * BAL-129 PROVISIONING SEAM — stamp the Daily room + join url once the room exists.
   * BAL-418 ships the seam; BAL-129 is the only caller that will ever exist.
   */
  async setVenue(id: string, venue: { dailyRoomName: string; joinUrl: string }): Promise<Meeting> {
    return updateLiveMeeting(id, {
      dailyRoomName: venue.dailyRoomName,
      joinUrl: venue.joinUrl,
    });
  },

  /**
   * BAL-409 RESCHEDULE SEAM. Moves the meeting AND its projection in ONE transaction, so
   * the old window is never free-and-booked or booked-and-free between two commits.
   * Re-asserts `start < end` in-process so the caller gets a named error rather than a raw
   * `23514` from `meeting_scheduled_start_before_end` (which remains the backstop).
   *
   * ⚠ RETURNS `MeetingMutationResult`, NOT `Meeting` (changed by BAL-428) — the caller
   * needs the `expertProfileId` to rebuild the availability cache post-commit. That expert
   * is read from the LIVE PROJECTION ROW, never re-resolved from the contexts; see
   * `syncProjectionScheduleTx` for why re-resolving would be a silent repoint.
   *
   * ⚠ THE GUARD SETS HERE AND ON `cancel()` ARE NOT THE SAME, AND THAT ASYMMETRY IS
   * UNDECIDED — NOT A RULING. `cancel()` allows `scheduled` ONLY; this allows `scheduled`
   * AND `waiting_for_participants`. So once the Daily room opens, a meeting can be MOVED but
   * not CANCELLED. Two consequences a route author will meet before anyone else does:
   *   · rescheduling a `waiting_for_participants` meeting into next week leaves it AT
   *     `waiting_for_participants` with a future window. ⚠ BAL-134 HAS NOW LANDED AND STILL
   *     DOES NOT CLOSE THIS (D12): the `waiting_for_participants → scheduled` back-edge is
   *     DECLARED LEGAL in its transition map but deliberately NOT implemented, because
   *     deciding what happens to the presence rows from the pre-reschedule attempt is a
   *     BILLING question (BAL-412's) on a route BAL-409/BAL-411 own. What BAL-134 did do is
   *     make the stale status INERT: every one of its five terminal rules carries an explicit
   *     wall-clock precondition anchored on `scheduled_start`, so a meeting rescheduled into
   *     the future matches NO rule. Without that guard an expert with an open interval across
   *     the move would have `expertPresentMs` grow to `now` and trip the no-show rule on a
   *     call that has not happened yet;
   *   · if a participant had already joined, that meeting carries an open presence interval
   *     across the move (`meeting-presence.ts`'s `resolveClockCeiling` residual).
   * Each guard was written for its own reason — `cancel` narrow because cancelling is what
   * frees a slot, this one wider because a client may legitimately move a call in the minutes
   * before it starts — so the asymmetry is an ACCIDENT OF TWO LOCAL DECISIONS, not a product
   * position. **BAL-409/BAL-410/BAL-411 must settle it explicitly**: either widen `cancel` to
   * `waiting_for_participants` (and revisit the presence residual, which currently leans on
   * `cancel`'s narrowness), or narrow this one to `scheduled` and require cancel-then-rebook
   * once the room is open. Do not let the first route to land decide it by omission.
   *
   * ⚠⚠ GUARDED AT ALL FOR A SHARPER REASON THAN THE ABOVE. Without any status guard,
   * CANCEL-THEN-
   * RESCHEDULE REOPENS EXACTLY THE DOUBLE-BOOKING THIS TICKET CLOSES, in the one shape the
   * reconciliation read cannot see:
   *
   *   1. Book M for 09:00–10:00 → meeting `scheduled`, projection `confirmed`.
   *   2. `cancel(M)` → meeting `cancelled`, projection `cancelled`. Slot correctly freed.
   *   3. `updateSchedule(M, 14:00–15:00)` — `syncProjectionScheduleTx` moves `start_at` /
   *      `end_at` but DELIBERATELY never recomputes `status`, so the projection stays
   *      `cancelled` while the meeting is live at 14:00–15:00.
   *   4. `listConfirmedInRange` filters `status='confirmed'` and skips it ⇒ a LIVE MEETING
   *      THAT BLOCKS NOBODY. A second client books 14:00–15:00 and both commit.
   *   5. `findProjectionDrift` reports NOTHING: the two representations AGREE
   *      (`consultationStatusForMeeting('cancelled') === 'cancelled'`). The drift read built
   *      to catch "a booking that blocks nobody" is structurally blind to this one.
   *   6. Worse, `afterMeetingMutation` still gets a non-null `expertProfileId` and enqueues a
   *      rebuild — so the platform actively RE-ADVERTISES the slot as free.
   *
   * `ended` and `in_progress` are excluded for the same reason plus an independent one: a
   * delivered or running call must not be silently moved into the future.
   *
   * ⚠ IF RESCHEDULE-AFTER-CANCEL IS EVER MADE LEGAL (a "revive"), `syncProjectionScheduleTx`
   * MUST re-derive `status` from `meeting.status` in the same change, and `cancel()`'s guard
   * must be revisited. What must never exist again is the third state, where it half-works.
   *
   * ⚠ THE WALL-CLOCK RULE IS NOT HERE, matching `cancel()`: BAL-409/BAL-411's "how late may
   * you move it" policy belongs at the CALL SITE.
   */
  async updateSchedule(
    id: string,
    schedule: { scheduledStart: Date; scheduledEnd: Date }
  ): Promise<MeetingMutationResult> {
    assertScheduleOrder(schedule.scheduledStart, schedule.scheduledEnd);

    return db.transaction(async (tx) => {
      const [meeting] = await tx
        .update(meetings)
        .set({
          scheduledStart: schedule.scheduledStart,
          scheduledEnd: schedule.scheduledEnd,
          updatedAt: new Date(),
        })
        // Enum literals at QUERY time are always safe — the house restriction is on index
        // predicates and CHECKs, which is why 0059 adds neither for this label.
        .where(
          and(
            eq(meetings.id, id),
            inArray(meetings.status, ['scheduled', 'waiting_for_participants']),
            isNull(meetings.deletedAt)
          )
        )
        .returning();
      if (meeting === undefined) {
        throw new MeetingNotReschedulableError(id);
      }

      const expertProfileId = await syncProjectionScheduleTx(tx, meeting);
      return { meeting, expertProfileId };
    });
  },

  /**
   * BAL-410 CANCEL SEAM — THE ONLY THING THAT FREES A BOOKED SLOT. Flips the meeting to
   * `status='cancelled'` and its projection to `status='cancelled'` in ONE transaction, so
   * the resolver's `confirmed`-only filter re-opens the window at the same instant.
   *
   * GUARDED ON `status='scheduled' AND deleted_at IS NULL`, and throws
   * `MeetingNotCancellableError` otherwise: a meeting that already started, already ended,
   * or was already cancelled must not silently "cancel" again and re-fire whatever the
   * caller does post-commit.
   *
   * ⚠ THE WALL-CLOCK RULE IS NOT HERE. BAL-410's "free to cancel until the scheduled start"
   * policy stays at the CALL SITE, exactly as `caseEngagementsRepository.close()` leaves
   * capability checks to its caller. A repository that read the clock would make every
   * fixture and every backfill subject to a product policy that can change.
   */
  async cancel(id: string): Promise<MeetingMutationResult> {
    return db.transaction(async (tx) => {
      const now = new Date();
      const [meeting] = await tx
        .update(meetings)
        // Enum literals at QUERY time are always safe — the house restriction is on index
        // predicates and CHECKs, which is why 0059 adds neither for this label.
        .set({ status: 'cancelled', updatedAt: now })
        .where(
          and(eq(meetings.id, id), eq(meetings.status, 'scheduled'), isNull(meetings.deletedAt))
        )
        .returning();
      if (meeting === undefined) {
        throw new MeetingNotCancellableError(id);
      }

      const expertProfileId = await cancelProjectionTx(tx, id);
      return { meeting, expertProfileId };
    });
  },

  /**
   * Soft-delete a meeting, its context rows AND its `consultations` projection in ONE
   * transaction.
   *
   * ⚠ RETURNS `MeetingMutationResult`, NOT `void` (changed by BAL-428), and now THROWS
   * `Meeting not found` when nothing live matches instead of being a silent no-op. Both
   * changes exist for the same reason: deleting a meeting frees a slot, so the caller must
   * learn WHOSE availability to rebuild, and must not be told "done" when nothing happened.
   *
   * ⚠ THE PROJECTION MUST BE STAMPED TOO (BAL-428). `consultations_meeting_uq` is partial
   * on `deleted_at IS NULL`, so leaving the projection live would both keep a deleted
   * meeting occupying the expert's calendar forever AND block re-projecting that meeting id.
   *
   * ⚠ WHY THE CHILDREN MUST BE STAMPED TOO — READ THIS BEFORE "SIMPLIFYING" THE
   * TRANSACTION AWAY. It is NOT (as an earlier draft of this comment claimed) that live
   * orphans would block re-attaching the context to a DIFFERENT meeting: they could not.
   * `meeting_context_unique_idx` is on the TRIPLE `(meeting_id, context_type, context_id)`,
   * so a row left behind on meeting A never conflicts with the same context on meeting B.
   * That reasoning was false; the behaviour is still required, for two REAL reasons:
   *
   *   1. CORRECTNESS OF THE READS. `listByMeeting` and `listMeetingsForContext` filter
   *      `meeting_contexts.deleted_at IS NULL` independently of the parent. Leaving the
   *      children live keeps a soft-deleted meeting's context rows visible — an engagement
   *      would keep reporting a context row pointing at a meeting nobody can load.
   *   2. RE-ATTACHING TO THE **SAME** MEETING WOULD SILENTLY RETURN A STALE ROW. This is
   *      the case the triple index really does block — but it does NOT surface as `23505`
   *      through the seam (an earlier draft of this comment claimed it did). Probed on
   *      Postgres 16: `attach` carries `onConflictDoNothing` with an arbiter matching
   *      `meeting_context_unique_idx`, so the INSERT reports `INSERT 0 0` and returns no
   *      row; `attach`'s follow-up SELECT (filtered `deleted_at IS NULL`) then finds the
   *      live orphan sitting on the soft-deleted meeting and hands THAT back, as though a
   *      fresh attachment had just succeeded. `23505` only escapes from a bare insert with
   *      no arbiter. So the failure is not a loud error the caller can branch on — it is a
   *      resurrected row pointing at a meeting nobody can load.
   */
  async softDelete(id: string): Promise<MeetingMutationResult> {
    return db.transaction(async (tx) => {
      const now = new Date();
      const meeting = await updateLiveMeeting(id, { deletedAt: now }, tx);
      await tx
        .update(meetingContexts)
        .set({ deletedAt: now, updatedAt: now })
        .where(and(eq(meetingContexts.meetingId, id), isNull(meetingContexts.deletedAt)));
      const expertProfileId = await softDeleteProjectionTx(tx, id, now);
      return { meeting, expertProfileId };
    });
  },

  // ── BAL-134 / ADR-1049 — THE LIFECYCLE TRANSITIONS ────────────────────────────────────
  //
  // The "DELIBERATELY NO STATUS MUTATOR" note at the top of this repository named BAL-134 as
  // the owner of `start()` / `end()` / the transition map. This is that block, and it holds
  // the ONLY status mutators besides `cancel()`.
  //
  // ⚠⚠ EVERY ONE OF THEM IS A COMPARE-AND-SET, AND NONE OF THEM THROWS ON A LOST RACE. The
  // writers are a per-minute sweep, a Daily webhook and a user-pressed button, all of which
  // can fire at the same instant on the same meeting. `undefined` means "somebody else got
  // there first, and the meeting is not in the state you assumed" — a NORMAL outcome that the
  // caller maps to a no-op, never an error. Throwing would turn a routine race into a
  // user-facing failure on the one control that must always work.
  //
  // ⚠ AND NONE OF THEM WRITES THE `consultations` PROJECTION OR REBUILDS AVAILABILITY, unlike
  // `create`/`updateSchedule`/`cancel`/`softDelete` above. That is CORRECT and deliberate,
  // not an omission: `consultationStatusForMeeting` maps every non-`cancelled` label to
  // `confirmed`, so an `ended` meeting KEEPS occupying the expert's calendar slot — the booked
  // window was consumed, and re-advertising it as free would be the bug. A reviewer will
  // otherwise read the absence as a miss.

  /**
   * BAL-134 — the lifecycle sweep's candidate scan (§4.3). Live, non-terminal meetings whose
   * scheduled start is recent enough to still be actionable, OLDEST FIRST.
   *
   * Rides `meeting_status_scheduled_start_idx` — the index whose own docblock says "BAL-134's
   * starting-soon scans" — because the predicate leads with `status` and then ranges on
   * `scheduled_start`, in that column order, under the index's `deleted_at IS NULL` predicate.
   *
   * ⚠ THE FLOOR AND THE LIMIT ARE BOTH REQUIRED, AND NEITHER HAS A DEFAULT. A sweep that runs
   * every minute forever would otherwise scan an ever-growing tail of meetings nothing will
   * ever terminate, and one bad row would grow the batch without bound. Requiring both makes
   * the bound a decision the caller states out loud.
   *
   * ⚠ **THE CALLER MUST `log.warn` WHEN THE RESULT LENGTH EQUALS `limit`** — the no-silent-caps
   * rule. A full batch means meetings were DROPPED from this tick, and the sweep is the only
   * layer that can say so (`@balo/db` has no business logging a business event). Ordering is
   * ascending so that warning can name the oldest `scheduled_start` it did reach.
   *
   * An empty `statuses` array returns `[]` without a query — drizzle would render `inArray(x,
   * [])` as a false predicate anyway, but an explicit short-circuit says so rather than
   * relying on that.
   */
  async listLifecycleCandidates(input: ListLifecycleCandidatesInput): Promise<Meeting[]> {
    if (input.statuses.length === 0 || input.limit <= 0) {
      return [];
    }

    return db
      .select()
      .from(meetings)
      .where(
        and(
          // Enum literals at QUERY time are always safe — the house restriction is on index
          // predicates and CHECKs.
          inArray(meetings.status, [...input.statuses]),
          gte(meetings.scheduledStart, input.scheduledStartAfter),
          isNull(meetings.deletedAt)
        )
      )
      .orderBy(asc(meetings.scheduledStart), asc(meetings.id))
      .limit(input.limit);
  },

  /**
   * BAL-134 — `scheduled → waiting_for_participants`, on the FIRST presence interval opening
   * for a meeting (any party). Compare-and-set from `scheduled`.
   *
   * Returns `undefined` when the meeting is not `scheduled` — which is the COMMON case, not an
   * error: the second, third and fourth participants to join all reach this method with the
   * meeting already moved, and two Daily webhooks racing on the first join both call it. Both
   * read as "no transition needed".
   *
   * Stamps NOTHING but `status`. `started_at` belongs to `in_progress` (it means "the
   * consultation began", not "somebody opened the door"), and `ended_at` to the terminal
   * transition.
   */
  async markWaitingForParticipants(id: string): Promise<Meeting | undefined> {
    assertEveryEdgeLegal(WAITING_FOR_PARTICIPANTS_FROM, 'waiting_for_participants');
    const [meeting] = await db
      .update(meetings)
      .set({ status: 'waiting_for_participants', updatedAt: new Date() })
      .where(
        and(
          eq(meetings.id, id),
          inArray(meetings.status, [...WAITING_FOR_PARTICIPANTS_FROM]),
          isNull(meetings.deletedAt)
        )
      )
      .returning();
    return meeting;
  },

  /**
   * BAL-134 — `(scheduled | waiting_for_participants) → in_progress`, stamping `started_at`,
   * when the expert AND at least one client-side participant are both present.
   *
   * `scheduled` is in the CAS set on purpose: a same-instant double-join can take a meeting
   * from `scheduled` straight to `in_progress` without ever being observed as
   * `waiting_for_participants` (§4.1 declares that edge). Requiring the intermediate state
   * would leave such a meeting stuck at `scheduled` — and therefore matched by the MISSED-CALL
   * rule, which would end a call that is actually running.
   *
   * ⚠ `started_at` CANNOT BE OVERWRITTEN BY A LATER CALL, and the CAS is what guarantees it:
   * `in_progress` is not in the FROM set, so the second caller matches zero rows. Every clock
   * anchored on `started_at` is therefore stable across a rejoin — the same "spans, not sums"
   * property `meeting_presence` is built on.
   */
  async markInProgress(id: string, startedAt: Date): Promise<Meeting | undefined> {
    assertEveryEdgeLegal(IN_PROGRESS_FROM, 'in_progress');
    const [meeting] = await db
      .update(meetings)
      .set({ status: 'in_progress', startedAt, updatedAt: new Date() })
      .where(
        and(
          eq(meetings.id, id),
          inArray(meetings.status, [...IN_PROGRESS_FROM]),
          isNull(meetings.deletedAt)
        )
      )
      .returning();
    return meeting;
  },

  /**
   * BAL-134 / ADR-1049 — THE TERMINAL TRANSITION. All five paths (human end, idle end,
   * no-show, missed call, abandoned wait) land here; they differ only in `outcome`, `endedBy`
   * and `actorUserId`.
   *
   * ONE `db.transaction`, in this order (§4.3):
   *
   *   1. `meetingPresenceRepository.closeAllOpen(id, endedAt, tx)` — presence closed FIRST,
   *      clamped to `endedAt`;
   *   2. the compare-and-set on `meetings`;
   *   3. the `meeting.ended` audit row, on the same `tx` (ADR-1030's ceiling — `action` and
   *      `entity_type` are open TEXT, so this costs no migration).
   *
   * ⚠⚠ STEP 2 IS **ONE** `UPDATE`, AND THAT IS THE WHOLE POINT OF THIS METHOD.
   * `status='ended'`, `ended_at`, `ended_by` and `outcome` are set TOGETHER, in a single
   * statement. `meetingPresenceRepository.resolveClockCeiling` prefers `meetings.ended_at`
   * over the wall clock for a terminal meeting, and its docblock states the requirement
   * verbatim: **"BAL-134 must stamp `ended_at` in the SAME statement that sets
   * `status='ended'`"**. Split into two statements, a reader landing between them sees an
   * `ended` meeting with a NULL `ended_at`, falls back to the wall clock, and measures every
   * still-open interval to *now* — the 16-hour over-bill that repository pins as a test.
   * Combined with step 1 there is no such interval left anyway; the two guards are
   * independent on purpose.
   *
   * ⚠ THE CAS IS AN **EXCLUSION** (`status NOT IN ('ended','cancelled')`), NOT AN INCLUSION —
   * the one method in this file written that way. Every non-terminal state is endable,
   * including `scheduled` (that is the missed-call path: nobody ever joined). A new terminal
   * `meeting_status` label MUST be added to this exclusion or `endMeeting` will happily re-end
   * a meeting already in it; `meetingStatusEnum`'s reader-sweep list says so too.
   *
   * Returns `undefined` when the CAS matches nothing — already `ended`, already `cancelled`,
   * soft-deleted, or gone — **having changed nothing at all** (the transaction rolls back; see
   * `MeetingAlreadyTerminalSignal`). That is D10: two `canEndMeeting` holders can press End
   * simultaneously, and the loser gets an idempotent success rather than a `409` surfaced as an
   * error on the one control that must always work.
   *
   * ⚠ NO DAILY TEARDOWN AND NO ANALYTICS HERE. Deleting the room is a VENDOR call and belongs
   * to the service layer (`@balo/db` reaches no network, exactly as `repositories-never-notify`
   * pins for the queue). This method makes the meeting terminal in Postgres; the caller makes
   * the room unreachable at Daily and emits `meeting_ended`.
   */
  async endMeeting(input: EndMeetingInput): Promise<EndMeetingResult | undefined> {
    // ⚠ OUTSIDE THE TRANSACTION — pure, and a writer-bug throw must not open one.
    assertEveryEdgeLegal(END_MEETING_FROM, 'ended');
    try {
      return await db.transaction(async (tx) => {
        const closedIntervals = await meetingPresenceRepository.closeAllOpen(
          input.id,
          input.endedAt,
          tx
        );

        const [meeting] = await tx
          .update(meetings)
          .set({
            status: 'ended',
            endedAt: input.endedAt,
            endedBy: input.endedBy,
            outcome: input.outcome,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(meetings.id, input.id),
              // Enum literals at QUERY time are always safe — the house restriction is on
              // index predicates and CHECKs.
              notInArray(meetings.status, ['ended', 'cancelled']),
              isNull(meetings.deletedAt)
            )
          )
          .returning();

        if (meeting === undefined) {
          throw new MeetingAlreadyTerminalSignal();
        }

        // LAST, and on `tx` — an audit row left behind by a rolled-back termination would
        // attest to an end that never happened.
        await recordMeetingAudit(tx, {
          actorUserId: input.actorUserId,
          action: 'meeting.ended',
          meetingId: meeting.id,
          metadata: {
            endedBy: input.endedBy,
            outcome: input.outcome,
            closedIntervals,
            // ⚠ ISO STRING, NOT `Date` — `metadata` is `jsonb`, so a `Date` round-trips as a
            // string and typing it otherwise would be a lie on the way back out (memory
            // `reference_jsonb_date_type_lie`). The same conversion `recordMeetingBooked` does.
            endedAt: input.endedAt.toISOString(),
          },
        });

        return { meeting, closedIntervals };
      });
    } catch (error) {
      if (error instanceof MeetingAlreadyTerminalSignal) {
        return undefined;
      }
      throw error;
    }
  },

  /**
   * BAL-412 — write `meetings.outcome` on an ALREADY-ENDED meeting, ONCE, TX-COMPOSABLE.
   *
   * BAL-134 deliberately leaves `outcome` NULL on the two HUMAN end paths and on the
   * abandoned wait (ADR-1049 D5: "the ender never sets the outcome — BAL-412 resolves it from
   * `meeting_presence`"). This is that resolution's write seam. The three system paths DEFINED
   * by their outcome (`completed` / `no_show_client` / `missed_call`) already carry one from
   * the sweep, and settlement re-derives the same label — so this method must be able to
   * observe "already resolved" and do nothing, rather than overwrite it.
   *
   * ⚠⚠ `outcome IS NULL` IS IN THE **PREDICATE**, NOT AN ASSERTION, AND THAT IS THE WHOLE
   * DESIGN. A read-then-write ("is it null? then set it") is a TOCTOU on a row the lifecycle
   * sweep can be writing concurrently: the sweep's `missed_call` and a settlement running a
   * moment later would both observe NULL and the loser would overwrite the winner. As a
   * single conditional `UPDATE` the database decides, and `RETURNING` reports which way it
   * went. **FIRST WRITE WINS**, always.
   *
   * ⚠ `status = 'ended'` IS ALSO IN THE PREDICATE, so `meeting_outcome_requires_ended`
   * (`schema/meetings.ts`) cannot be violated even by a caller that skipped its own
   * precondition check. A CHECK violation here would raise a bare `23514` and roll back the
   * caller's WHOLE settlement transaction — the money, the ledger ticks and the audit rows
   * with it. Refusing in the predicate turns that into a `false` return.
   *
   * ⚠ TAKES AN EXECUTOR, AND THE CALLER MUST PASS ITS `tx`. The outcome, the money and the
   * audit row commit or roll back TOGETHER (ADR-1030). An outcome written outside the
   * settlement transaction would survive a rolled-back settlement and permanently block the
   * retry from writing the right label.
   *
   * Returns `true` when the row was written (and an audit row appended on the SAME executor),
   * `false` on every no-op: already resolved, not `ended`, soft-deleted, or gone. The CALLER
   * logs the `false` case — this repository does not log (`repositories-never-notify`'s
   * sibling rule); see the presence-settlement service.
   *
   * ⚠ INERT ON MAIN (decision D10) — its only caller is the presence settlement, which no
   * shipped path reaches (BAL-400 → BAL-466).
   */
  async setOutcomeIfUnset(
    exec: DbExecutor,
    input: { meetingId: string; outcome: MeetingOutcome; actorUserId: string | null }
  ): Promise<boolean> {
    const [row] = await exec
      .update(meetings)
      .set({ outcome: input.outcome, updatedAt: new Date() })
      .where(
        and(
          eq(meetings.id, input.meetingId),
          // Enum literals at QUERY time are always safe — the house restriction is index
          // predicates and CHECKs.
          eq(meetings.status, 'ended'),
          isNull(meetings.outcome),
          isNull(meetings.deletedAt)
        )
      )
      .returning({ id: meetings.id });

    if (row === undefined) {
      return false;
    }

    // ONLY on a real write, and on the SAME executor — an audit row beside a no-op would
    // attest to a resolution that did not happen.
    await recordMeetingAudit(exec, {
      actorUserId: input.actorUserId,
      action: 'meeting.outcome_resolved',
      meetingId: input.meetingId,
      metadata: { outcome: input.outcome },
    });
    return true;
  },
};

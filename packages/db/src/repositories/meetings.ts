import { and, asc, eq, gt, gte, inArray, isNull, lt, ne, notInArray } from 'drizzle-orm';
import {
  assertMeetingTransition,
  CANCELLABLE_MEETING_STATUSES,
  RESCHEDULABLE_MEETING_STATUSES,
  GUEST_TOKEN_TTL_AFTER_END_MS,
  selectPrimaryMeetingContext,
  type MeetingLifecycleStatus,
  type MeetingContextTypeWithHolder,
} from '@balo/shared/meetings';
import { db } from '../client';
import {
  meetings,
  meetingContexts,
  consultations,
  engagements,
  projectRequests,
  requestExpertRelationships,
  companies,
  type Meeting,
  type MeetingContext,
  type MeetingContextType,
  type MeetingEndedBy,
  type MeetingOutcome,
  type MeetingStatus,
  type NewMeeting,
} from '../schema';
import type { EngagementType } from './_shared/engagement-supertype';
import {
  cancelProjectionTx,
  projectNewMeetingTx,
  softDeleteProjectionTx,
  syncProjectionScheduleTx,
} from './_shared/consultation-projection';
import type { DbExecutor } from './_shared/db-executor';
import { extendGuestExpiryForMeetingTx } from './_shared/guest-expiry';
import {
  recordMeetingAudit,
  recordMeetingBooked,
  recordMeetingCancelled,
  recordMeetingRescheduled,
} from './_shared/meeting-audit';
import { meetingPresenceRepository } from './meeting-presence';
import { createLogger } from '@balo/shared/logging';

const logger = createLogger('meetings-repository');

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
    super(`Meeting ${meetingId} is not reschedulable (must be live and status='scheduled')`);
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
 * BAL-283 — ONE row of {@link meetingsRepository.listActiveMeetingsForContexts}: the minimum a
 * conversation surface needs to say "a call is booked on this thread, at this time".
 *
 * ⚠ DELIBERATELY NOT A `Meeting`. `meetings` carries `join_url` and `daily_room_name`, which
 * are call-JOIN CREDENTIALS (`schema/meeting-contexts.ts`'s tenancy obligation, consequence 1)
 * — and this read is fed a LIST of context ids from a page loader, so the blast radius of one
 * mis-scoped id is a whole request's worth of threads rather than one. A projection that
 * cannot carry a credential cannot leak one.
 */
export interface ContextMeetingSummary {
  meetingId: string;
  scheduledStart: Date;
  scheduledEnd: Date;
  status: MeetingStatus;
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
 * BAL-409 — `updateSchedule`'s result. Widens {@link MeetingMutationResult} with the pre-image
 * window (for the audit row and the API response) and how many guest links moved.
 */
export interface RescheduleMutationResult extends MeetingMutationResult {
  /** The window as it was BEFORE the move — read inside the same tx. */
  previous: { scheduledStart: Date; scheduledEnd: Date };
  /** How many live guest links moved. `0` on a move EARLIER — correct, not a bug. */
  guestLinksExtended: number;
  /**
   * The `meeting.rescheduled` audit row's id — UNIQUE PER SUCCESSFUL MOVE, because
   * `audit_events` is append-only.
   *
   * ⚠ THIS IS THE OUTBOUND FAN-OUT'S IDEMPOTENCY KEY, AND IT MUST NOT BE DERIVED FROM THE
   * WINDOW. Every window-derived key (`meetingId:start-end`, `meetingId:startIso`,
   * `guestId:startIso`) COLLIDES on a move BACK to a previously-used window — A→B→C→B
   * regenerates the key the A→B move already used. BullMQ silently no-ops an `add` whose
   * jobId exists in the RETAINED completed set (`removeOnComplete` keeps 1000 amend jobs and
   * 100 notification jobs), so the third move would drop the calendar amend AND both party
   * emails: Balo says B, the expert's real calendar stays on C, and nobody is told.
   * Keying on this id makes every successful move its own event.
   */
  rescheduleAuditId: string;
}

/**
 * BAL-410 — `cancel`'s result. Widens {@link MeetingMutationResult} with the audit row id the
 * post-commit unwind and the outbound `booking.cancelled` publish both key on.
 */
export interface CancelMutationResult extends MeetingMutationResult {
  /**
   * The `meeting.cancelled` audit row's id — UNIQUE PER SUCCESSFUL CANCEL, because
   * `audit_events` is append-only and the row is written inside the same transaction as the
   * status flip (so it exists at most once per cancel, never on a rolled-back one).
   *
   * ⚠ THE OUTBOUND FAN-OUT'S IDEMPOTENCY KEY, PER **WRITE** AND NEVER PER **STATE** — the same
   * rule `rescheduleAuditId` states above, and it bites here for a subtler reason. A cancel has
   * NO destination window to key on, so the only state-shaped key available is the bare
   * `meetingId`; BullMQ silently no-ops an `add` whose jobId is already in the retained
   * completed set, so a state-keyed cancel notification would be swallowed by any earlier
   * `meetingId`-keyed job for the same meeting. Keying on this id makes every cancel its own
   * event.
   */
  cancelAuditId: string;
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

/**
 * BAL-498 — one raw row from `listCalendarForExpert`'s step-1 query, and also the shape a
 * meeting is reduced to after step 2's fold. Same shape both before and after folding: a
 * pre-fold row is one (meeting, context) pair; a folded row is the winning pair.
 */
interface RawMeetingContextRow {
  meetingId: string;
  scheduledStart: Date;
  scheduledEnd: Date;
  status: MeetingStatus;
  /** The FULL label set pre-fold — a meeting's fanned-out rows can include `admin`.
   *  {@link selectPrimaryMeetingContext} is what narrows this to
   *  {@link MeetingContextTypeWithHolder} on the way out. */
  contextType: MeetingContextType;
  /** Nullable pre-fold — `admin` contexts carry a `null` `context_id`. Never null post-fold:
   *  {@link selectPrimaryMeetingContext} drops any candidate with a null id. */
  contextId: string | null;
}

const MS_PER_DAY = 86_400_000;

/**
 * BAL-498 fix round 3 (S2) — the widest range {@link meetingsRepository.listCalendarForExpert}
 * will serve. `?week=1000-01-01` passed every shape and calendar-date check the page had and
 * opened a thousand-year window on a read with no `LIMIT`.
 *
 * ⚠ SIZED AGAINST THE CALLER'S WIDEST SINGLE WINDOW — keep the two in step. Since BAL-513,
 * `load-expert-calendar.ts` issues TWO bounded reads rather than one stretched one: the visible
 * week (`WEEK_DAYS` = 7) and the Agenda horizon (`AGENDA_HORIZON_DAYS` = 28, anchored on today).
 * The widest legitimate request is therefore 28 days, ±1h of DST — NOT the ~399 days the old
 * `weekStart → max(weekStart+28, today+28)` clamp could produce, and no longer a function of the
 * page's ±365-day `?week=` bound at all. 35 is head-room over 28.
 *
 * ⚠ IT MAY NOT GO BELOW ~31. `meetings.integration.test.ts` shares an unnamed `RANGE` literal
 * spanning 30 days + 1 hour across 11 calls in the tenant-isolation and forged-polymorphic-context
 * SECURITY tests; anything at or under 30.04 makes every one of them throw. That literal is not to
 * be "tidied" to let a smaller constant fit.
 *
 * A future caller that forgets to bound still gets a thrown error — now for anything over about a
 * month, instead of over a year.
 */
export const MAX_CALENDAR_RANGE_DAYS = 35;

/** Hard row cap for the same read. Context rows, not meetings — see the call site. */
export const MAX_CALENDAR_ROWS = 2000;

/** Thrown, never truncated: a range this wide is a CALLER BUG, and silently returning a
 *  narrower answer would hide it behind a plausible-looking calendar. */
export class CalendarRangeTooWideError extends Error {
  constructor(rangeStart: Date, rangeEnd: Date) {
    super(
      `listCalendarForExpert: range ${rangeStart.toISOString()}..${rangeEnd.toISOString()} ` +
        `exceeds the maximum of ${MAX_CALENDAR_RANGE_DAYS} days`
    );
    this.name = 'CalendarRangeTooWideError';
  }
}

/** Thrown when the DEFAULT row cap is reached — see {@link assertCalendarRowCapNotExceeded}. */
export class CalendarTooManyRowsError extends Error {
  constructor(expertProfileId: string, rowLimit: number) {
    super(
      `listCalendarForExpert: expert ${expertProfileId} has at least ${rowLimit} context rows in ` +
        `the requested range, the maximum this read will serve`
    );
    this.name = 'CalendarTooManyRowsError';
  }
}

/**
 * BAL-498 fix round 4, item 3 — the DEFAULT row cap is FAIL-CLOSED, like the span check beside it,
 * because truncation here drops the WRONG END of the window.
 *
 * `.limit(n)` is applied after `orderBy(asc(scheduledStart))`, so an over-limit read discards the
 * LATEST rows. Since BAL-513, `load-expert-calendar.ts` issues this read over a single bounded
 * window at a time — the visible week (7 days) or the Agenda horizon (28 days, anchored on
 * today) — so reaching 2,000 context rows within a **28-day** window means a genuinely extreme
 * calendar, not a year-wide scan. Those discarded LATEST rows are still the far end of the
 * Agenda horizon — the days the expert most needs. An honest error (the route segment's
 * `error.tsx`, with a retry) still beats a plausible-looking calendar missing next week.
 *
 * ⚠ AN EXPLICIT `limit` IS EXEMPT and still truncates. Passing one is opting into a narrower
 * answer — no shipped caller does; only the integration tests, which pin the
 * {@link dropPossiblyTruncatedTrailingMeeting} fold-safety behaviour that must keep working.
 */
export function assertCalendarRowCapNotExceeded(args: {
  rowCount: number;
  rowLimit: number;
  /** `true` when the caller passed its own `limit`, i.e. deliberately asked to be truncated. */
  limitIsCallerSupplied: boolean;
  expertProfileId: string;
}): void {
  if (args.limitIsCallerSupplied) return;
  if (args.rowCount < args.rowLimit) return;
  throw new CalendarTooManyRowsError(args.expertProfileId, args.rowLimit);
}

/**
 * Drops the LAST meeting's rows when the row limit was actually reached, because that meeting's
 * fanned-out context set may have been sliced by the `LIMIT` — and a half context set folds to
 * the wrong precedence winner. A no-op below the limit, which is every real call.
 */
function dropPossiblyTruncatedTrailingMeeting(
  rows: readonly RawMeetingContextRow[],
  rowLimit: number,
  expertProfileId: string
): readonly RawMeetingContextRow[] {
  if (rows.length < rowLimit) return rows;
  const last = rows.at(-1);
  if (last === undefined) return rows;
  logger.warn(
    { expertProfileId, rowLimit, truncatedMeetingId: last.meetingId },
    'Expert calendar read hit its row limit; dropping the trailing (possibly truncated) meeting'
  );
  return rows.filter((row) => row.meetingId !== last.meetingId);
}

/** Post-fold: one row per meeting, its `contextId` narrowed to non-null by
 *  {@link selectPrimaryMeetingContext}. */
interface FoldedCalendarMeeting {
  meetingId: string;
  scheduledStart: Date;
  scheduledEnd: Date;
  status: MeetingStatus;
  contextType: MeetingContextTypeWithHolder;
  contextId: string;
}

/**
 * `listCalendarForExpert` step 2 — reduce each meeting's fanned-out context rows to ONE primary
 * context via {@link selectPrimaryMeetingContext}. Extracted as a named module-private helper
 * (SonarCloud `sonarjs/cognitive-complexity` gate on the un-extracted method was 34, allowed 15)
 * and exported so it is unit-testable without Docker (plan-bal-498.md § 12.1).
 */
export function foldMeetingContextRowsToPrimary(
  rows: readonly RawMeetingContextRow[],
  expertProfileId: string
): FoldedCalendarMeeting[] {
  const byMeeting = new Map<string, RawMeetingContextRow[]>();
  for (const row of rows) {
    const bucket = byMeeting.get(row.meetingId);
    if (bucket === undefined) {
      byMeeting.set(row.meetingId, [row]);
    } else {
      bucket.push(row);
    }
  }

  const folded: FoldedCalendarMeeting[] = [];
  for (const [meetingId, meetingRows] of byMeeting) {
    const [first] = meetingRows;
    if (first === undefined) {
      continue;
    }
    const primary = selectPrimaryMeetingContext(meetingRows);
    if (!primary.ok) {
      // BOTH reasons are logged, not just `'ambiguous'` (BAL-498 fix round 3, R9). A meeting
      // folding to `'none'` (every context row is `admin`, or carries a null `context_id`) still
      // OCCUPIES the expert's availability through `consultations`, yet vanishes from their
      // calendar — silently dropping it made that state unobservable, while this method's own
      // docblock promised "OMITTED, fail-closed, and logged" for both.
      logger.warn(
        { meetingId, expertProfileId, reason: primary.reason },
        'Meeting omitted from the expert calendar read: no usable primary context'
      );
      continue;
    }
    folded.push({
      meetingId,
      scheduledStart: first.scheduledStart,
      scheduledEnd: first.scheduledEnd,
      status: first.status,
      contextType: primary.context.contextType,
      contextId: primary.context.contextId,
    });
  }
  return folded;
}

export interface CalendarContextIdBuckets {
  readonly engagementIds: ReadonlySet<string>;
  readonly projectDiscoveryIds: ReadonlySet<string>;
  readonly requestInteractionIds: ReadonlySet<string>;
}

/**
 * `listCalendarForExpert` step 3a — classify each folded meeting's winning context by grain, so
 * step 3b can batch-load one query per non-empty bucket. Exhaustive `switch` with `const
 * unhandled: never` — an eighth `meeting_context_type` label fails `pnpm typecheck` here.
 */
export function classifyCalendarContextIds(
  folded: readonly FoldedCalendarMeeting[]
): CalendarContextIdBuckets {
  const engagementIds = new Set<string>();
  const projectDiscoveryIds = new Set<string>();
  const requestInteractionIds = new Set<string>();
  for (const meeting of folded) {
    switch (meeting.contextType) {
      case 'case':
      case 'project_kickoff':
      case 'package_session':
      case 'retainer_checkin':
        engagementIds.add(meeting.contextId);
        break;
      case 'project_discovery':
        projectDiscoveryIds.add(meeting.contextId);
        break;
      case 'request_interaction':
        requestInteractionIds.add(meeting.contextId);
        break;
      default: {
        const unhandled: never = meeting.contextType;
        throw new Error(`Unhandled meeting context type: ${String(unhandled)}`);
      }
    }
  }
  return { engagementIds, projectDiscoveryIds, requestInteractionIds };
}

interface EngagementGrainOwner {
  readonly id: string;
  readonly engagementType: EngagementType;
  readonly companyName: string;
}
interface ProjectDiscoveryOwner {
  readonly id: string;
  readonly companyName: string;
}
interface RequestInteractionOwner {
  readonly id: string;
  readonly projectRequestId: string;
  readonly companyName: string;
}

export interface CalendarOwnerLookups {
  readonly engagementById: ReadonlyMap<string, EngagementGrainOwner>;
  readonly projectDiscoveryById: ReadonlyMap<string, ProjectDiscoveryOwner>;
  readonly requestInteractionById: ReadonlyMap<string, RequestInteractionOwner>;
}

/**
 * `listCalendarForExpert` step 4 — resolve each folded meeting's counterparty from the batch-load
 * results and assemble the final `ExpertCalendarMeeting[]`. Mirrors the exhaustive `switch` from
 * {@link classifyCalendarContextIds} (rather than `includes()`/`else if`/`else`) so a seventh
 * holder-bearing label cannot silently fall into the `request_interaction` bucket.
 *
 * `owningRowFound` is surfaced on every row (not just logged) so the WEB LOADER can refuse to
 * render a link when the owning row could not be resolved — the SAME fail-closed discipline the
 * missing-row branch already applies to `counterpartyCompanyName`, now applied to `href` too
 * (security-bal-498.md MEDIUM finding).
 */
export function assembleCalendarMeetings(
  folded: readonly FoldedCalendarMeeting[],
  owners: CalendarOwnerLookups,
  expertProfileId: string
): ExpertCalendarMeeting[] {
  const result: ExpertCalendarMeeting[] = [];
  for (const meeting of folded) {
    const resolved = resolveCalendarMeetingOwner(meeting, owners);

    if (!resolved.owningRowFound) {
      logger.warn(
        {
          meetingId: meeting.meetingId,
          contextType: meeting.contextType,
          contextId: meeting.contextId,
          expertProfileId,
        },
        'Expert calendar meeting context resolved to no live owning row'
      );
    }

    result.push({
      meetingId: meeting.meetingId,
      scheduledStart: meeting.scheduledStart,
      scheduledEnd: meeting.scheduledEnd,
      status: meeting.status,
      contextType: meeting.contextType,
      // ⚠ NULLED WITH EVERY OTHER IDENTITY FIELD when the per-arm re-check found no live owning
      // row (BAL-498 fix round 3, R8). `meeting_contexts.context_id` has no FK and no RLS, so on
      // a drifted or forged row this value is ANOTHER TENANT'S `engagements.id` — emitting it
      // beside three deliberately-nulled siblings handed every consumer of the exported
      // `ExpertCalendarMeeting` an unverified cross-tenant identifier behind nothing but a
      // docblock. Fail closed here, once, rather than at each call site.
      contextId: resolved.owningRowFound ? meeting.contextId : null,
      ...resolved,
    });
  }
  return result;
}

interface ResolvedCalendarMeetingOwner {
  readonly engagementType: EngagementType | null;
  readonly projectRequestId: string | null;
  readonly counterpartyCompanyName: string | null;
  readonly owningRowFound: boolean;
}

/**
 * The per-meeting half of {@link assembleCalendarMeetings} — one folded meeting's winning context
 * resolved against the batch-load results. Extracted ONLY to shed cognitive complexity (the R8
 * `contextId` gate took the combined function from 15 to 16, and SonarCloud caps it at 15); the
 * behaviour is byte-for-byte what the inlined switch did.
 *
 * The exhaustive `switch` with `const unhandled: never` is deliberate (rather than
 * `includes()`/`else if`/`else`) so a seventh holder-bearing label cannot silently fall into the
 * `request_interaction` bucket — it fails `pnpm typecheck` instead.
 */
function resolveCalendarMeetingOwner(
  meeting: FoldedCalendarMeeting,
  owners: CalendarOwnerLookups
): ResolvedCalendarMeetingOwner {
  const missing: ResolvedCalendarMeetingOwner = {
    engagementType: null,
    projectRequestId: null,
    counterpartyCompanyName: null,
    owningRowFound: false,
  };

  switch (meeting.contextType) {
    case 'case':
    case 'project_kickoff':
    case 'package_session':
    case 'retainer_checkin': {
      const owning = owners.engagementById.get(meeting.contextId);
      if (owning === undefined) return missing;
      return {
        engagementType: owning.engagementType,
        projectRequestId: null,
        counterpartyCompanyName: owning.companyName,
        owningRowFound: true,
      };
    }
    case 'project_discovery': {
      const owning = owners.projectDiscoveryById.get(meeting.contextId);
      if (owning === undefined) return missing;
      return {
        engagementType: null,
        projectRequestId: owning.id,
        counterpartyCompanyName: owning.companyName,
        owningRowFound: true,
      };
    }
    case 'request_interaction': {
      const owning = owners.requestInteractionById.get(meeting.contextId);
      if (owning === undefined) return missing;
      return {
        engagementType: null,
        projectRequestId: owning.projectRequestId,
        counterpartyCompanyName: owning.companyName,
        owningRowFound: true,
      };
    }
    default: {
      const unhandled: never = meeting.contextType;
      throw new Error(`Unhandled meeting context type: ${String(unhandled)}`);
    }
  }
}

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
   * `MeetingContextUnresolvableError` or `MeetingContextNotProjectableError` (⚠ BAL-283: no
   * longer `request_interaction`, which now projects through
   * `request_expert_relationships.expert_profile_id`; every SHIPPED label has an arm, so that
   * last error is now the generic 8th-label defence) — and the WHOLE meeting rolls back. An
   * admin-only meeting resolves to `null`, writes no projection row, and blocks nobody.
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
   * BAL-283 — THE BATCHED "is a call booked on this context?" READ. One query for a WHOLE
   * page's worth of context ids; never one per id.
   *
   * Its first caller is the project-request conversation loader, which derives one
   * `bookedCall` per thread and must not go N+1 over a request's relationships — the same
   * batching posture as `conversationsRepository.latestMessagesForRelationships` and
   * `meetingContextsRepository.consultationTimestampsForEngagements`.
   *
   * FILTERS, all three load-bearing: live context rows, live meetings, and
   * `status <> 'cancelled'` — a cancelled meeting has released the slot
   * (`consultationStatusForMeeting`), so a surface that hid its "book a call" CTA on the
   * strength of one would strand the thread with no way to rebook.
   *
   * ⚠ THE PICK IS THE CALLER'S, NOT THIS METHOD'S. A thread can legitimately hold more than
   * one call over its life (an intro call that ended, then a second one booked), so this
   * returns EVERY live non-cancelled meeting per context, ordered `scheduled_start` then `id`
   * — deterministic, and never silently truncated. "Which of these is THE booked call" is a
   * display rule and belongs where the display lives. An entry is returned for EVERY
   * requested id (an empty array when none), so a caller never has to distinguish "absent"
   * from "none". An empty input returns an empty Map WITHOUT touching the DB.
   *
   * ⚠⚠ RESOLVES NO AUTHORIZATION, AND IS FED UNVALIDATED IDS. `meeting_contexts.context_id`
   * has NO FK and NO RLS, so a context id belonging to another tenant does not fail — it
   * returns that tenant's meetings. The caller MUST already have established the viewer's
   * right to every id it passes (for the conversation loader, `resolveRequestLens` runs
   * first). See the tenancy obligation on `schema/meeting-contexts.ts`; this method is a
   * display projection and is not a substitute for it.
   */
  async listActiveMeetingsForContexts(input: {
    contextType: MeetingContextType;
    contextIds: readonly string[];
  }): Promise<Map<string, ContextMeetingSummary[]>> {
    const byContext = new Map<string, ContextMeetingSummary[]>();
    for (const contextId of input.contextIds) {
      byContext.set(contextId, []);
    }
    if (byContext.size === 0) {
      return byContext;
    }

    const rows = await db
      .select({
        contextId: meetingContexts.contextId,
        meetingId: meetings.id,
        scheduledStart: meetings.scheduledStart,
        scheduledEnd: meetings.scheduledEnd,
        status: meetings.status,
      })
      .from(meetingContexts)
      .innerJoin(meetings, eq(meetings.id, meetingContexts.meetingId))
      .where(
        and(
          eq(meetingContexts.contextType, input.contextType),
          inArray(meetingContexts.contextId, [...byContext.keys()]),
          isNull(meetingContexts.deletedAt),
          isNull(meetings.deletedAt),
          ne(meetings.status, 'cancelled')
        )
      )
      .orderBy(asc(meetings.scheduledStart), asc(meetings.id));

    for (const row of rows) {
      // Unreachable for every non-`admin` label (the `meeting_context_admin_no_id`
      // biconditional CHECK), and `admin` ids can never match an `inArray` of uuids — but
      // `context_id` is typed nullable, so this is a narrowing guard, not a `!`.
      const bucket = row.contextId === null ? undefined : byContext.get(row.contextId);
      if (bucket === undefined) {
        continue;
      }
      bucket.push({
        meetingId: row.meetingId,
        scheduledStart: row.scheduledStart,
        scheduledEnd: row.scheduledEnd,
        status: row.status,
      });
    }
    return byContext;
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
   * ⚠ RETURNS `RescheduleMutationResult`, NOT `Meeting` — widens `MeetingMutationResult`
   * (BAL-428) with the pre-image window (for the audit row and the API response) and how many
   * guest links moved. `expertProfileId` is read from the LIVE PROJECTION ROW, never
   * re-resolved from the contexts; see `syncProjectionScheduleTx` for why re-resolving would
   * be a silent repoint.
   *
   * ⚠⚠ THE `cancel()` ASYMMETRY IS NOW SETTLED IN **BOTH** DIRECTIONS. An earlier revision of
   * this file left it UNDECIDED between two options: widen `cancel()` to
   * `waiting_for_participants`, or narrow this method to `scheduled` alone. **BAL-409 CHOSE THE
   * SECOND for reschedule, and BAL-410 (orchestrator D5) kept `cancel()` at `scheduled` too** —
   * so the two guards now AGREE on status and neither half of the asymmetry is open. See
   * `cancel()`'s own docblock for the one state where they still deliberately differ (a
   * past-start, never-joined meeting). The guard is now
   * `RESCHEDULABLE_MEETING_STATUSES` (`@balo/shared/meetings` — `readonly ['scheduled']`), the
   * SAME tuple the route's `resolveRescheduleRefusal` checks, so the repository guard and the
   * route guard cannot drift. Reasons, all load-bearing:
   *
   *   1. It is what the ticket's own AC says ("Reschedule is unavailable once the meeting has
   *      started").
   *   2. `waiting_for_participants` means the join window already opened. Moving it would
   *      leave a STALE status — the `waiting_for_participants → scheduled` back-edge is
   *      DECLARED LEGAL in the transition map (`lifecycle.ts:59-66`, D12) but DELIBERATELY
   *      UNIMPLEMENTED, because the presence rows from the pre-reschedule attempt are a
   *      BILLING question (BAL-412's). **Do not implement that back-edge here.**
   *   3. It leaves no open presence interval spanning a move
   *      (`meeting-presence.ts`'s `resolveClockCeiling` residual).
   *
   * `cancel()`'s guard is now `CANCELLABLE_MEETING_STATUSES` (`@balo/shared/meetings` —
   * `readonly ['scheduled']`), the SAME tuple its route's `resolveCancelRefusal` checks, exactly
   * as this method's guard mirrors `resolveRescheduleRefusal`. It has a LIVE production caller
   * (`POST /meetings/:meetingId/cancel` → `cancelMeeting`). See `cancel()`'s own docblock rather
   * than restating its reasoning here.
   *
   * ⚠⚠ GUARDED AT ALL FOR A SHARPER REASON THAN THE ABOVE. Without any status guard,
   * CANCEL-THEN-RESCHEDULE REOPENS EXACTLY THE DOUBLE-BOOKING THIS TICKET CLOSES, in the one
   * shape the reconciliation read cannot see:
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
   * `ended`, `in_progress` and `cancelled` are excluded for the same reason plus an
   * independent one: a delivered, running or cancelled call must not be silently moved into
   * the future.
   *
   * ⚠ IF RESCHEDULE-AFTER-CANCEL IS EVER MADE LEGAL (a "revive"), `syncProjectionScheduleTx`
   * MUST re-derive `status` from `meeting.status` in the same change, and `cancel()`'s guard
   * must be revisited. What must never exist again is the third state, where it half-works.
   *
   * ⚠ THE WALL-CLOCK RULE IS NOT HERE, matching `cancel()`: BAL-409's "how late may you move
   * it" policy (`resolveRescheduleRefusal`'s `already_started`) belongs at the CALL SITE. This
   * repository's status allow-list is the TOCTOU BACKSTOP — if the meeting flips to
   * `in_progress` between the route's gate read and this write, the UPDATE matches zero rows
   * and the whole transaction rolls back.
   *
   * ── THE FULL TRANSACTION, IN ORDER, ALL ON `tx` ────────────────────────────────
   *   1. Read the pre-image (`scheduled_start`/`scheduled_end`) — needed for the audit row's
   *      `previous` window. Consistent by construction: same transaction as the write below.
   *   2. The guarded compare-and-set, as above.
   *   3. `syncProjectionScheduleTx` — moves the `consultations` projection.
   *   4. `extendGuestExpiryForMeetingTx` — extends every live guest link (extend-only).
   *   5. `recordMeetingRescheduled` — the `meeting.rescheduled` audit row, LAST among the
   *      writes: an audit row left behind by a rolled-back move would attest to a move that
   *      never happened.
   */
  async updateSchedule(
    id: string,
    schedule: { scheduledStart: Date; scheduledEnd: Date },
    audit: { actorUserId: string | null }
  ): Promise<RescheduleMutationResult> {
    assertScheduleOrder(schedule.scheduledStart, schedule.scheduledEnd);

    return db.transaction(async (tx) => {
      // 1. Pre-image — read before the write so the audit row can carry the FROM window.
      // ⚠ N6 — `.for('update')`, NOT a bare SELECT. Without it, two concurrent reschedules on
      // the same meeting can both read the SAME pre-image before either writes: the second
      // request's audit row (and its `booking.rescheduled` email copy, which quotes `previous`)
      // would then name the window that was replaced by the FIRST request, not the one it
      // actually replaced. Locking here makes the second transaction block until the first
      // commits, so its own re-read of `before` sees the first move's result.
      const [before] = await tx
        .select({
          scheduledStart: meetings.scheduledStart,
          scheduledEnd: meetings.scheduledEnd,
        })
        .from(meetings)
        .where(and(eq(meetings.id, id), isNull(meetings.deletedAt)))
        .limit(1)
        .for('update');
      if (before === undefined) {
        throw new MeetingNotReschedulableError(id);
      }

      // 2. Guarded compare-and-set — the TOCTOU backstop, and the ONLY definition of "which
      // statuses may move" (shared with the route's `resolveRescheduleRefusal`).
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
            inArray(meetings.status, [...RESCHEDULABLE_MEETING_STATUSES]),
            isNull(meetings.deletedAt)
          )
        )
        .returning();
      if (meeting === undefined) {
        throw new MeetingNotReschedulableError(id);
      }

      // 3. Move the projection.
      const expertProfileId = await syncProjectionScheduleTx(tx, meeting);

      // 4. Extend every live guest link — extend-only, so a move EARLIER shortens nothing.
      const guestLinksExtended = await extendGuestExpiryForMeetingTx(
        tx,
        meeting.id,
        new Date(meeting.scheduledEnd.getTime() + GUEST_TOKEN_TTL_AFTER_END_MS)
      );

      // 5. LAST — an audit row left behind by a rolled-back move would attest to a move that
      // never happened.
      const rescheduleAuditId = await recordMeetingRescheduled(tx, {
        meetingId: meeting.id,
        actorUserId: audit.actorUserId,
        previous: before,
        scheduledStart: meeting.scheduledStart,
        scheduledEnd: meeting.scheduledEnd,
        expertProfileId,
        guestLinksExtended,
      });

      return { meeting, expertProfileId, previous: before, guestLinksExtended, rescheduleAuditId };
    });
  },

  /**
   * BAL-410 CANCEL SEAM — THE ONLY THING THAT FREES A BOOKED SLOT. Flips the meeting to
   * `status='cancelled'`, flips its `consultations` projection to `'cancelled'`, and writes the
   * `meeting.cancelled` audit row, all in ONE transaction — so the availability resolver's
   * `confirmed`-only filter re-opens the window at the same instant the state changes, and the
   * attribution commits or rolls back WITH it (ADR-1030, reasserted by ADR-1044 §5).
   *
   * ⚠ THE STATUS ALLOW-LIST IS `CANCELLABLE_MEETING_STATUSES` (`@balo/shared/meetings`), the
   * SAME tuple the route's `resolveCancelRefusal` consults — so the route guard and this
   * compare-and-set cannot drift, exactly the arrangement BAL-409 shipped for reschedule. It
   * throws `MeetingNotCancellableError` on no match: a meeting that already started, already
   * ended, was already cancelled or is soft-deleted must not silently "cancel" again and
   * re-fire the caller's post-commit unwind.
   *
   * ⚠⚠ THE `scheduled`-ONLY / `waiting_for_participants`-EXCLUDED ASYMMETRY THIS FILE ONCE
   * CALLED "UNDECIDED" IS NOW SETTLED (orchestrator D5), IN BOTH DIRECTIONS. BAL-409 narrowed
   * `updateSchedule` to `RESCHEDULABLE_MEETING_STATUSES = ['scheduled']`; BAL-410 keeps cancel
   * at `['scheduled']` too. That state guard is precisely what delivers the AC "cancellation is
   * unavailable once the meeting has started" — the first presence interval flips the meeting to
   * `waiting_for_participants`, so a meeting anybody joined is un-cancellable BY STATE.
   *
   * ⚠ THE WALL-CLOCK RULE IS NOT HERE, AND — UNLIKE RESCHEDULE — IT IS NOT AT THE CALL SITE
   * EITHER. `resolveCancelRefusal` reads no clock at all. "Free until scheduled start" is a
   * product promise delivered by the state guard above, not by comparing to `scheduled_start`;
   * the ticket forbids inventing a cutoff, and D5 settles it. A repository that read the clock
   * would in any case make every fixture and backfill subject to a policy that can change.
   *
   * ⚠ WHAT IS **NOT** IN THIS TRANSACTION, AND WHY IT CANNOT BE. The credit-hold release, the
   * Daily room delete and the `booking.cancelled` publish all run POST-COMMIT in `apps/api`
   * (`services/meetings/meeting-availability.ts`). `@balo/db` cannot enqueue (the BullMQ queue
   * lives only in `apps/api`, pinned by `invariants/repositories-never-notify.test.ts`), the
   * hold release takes the WALLET ADVISORY LOCK — folding it in here would hold the meeting row
   * lock then the wallet lock while `openSession` takes them in the opposite order, i.e. a
   * deliberate lock-ordering inversion — and a vendor HTTP call must never be able to roll back
   * a committed cancellation.
   *
   * ── THE FULL TRANSACTION, IN ORDER, ALL ON `tx` ────────────────────────────────
   *   1. The guarded compare-and-set, as above.
   *   2. `cancelProjectionTx` — the `consultations` projection, and the read that tells the
   *      caller WHOSE availability cache to rebuild.
   *   3. `recordMeetingCancelled` — the audit row, LAST among the writes. An audit row left
   *      behind by a rolled-back cancel would attest to a cancellation that never happened;
   *      `updateSchedule`'s rule, verbatim.
   */
  async cancel(
    id: string,
    audit: {
      actorUserId: string | null;
      /**
       * WHICH AUTHORIZATION ARM matched, or `'system'` for the ADR-1030 exemption (the dev
       * seeder). Server-derived at the call site — never taken from request input.
       */
      actorRole: 'client' | 'expert' | 'admin' | 'system';
    }
  ): Promise<CancelMutationResult> {
    return db.transaction(async (tx) => {
      const now = new Date();
      // 1. Guarded compare-and-set — the TOCTOU backstop AND the shared definition of "which
      //    statuses may be cancelled".
      const [meeting] = await tx
        .update(meetings)
        // Enum literals at QUERY time are always safe — the house restriction is on index
        // predicates and CHECKs, which is why 0059 adds neither for this label.
        .set({ status: 'cancelled', updatedAt: now })
        .where(
          and(
            eq(meetings.id, id),
            inArray(meetings.status, [...CANCELLABLE_MEETING_STATUSES]),
            isNull(meetings.deletedAt)
          )
        )
        .returning();
      if (meeting === undefined) {
        throw new MeetingNotCancellableError(id);
      }

      // 2. The projection — the same instant the resolver's `confirmed`-only filter reopens
      //    the window.
      const expertProfileId = await cancelProjectionTx(tx, id);

      // 3. LAST. See the docblock: an audit row must never outlive a rolled-back cancel.
      const cancelAuditId = await recordMeetingCancelled(tx, {
        meetingId: meeting.id,
        actorUserId: audit.actorUserId,
        actorRole: audit.actorRole,
        scheduledStart: meeting.scheduledStart,
        scheduledEnd: meeting.scheduledEnd,
        expertProfileId,
      });

      return { meeting, expertProfileId, cancelAuditId };
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
   * ⚠ BAL-466 wires the enabling condition — its only caller is the presence settlement,
   * which `joinMeetingAsMember` now makes reachable at admission to a `case` meeting.
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

  /**
   * BAL-498 — one row per live meeting on this expert's calendar, already reduced to ONE
   * context. See `packages/db/src/repositories/consultations.ts`'s docblock for why this
   * lives HERE and not there: the rows returned ARE meetings, `consultations` is only the
   * ownership-resolving join index.
   *
   * ⚠ THE OWNERSHIP PREDICATE IS DATA, NOT AUTHORIZATION. `consultations.expert_profile_id`
   * (a NOT NULL FK, written by the one module allowed to resolve it) is the primary filter;
   * every one of the three type-discriminated batch loads below ALSO re-checks
   * `expert_profile_id = :expertProfileId` independently, so a forged or drifted
   * `meeting_contexts.context_id` (no FK, no RLS) can never surface another tenant's company
   * name. `hasEngagementCapability` is NOT used and must not be — a `true` from that seam
   * authorizes the ACT, never the READ (ADR-1046/CLAUDE.md). The caller must supply
   * `expertProfileId` from the session, never a URL param.
   *
   * ⚠ `consultations.status = 'confirmed'` AND `meetings.status <> 'cancelled'` are BOTH
   * present, on purpose. The first rides `consultations_expert_status_range_idx`; the second
   * is the TRUTH (`meetings` is the source of truth, the projection is derived). If they ever
   * disagree the stricter one wins and the meeting is hidden — fail-closed.
   *
   * ⚠ `meetings.scheduledStart`/`scheduledEnd` are SELECTED; `consultations.startAt`/`endAt`
   * are only FILTERED on. They are kept in lockstep by `syncProjectionScheduleTx`.
   *
   * Selects NO join credential (`dailyRoomName`/`joinUrl`) — the Join affordance is built
   * from the meeting id alone via the tokenless lobby URL.
   *
   * A meeting whose contexts fold to `'none'` or `'ambiguous'` (via
   * {@link selectPrimaryMeetingContext}) is OMITTED, fail-closed, and logged.
   *
   * ⚠ BOUNDED, TWICE (BAL-498 fix round 3, S2). Since BAL-513, the only shipped caller derives TWO
   * ranges per request — the visible week and the Agenda horizon (`load-expert-calendar.ts`) — one
   * from a `?week=` query param and one from today, and neither is a function of the page's
   * ±365-day clamp any more. This method independently REFUSES a range wider than
   * {@link MAX_CALENDAR_RANGE_DAYS} and caps the row count at {@link MAX_CALENDAR_ROWS} regardless
   * of how a caller derived it. A future caller that forgets to clamp gets a thrown error, not a
   * full-history index scan plus an unbounded `inArray` bind list. Keep BOTH — the limit alone
   * would truncate a legitimately wide window instead of naming the mistake. BOTH bounds are
   * fail-closed for the default path: see {@link assertCalendarRowCapNotExceeded} for why reaching
   * the row cap throws rather than returning a calendar that is missing TODAY.
   */
  async listCalendarForExpert(input: {
    expertProfileId: string;
    /** Half-open, UTC instants. Span must not exceed {@link MAX_CALENDAR_RANGE_DAYS}. */
    rangeStart: Date;
    rangeEnd: Date;
    /** Defaults to {@link MAX_CALENDAR_ROWS}; clamped to it, never above. Supplying one opts
     *  INTO silent truncation (the default cap throws instead) — tests only. */
    limit?: number;
  }): Promise<ExpertCalendarMeeting[]> {
    const spanMs = input.rangeEnd.getTime() - input.rangeStart.getTime();
    if (!Number.isFinite(spanMs) || spanMs > MAX_CALENDAR_RANGE_DAYS * MS_PER_DAY) {
      throw new CalendarRangeTooWideError(input.rangeStart, input.rangeEnd);
    }
    const rowLimit = Math.min(
      MAX_CALENDAR_ROWS,
      Math.max(1, Math.trunc(input.limit ?? MAX_CALENDAR_ROWS))
    );
    const rows = await db
      .select({
        meetingId: meetings.id,
        scheduledStart: meetings.scheduledStart,
        scheduledEnd: meetings.scheduledEnd,
        status: meetings.status,
        contextType: meetingContexts.contextType,
        contextId: meetingContexts.contextId,
      })
      .from(consultations)
      .innerJoin(meetings, eq(meetings.id, consultations.meetingId))
      .innerJoin(meetingContexts, eq(meetingContexts.meetingId, meetings.id))
      .where(
        and(
          eq(consultations.expertProfileId, input.expertProfileId),
          eq(consultations.status, 'confirmed'),
          isNull(consultations.deletedAt),
          lt(consultations.startAt, input.rangeEnd),
          gt(consultations.endAt, input.rangeStart),
          isNull(meetings.deletedAt),
          ne(meetings.status, 'cancelled'),
          isNull(meetingContexts.deletedAt)
        )
      )
      .orderBy(asc(meetings.scheduledStart), asc(meetings.id))
      .limit(rowLimit);

    // Step 1b — the default cap is fail-closed, because `asc(scheduledStart)` + `LIMIT` truncates
    // the FUTURE end of the window (BAL-498 fix round 4, item 3).
    assertCalendarRowCapNotExceeded({
      rowCount: rows.length,
      rowLimit,
      limitIsCallerSupplied: input.limit !== undefined,
      expertProfileId: input.expertProfileId,
    });

    // Step 2 — fold each meeting's fanned-out context rows to ONE primary context.
    // ⚠ `rows` are CONTEXT rows, not meetings: one meeting fans out to several. A hard `LIMIT`
    // can therefore slice a meeting's context set in half, and half a context set folds to the
    // WRONG precedence winner (or to `'ambiguous'`). So the trailing — possibly truncated —
    // meeting group is dropped whenever the limit was actually reached. Unreachable in practice
    // (the range is clamped to weeks and MAX_CALENDAR_ROWS is generous), fail-closed if it ever is.
    const folded = foldMeetingContextRowsToPrimary(
      dropPossiblyTruncatedTrailingMeeting(rows, rowLimit, input.expertProfileId),
      input.expertProfileId
    );

    // Step 3a — classify winning contexts by grain, then one batch load per non-empty bucket.
    const { engagementIds, projectDiscoveryIds, requestInteractionIds } =
      classifyCalendarContextIds(folded);

    const [engagementRows, projectDiscoveryRows, requestInteractionRows] = await Promise.all([
      engagementIds.size === 0
        ? []
        : db
            .select({
              id: engagements.id,
              engagementType: engagements.engagementType,
              companyName: companies.name,
            })
            .from(engagements)
            .innerJoin(companies, eq(companies.id, engagements.companyId))
            .where(
              and(
                inArray(engagements.id, [...engagementIds]),
                eq(engagements.expertProfileId, input.expertProfileId),
                isNull(engagements.deletedAt)
              )
            ),
      projectDiscoveryIds.size === 0
        ? []
        : db
            .select({
              id: projectRequests.id,
              companyName: companies.name,
            })
            .from(projectRequests)
            .innerJoin(companies, eq(companies.id, projectRequests.companyId))
            .where(
              and(
                inArray(projectRequests.id, [...projectDiscoveryIds]),
                eq(projectRequests.expertProfileId, input.expertProfileId),
                isNull(projectRequests.deletedAt)
              )
            ),
      requestInteractionIds.size === 0
        ? []
        : db
            .select({
              id: requestExpertRelationships.id,
              projectRequestId: projectRequests.id,
              companyName: companies.name,
            })
            .from(requestExpertRelationships)
            .innerJoin(
              projectRequests,
              eq(projectRequests.id, requestExpertRelationships.projectRequestId)
            )
            .innerJoin(companies, eq(companies.id, projectRequests.companyId))
            .where(
              and(
                inArray(requestExpertRelationships.id, [...requestInteractionIds]),
                eq(requestExpertRelationships.expertProfileId, input.expertProfileId),
                isNull(requestExpertRelationships.deletedAt),
                isNull(projectRequests.deletedAt)
              )
            ),
    ]);

    const engagementById = new Map(engagementRows.map((row) => [row.id, row]));
    const projectDiscoveryById = new Map(projectDiscoveryRows.map((row) => [row.id, row]));
    const requestInteractionById = new Map(requestInteractionRows.map((row) => [row.id, row]));

    // Step 4 — resolve counterparties and assemble. Result order is ALREADY the SQL ORDER BY's
    // order (folding preserves first-encounter order via `Map` insertion order) — no second,
    // redundant JS sort.
    return assembleCalendarMeetings(
      folded,
      { engagementById, projectDiscoveryById, requestInteractionById },
      input.expertProfileId
    );
  },
};

/**
 * One row per live meeting on an expert's calendar (BAL-498), already reduced to ONE context
 * by {@link selectPrimaryMeetingContext}. See {@link meetingsRepository.listCalendarForExpert}.
 */
export interface ExpertCalendarMeeting {
  readonly meetingId: string;
  /** Source of truth for the rendered window — `meetings`, never the projection copy. */
  readonly scheduledStart: Date;
  readonly scheduledEnd: Date;
  /** Never `'cancelled'` (filtered both sides). */
  readonly status: MeetingStatus;
  /** The precedence winner from {@link selectPrimaryMeetingContext}. */
  readonly contextType: MeetingContextTypeWithHolder;
  /**
   * The winning `meeting_contexts.context_id` — `null` whenever {@link owningRowFound} is
   * `false`, exactly like `engagementType` / `projectRequestId` / `counterpartyCompanyName`.
   * That column crosses a seam with no FK and no RLS, so an unverified value is another tenant's
   * identifier, not this expert's (BAL-498 fix round 3, R8).
   */
  readonly contextId: string | null;
  /** Non-null for the four engagement-grain labels only. */
  readonly engagementType: EngagementType | null;
  /** `project_requests.id` — non-null for the two request-grain labels only (link target). */
  readonly projectRequestId: string | null;
  /** The CLIENT COMPANY. `null` when the owning row is absent/soft-deleted (drifted projection). */
  readonly counterpartyCompanyName: string | null;
  /**
   * `true` only when the per-arm re-check (`expert_profile_id = :expertProfileId` on the owning
   * engagement/request/relationship row) actually matched a live row. `false` on a drifted or
   * forged `context_id`, or a soft-deleted owning row — the SAME condition that forces
   * `counterpartyCompanyName` to `null`. Callers building a link (`href`) MUST gate on this, not
   * on `contextId`/`projectRequestId` alone: those columns survive a no-FK, no-RLS polymorphic
   * seam unverified, and rendering one as a live href when this is `false` would leak another
   * tenant's identifier (security-bal-498.md MEDIUM finding).
   */
  readonly owningRowFound: boolean;
}

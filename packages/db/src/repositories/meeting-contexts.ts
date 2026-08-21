import { and, asc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import {
  findPrimaryMeetingContextRepoint,
  type PrimaryMeetingContext,
} from '@balo/shared/meetings';
import { db } from '../client';
import {
  creditSessions,
  meetingContexts,
  meetings,
  type Meeting,
  type MeetingContext,
  type MeetingContextType,
} from '../schema';
import { isUniqueViolation } from './experts';
import { assertProjectionExpertUnchangedTx } from './_shared/consultation-projection';
import type { DbExecutor } from './_shared/db-executor';

/** BAL-425's two consultation anchors for ONE case engagement. */
export interface ConsultationTimestamps {
  lastCompletedConsultationAt: Date | null;
  nextScheduledConsultationAt: Date | null;
}

/**
 * `context_id` is NULLABLE (an `admin` meeting has no subject), and `= NULL` is never
 * TRUE — so every read that filters on it must branch to `IS NULL`.
 */
function contextIdMatches(contextId: string | null): SQL | undefined {
  return contextId === null
    ? isNull(meetingContexts.contextId)
    : eq(meetingContexts.contextId, contextId);
}

/** An aggregate timestamp as it may actually arrive from a raw `sql` fragment. */
type AggregateTimestamp = Date | string | null;

/**
 * Normalize an aggregate timestamp back to a `Date`. The postgres-js driver parses a
 * `timestamptz` column to a `Date`, but an aggregate expression reached through a raw
 * `sql` fragment is typed by US, not by the driver — so narrow defensively rather than
 * asserting (memory `reference_jsonb_date_type_lie`: a type that merely CLAIMS `Date` is
 * how string-typed timestamps leak into callers).
 */
function toDate(value: AggregateTimestamp): Date | null {
  if (value === null) {
    return null;
  }
  return value instanceof Date ? value : new Date(value);
}

/**
 * Thrown by `attach` when a meeting already has an `admin` context row. A NAMED error so
 * BAL-129/BAL-134 branch on a type instead of string-matching driver SQLSTATEs.
 */
export class MeetingAdminContextExistsError extends Error {
  constructor(public readonly meetingId: string) {
    super(`Meeting ${meetingId} already has an admin context (meeting_context_admin_uq)`);
    this.name = 'MeetingAdminContextExistsError';
  }
}

/**
 * Thrown by `attach` (BAL-469) when a genuinely-new context row would REPOINT the meeting's
 * primary context — `selectPrimaryMeetingContext` resolved `ok` to `from` before the insert
 * and resolves `ok` to a DIFFERENT `to` after it. A NAMED error, not `…TenancyFlipError`: the
 * guard compares the primary CONTEXT, never a company — see `findPrimaryMeetingContextRepoint`
 * and the `attach` docblock for why that is sufficient.
 *
 * ⚠⚠ `from` AND `to` ARE LOG-ONLY. THEY MUST NEVER BE RETURNED ON THE WIRE. Both are derived
 * from `before` — rows that already existed on the TARGET meeting — so `from` in particular can
 * name another tenant's `engagements.id` / `project_requests.id`. That UUID feeds straight into
 * `listMeetingsForContext`, which — per this table's own schema docblock — returns another
 * tenant's meetings INCLUDING `join_url` / `daily_room_name` (call-join credentials). A caller
 * MUST authorize against the MEETING before this error is even reachable (the `contextId` being
 * attached is not enough — see the module-level obligation below); and the wire response for
 * this error MUST collapse to the same opaque literal a non-existent meeting produces, exactly
 * like `MeetingAdminContextExistsError`'s sibling treatment and the BAL-129 precedent (one
 * denial, no distinct reason literal, unless the caller has already authorized against the
 * meeting) — the repoint shape (`meetingId`, `from`, `to`) goes to the log only.
 */
export class MeetingPrimaryContextRepointedError extends Error {
  constructor(
    public readonly meetingId: string,
    public readonly from: PrimaryMeetingContext,
    public readonly to: PrimaryMeetingContext
  ) {
    super(`Attaching this context would repoint meeting ${meetingId}'s primary context (BAL-469)`);
    this.name = 'MeetingPrimaryContextRepointedError';
  }
}

/**
 * BAL-469 — refuses an `attach` that REPOINTS a meeting's primary context. See guard 1 on
 * `attach`'s own docblock for the full rationale; this is deliberately a MODULE-PRIVATE
 * sibling to `assertProjectionExpertUnchangedTx`, not an export, because its behaviour is
 * enforced and pinned entirely through `attach`.
 *
 * One `select` from `meetingContexts`, executed on `exec` (the transaction), so it sees the
 * row the insert just added. `after` is every live row; `before` is `after` minus the row
 * whose id is `insertedContextRowId` — deriving `before` by ROW ID (not by re-deriving the
 * triple) is exact and needs no reasoning about the partial unique index, because the insert
 * added exactly one row and nothing else in the transaction has touched this table.
 *
 * ⚠ ONE READ, NOT TWO. Reading `before` in a separate pre-insert select would work equally,
 * but costs a second round trip and a second consistency argument for no benefit — the
 * insert's own returned id is all `before` needs to be excluded.
 */
async function assertPrimaryContextUnchangedTx(
  exec: DbExecutor,
  meetingId: string,
  insertedContextRowId: string
): Promise<void> {
  const after = await exec
    .select({
      id: meetingContexts.id,
      contextType: meetingContexts.contextType,
      contextId: meetingContexts.contextId,
    })
    .from(meetingContexts)
    .where(and(eq(meetingContexts.meetingId, meetingId), isNull(meetingContexts.deletedAt)));

  const before = after.filter((row) => row.id !== insertedContextRowId);

  const repoint = findPrimaryMeetingContextRepoint(before, after);
  if (repoint !== null) {
    throw new MeetingPrimaryContextRepointedError(meetingId, repoint.from, repoint.to);
  }
}

/**
 * `meetingContextsRepository` (BAL-418 / ADR-1045 §2) — the polymorphic seam's read/write
 * surface, plus THE BAL-425 SEAM (`consultationTimestampsForEngagements`).
 *
 * ⚠⚠ EVERY METHOD HERE TAKES AN UNVALIDATED, UNCONSTRAINED `contextId`. `context_id` has
 * NO FK (it is polymorphic) and there is no RLS behind it, so a uuid belonging to ANOTHER
 * TENANT does not raise `23503` — it **succeeds silently**. `listMeetingsForContext` would
 * hand back another tenant's meetings including `join_url`/`daily_room_name` (call-join
 * credentials); `attach` would forge a context row that feeds
 * `consultationTimestampsForEngagements` and hold a victim's case open via `isCaseInactive`
 * for as long as that forged `scheduled_start` stays in the future — renewable at will by
 * forging another.
 *
 * EVERY CALLER MUST resolve the context's owning party and check `hasCapability` BEFORE
 * passing `contextId` in. That check belongs in the service / server-action layer, not
 * here — authorization is capability-based and resolved at the call site (ADR-1029), so a
 * gate inside a repository would be the deviation. The full statement of this obligation,
 * with the named downstream owners (BAL-129, BAL-421, BAL-425/BAL-420, and BAL-424 by
 * inheritance), lives on the table in `schema/meeting-contexts.ts`.
 */
export const meetingContextsRepository = {
  /**
   * Attach ONE context to a meeting.
   *
   * IDEMPOTENT FOR A NON-ADMIN CONTEXT: the `onConflictDoNothing` arbiter matches
   * `meeting_context_unique_idx` EXACTLY — target `(meeting_id, context_type, context_id)`
   * with predicate `deleted_at IS NULL` — so re-attaching the same triple returns the
   * EXISTING row instead of a duplicate.
   *
   * ⚠ NOT IDEMPOTENT FOR `admin` (`contextId === null`), by design: NULLs are DISTINCT in
   * the triple index, so a second admin attach does not hit that arbiter — it hits
   * `meeting_context_admin_uq`. That guard is the whole point (ONE admin context per
   * meeting); swallowing it would silently re-admit the duplicate the index exists to stop.
   * The violation is surfaced as a NAMED `MeetingAdminContextExistsError` so BAL-129/BAL-134
   * branch on a type rather than string-matching driver SQLSTATEs.
   *
   * The insert runs in its own transaction so that conflict is contained in a SAVEPOINT: an
   * expected, named control-flow error must not poison an ambient caller transaction (which
   * a bare `23505` would, leaving every later statement failing `25P02`).
   *
   * ⚠ TWO GUARDS RUN ON A GENUINELY-NEW ROW, AND THEY ANSWER DIFFERENT QUESTIONS. Both run
   * inside the insert's own transaction, so either throw rolls the attach back.
   *
   *   1. `assertPrimaryContextUnchangedTx` (BAL-469) — THE MEETING'S ANCHOR. An attach may
   *      ESTABLISH a primary context (a meeting that had none, or whose contexts were
   *      ambiguous) and it may DISSOLVE one (a second top-tier subject makes
   *      `selectPrimaryMeetingContext` answer `ambiguous`, which every reader of that rule
   *      treats as a denial — so the meeting names NO company rather than the wrong one). It
   *      may NEVER REPOINT one: primary resolved to P before, resolves to a DIFFERENT Q
   *      after ⇒ `MeetingPrimaryContextRepointedError`.
   *      WHY THAT IS THE TENANCY GUARANTEE, WITHOUT READING A COMPANY: the owning company is
   *      a pure function of the primary context (`selectPrimaryMeetingContext` →
   *      `resolveContextOwner`), and an attach writes none of the tables that function reads.
   *      So ACROSS A SINGLE `attach`, if the primary cannot be repointed, the named company can
   *      only go "some" → "none" or "none" → "some" — never X → Y. That is the hazard
   *      `_shared/meeting-context-owner.ts` documented and could not catch from the read side:
   *      its `expectedExpertProfileId` compares the EXPERT, which the hazard leaves unchanged
   *      by construction.
   *      ⚠⚠ THAT GUARANTEE IS PER-`attach` CALL, NOT PER-MEETING. `detach` IS A SEPARATE WRITER
   *      OF `meeting_contexts` AND IS NOT GUARDED BY ANYTHING HERE — see `detach`'s own
   *      docblock below for the two reachable sequences (a bare detach of the current winner,
   *      and an attach-to-ambiguous followed by a detach of the original winner) that compose
   *      into exactly the X → Y flip this guard refuses in one step. Neither is closed by this
   *      ticket; both are named residuals, not oversights.
   *      ⚠ THIS GUARD SECURES THE ANCHOR, NOT MEMBERSHIP. `listMeetingsForContext` matches ANY
   *      live context row regardless of tier, so attaching a LOWER-tier context the caller owns
   *      underneath a victim meeting's tier-100 primary is ALLOWED by this rule (it is a
   *      dissolve-safe, establish-safe shape by the table above) and hands the attacker a read
   *      of that victim meeting's `join_url` / `daily_room_name` through the reverse read. That
   *      is a pre-existing, loudly-documented gap (the module-level obligation above) whose
   *      closure is the CALLER'S — this guard was never meant to, and does not, close it.
   *      ⚠ IT DELIBERATELY DOES NOT READ `consultations`. Guard 2 returns early when a meeting
   *      has no live projection row; folding this into it would inherit that early return and
   *      leave every UNBOOKED meeting un-gated. Two guards, two scopes, one transaction.
   *      ⚠ THE ESTABLISHING ARM'S OBLIGATION IS ON THE MEETING, NOT THE CONTEXT. `none → ok`
   *      is ALLOWED — nothing was named before, so nothing is repointed — which also means an
   *      `admin`-only (platform-axis, ADR-1035) meeting can be captured onto an engagement:
   *      `admin` scores 0 and is dropped, there is no projection row, so NEITHER guard fires,
   *      and the meeting resolves to the attacher's own context, handing its delivering expert
   *      `host_meetings` on a meeting they never legitimately owned. The module-level
   *      obligation above names the party owning the CONTEXT being attached, which the
   *      attacker legitimately owns; the obligation that actually binds on an establishing
   *      attach is on the MEETING being captured, and a caller must resolve and authorize
   *      against THAT before calling `attach`, not merely against the context it is holding.
   *      ⚠ WHAT THIS NARROWS, STATED SO IT IS NOT REDISCOVERED AS A BUG: a tier-50
   *      `project_discovery` meeting can no longer be PROMOTED to an engagement context by
   *      attaching one. ADR-1046's precedence docblock describes that promotion as the
   *      intended READ semantics, and it still is — a meeting carrying both grains resolves to
   *      the engagement. What changed is that such a meeting must be CREATED that way
   *      (`meetingsRepository.create({ contexts: [discovery, kickoff] })`, which works today
   *      and is tested), or re-anchored by an explicit named operation. Re-anchoring a booked
   *      call changes who may host it, which conversation it threads to, whose files and recap
   *      it appears under, and which engagement's consultation anchors it feeds; that is not a
   *      tag edit, and `attach` is a tagging operation (see `detach`'s docblock, which this
   *      mirrors on purpose). Widening this needs an ADR-1046 amendment and a named caller.
   *
   *   2. `assertProjectionExpertUnchangedTx` (BAL-428) — THE BOOKING'S EXPERT.
   *      `meetingsRepository` resolves the delivering expert from the contexts it is given at
   *      create time, but THIS method can widen that set afterwards. A genuinely-new context
   *      row therefore re-resolves the expert across the meeting's whole live context set and
   *      throws `MeetingExpertAmbiguousError` if the answer is no longer the one already
   *      booked. Without it, a booked meeting could gain a context naming a DIFFERENT expert
   *      while the projection kept blocking the first one's calendar.
   *
   * BOTH GUARDS RUN ONLY ON THE `inserted !== undefined` BRANCH, deliberately: the conflict
   * branch changed nothing, so re-resolving there would be pure cost — and could start
   * throwing for an idempotent re-attach that is by definition still consistent. Neither ever
   * CREATES a projection row: `attach` is not a booking path (see
   * `assertProjectionExpertUnchangedTx`).
   */
  async attach(input: {
    meetingId: string;
    contextType: MeetingContextType;
    contextId: string | null;
  }): Promise<MeetingContext> {
    const inserted = await db.transaction(async (tx) => {
      try {
        const [row] = await tx
          .insert(meetingContexts)
          .values({
            meetingId: input.meetingId,
            contextType: input.contextType,
            contextId: input.contextId,
          })
          .onConflictDoNothing({
            target: [
              meetingContexts.meetingId,
              meetingContexts.contextType,
              meetingContexts.contextId,
            ],
            where: isNull(meetingContexts.deletedAt), // predicate MUST match the index exactly
          })
          .returning();
        if (row !== undefined) {
          // Inside the SAME transaction as the insert — a throw here rolls the attach back.
          await assertPrimaryContextUnchangedTx(tx, input.meetingId, row.id);
          await assertProjectionExpertUnchangedTx(tx, input.meetingId);
        }
        return row;
      } catch (error) {
        if (isUniqueViolation(error, 'meeting_context_admin_uq')) {
          throw new MeetingAdminContextExistsError(input.meetingId);
        }
        throw error;
      }
    });

    if (inserted !== undefined) {
      return inserted;
    }

    const [existing] = await db
      .select()
      .from(meetingContexts)
      .where(
        and(
          eq(meetingContexts.meetingId, input.meetingId),
          eq(meetingContexts.contextType, input.contextType),
          contextIdMatches(input.contextId),
          isNull(meetingContexts.deletedAt)
        )
      )
      .limit(1);
    if (existing === undefined) {
      throw new Error(
        `meetingContexts.attach conflicted but no live context row was found for meeting ${input.meetingId}`
      );
    }
    return existing;
  },

  /** Every live context row for a meeting — "what is this meeting FOR". */
  async listByMeeting(meetingId: string): Promise<MeetingContext[]> {
    return db
      .select()
      .from(meetingContexts)
      .where(and(eq(meetingContexts.meetingId, meetingId), isNull(meetingContexts.deletedAt)))
      .orderBy(asc(meetingContexts.createdAt), asc(meetingContexts.id));
  },

  /**
   * THE REVERSE READ — "every live meeting for this context", earliest first. Rides
   * `meeting_context_reverse_idx`. BAL-421's case surface uses this.
   */
  async listMeetingsForContext(
    contextType: MeetingContextType,
    contextId: string
  ): Promise<Meeting[]> {
    const rows = await db
      .select({ meeting: meetings })
      .from(meetingContexts)
      .innerJoin(meetings, eq(meetings.id, meetingContexts.meetingId))
      .where(
        and(
          eq(meetingContexts.contextType, contextType),
          eq(meetingContexts.contextId, contextId),
          isNull(meetingContexts.deletedAt),
          isNull(meetings.deletedAt)
        )
      )
      .orderBy(asc(meetings.scheduledStart), asc(meetings.id));
    return rows.map((row) => row.meeting);
  },

  /**
   * Soft-detach ONE context from a meeting. A no-op when nothing live matches. Soft, not
   * hard: `meeting_context_unique_idx` is partial on `deleted_at IS NULL`, so the same
   * context can be re-attached afterwards.
   *
   * ⚠⚠ BAL-428 — THIS DELIBERATELY DOES **NOT** TOUCH THE `consultations` PROJECTION, AND
   * THAT IS NOT AN OVERSIGHT. DO NOT "FIX" IT.
   *
   * `attach` gained a projection guard, so the symmetric-looking change here is to free the
   * slot when the last context is detached. That would be WRONG. Detaching a context edits
   * what a meeting is ABOUT; it does not un-book the call. Wiring it to the projection would
   * mean an administrative re-tagging silently hands the expert's reserved time back to the
   * marketplace while the meeting still exists, still has a join url, and still shows on
   * both calendars — and the first anyone hears of it is a double-booked expert.
   *
   * `meetingsRepository.cancel()` is the ONE thing that frees a booked slot, and
   * `meetingsRepository.softDelete()` is the one thing that removes it. Both are explicit
   * about ending the meeting. This is not.
   *
   * A detach that leaves the projection pointing at an expert the remaining contexts no
   * longer name IS drift — and `findProjectionDrift()` reports it as `expert_mismatch`,
   * which is the correct treatment: surface it for a human, do not let a tagging operation
   * mutate a booking.
   *
   * ⚠⚠ BAL-469 — THIS METHOD CAN REPOINT THE MEETING'S PRIMARY CONTEXT, AND NOTHING HERE
   * GUARDS AGAINST IT. `attach`'s `assertPrimaryContextUnchangedTx` only ever runs on an
   * INSERT; `detach` is a bare soft-delete `update` with no primary-stability check, no expert
   * guard, no authorization. Two reachable sequences, both using only shipped, tested
   * operations:
   *   1. DIRECTLY. A meeting anchored `{project_discovery, R}` (company X) that ALSO carries
   *      `{project_kickoff, G}` (company Y, tier-100, so it is the primary) has that primary
   *      detached — `detach(meetingId, 'project_kickoff', G)` — leaving only the tier-50 row.
   *      The meeting now resolves to X. A silent repoint, from the OTHER direction to the one
   *      `attach`'s guard closes.
   *   2. AS STEP TWO OF AN ATTACH-TO-AMBIGUOUS. Primary `{case, G1}` (company X) → `attach
   *      {case, G2}` (company Y, same expert) is ALLOWED (dissolves to `ambiguous` — see guard
   *      1 above) → `detach(meetingId, 'case', G1)` → primary is now `{case, G2}`, company Y.
   *      Two individually-permitted steps compose into the exact X → Y flip `attach` alone
   *      refuses. This is also why the ambiguity residual's "reversible by `detach`" framing
   *      overstates the remedy: `detach` is not only the repair path, it is the second half of
   *      this attack, and the caller — not the meeting — chooses which context survives.
   *
   * BAL-469 DELIBERATELY DID NOT CLOSE THIS. `detach` has ZERO production callers (every call
   * site is a test), so both sequences ship inert, exactly like the hazard `attach`'s guard
   * fixes did before this ticket. The closure — most likely the same
   * `findPrimaryMeetingContextRepoint` call in `detach`'s own update path, which today runs no
   * transaction at all — is tracked as BAL-471 and MUST land before whichever ticket
   * (BAL-410 / BAL-411) gives `detach` its first production caller. Until then this is a named
   * residual, not a rediscovered bug.
   */
  async detach(
    meetingId: string,
    contextType: MeetingContextType,
    contextId: string | null
  ): Promise<void> {
    const now = new Date();
    await db
      .update(meetingContexts)
      .set({ deletedAt: now, updatedAt: now })
      .where(
        and(
          eq(meetingContexts.meetingId, meetingId),
          eq(meetingContexts.contextType, contextType),
          contextIdMatches(contextId),
          isNull(meetingContexts.deletedAt)
        )
      );
  },

  /**
   * THE BAL-425 SEAM — the two consultation anchors `isCaseInactive`
   * (`@balo/shared/engagements`) takes as parameters, for a BATCH of case engagements.
   *
   * BATCHED DELIBERATELY: BAL-420 sweeps a candidate list from
   * `caseEngagementsRepository.listOpenCreatedBefore`, so a per-engagement query would be
   * a textbook N+1.
   *
   * Resolution rules (both directions):
   *  - `lastCompletedConsultationAt` = `MAX(COALESCE(credit_sessions.ended_at,
   *    meetings.ended_at))` over live meetings whose `status='ended'` AND
   *    `outcome='completed'`. ⚠ THE LEFT JOIN IS DELIBERATE: a completed case
   *    consultation that carried NO `credit_sessions` row (comped, promo, or an
   *    `external` duration still parked) must still count as completed. Anchoring purely
   *    on `credit_sessions.ended_at` would make such a case look never-consulted and
   *    auto-close it.
   *  - `nextScheduledConsultationAt` = `MIN(meetings.scheduled_start)` over live meetings
   *    with `scheduled_start > now` AND `status IN ('scheduled',
   *    'waiting_for_participants')` — THE TWO STATUSES NAMED, never "a non-terminal
   *    status". `meeting_status` is `scheduled | waiting_for_participants | in_progress |
   *    ended`, of which only `ended` is terminal, so "non-terminal" would also mean
   *    `in_progress` — which this filter deliberately EXCLUDES. The anchor means UPCOMING,
   *    and a meeting already running is not upcoming. Probed on Postgres 16 with one
   *    future-dated meeting per status: `scheduled` → the timestamp,
   *    `waiting_for_participants` → the timestamp, `in_progress` → NULL, `ended` → NULL.
   *
   * ⚠ THE BOUNDARY THAT FALLS OUT OF THAT, ASSIGNED TO **BAL-425/BAL-420** IN WRITING. An
   * `in_progress` meeting contributes to NEITHER anchor — not to
   * `nextScheduledConsultationAt` (not upcoming) and not to `lastCompletedConsultationAt`
   * (not `ended`) — so a case whose only activity is a consultation running RIGHT NOW reads
   * as having none. `isCaseInactive` then falls back to `caseInactivityAnchor`'s
   * `engagements.created_at`, so a case created ≥ `CASE_INACTIVITY_DAYS` ago whose FIRST
   * consultation is in progress is eligible for auto-close MID-CALL. Widening the filter is
   * not this seam's call to make (the anchor's meaning is "upcoming"); the sweep must handle
   * it — by excluding engagements with a live `in_progress` meeting from its candidate list,
   * or by deciding explicitly that the exposure is acceptable. Stated here, in the same
   * register as the tenancy obligation above, so it is not rediscovered as a case that
   * closed itself while two people were talking.
   *
   * Enum literals at QUERY time are always safe — the house restriction is on index
   * predicates and CHECKs only.
   *
   * Returns an entry for EVERY requested id (both timestamps `null` when nothing matches),
   * so BAL-420 never has to distinguish "absent" from "none". An empty input returns an
   * empty Map WITHOUT touching the DB.
   */
  async consultationTimestampsForEngagements(
    engagementIds: string[],
    now: Date
  ): Promise<Map<string, ConsultationTimestamps>> {
    const result = new Map<string, ConsultationTimestamps>();
    for (const engagementId of engagementIds) {
      result.set(engagementId, {
        lastCompletedConsultationAt: null,
        nextScheduledConsultationAt: null,
      });
    }
    if (result.size === 0) {
      return result;
    }

    const rows = await db
      .select({
        contextId: meetingContexts.contextId,
        lastCompletedConsultationAt: sql<AggregateTimestamp>`
          max(coalesce(${creditSessions.endedAt}, ${meetings.endedAt}))
            filter (where ${meetings.status} = 'ended' and ${meetings.outcome} = 'completed')
        `,
        // ⚠ `now` is bound as an ISO STRING with an explicit `::timestamptz` cast. A raw
        // `sql` fragment gives postgres-js no column to infer the parameter type from, and
        // it cannot serialize a bare `Date` there ("the string argument must be of type
        // string … received an instance of Date").
        nextScheduledConsultationAt: sql<AggregateTimestamp>`
          min(${meetings.scheduledStart})
            filter (where ${meetings.scheduledStart} > ${now.toISOString()}::timestamptz
                      and ${meetings.status} in ('scheduled', 'waiting_for_participants'))
        `,
      })
      .from(meetingContexts)
      .innerJoin(
        meetings,
        and(eq(meetings.id, meetingContexts.meetingId), isNull(meetings.deletedAt))
      )
      .leftJoin(
        creditSessions,
        and(eq(creditSessions.meetingId, meetings.id), isNull(creditSessions.deletedAt))
      )
      .where(
        and(
          eq(meetingContexts.contextType, 'case'),
          inArray(meetingContexts.contextId, [...result.keys()]),
          isNull(meetingContexts.deletedAt)
        )
      )
      .groupBy(meetingContexts.contextId);

    for (const row of rows) {
      if (row.contextId === null) {
        continue; // unreachable under context_type='case' (the biconditional CHECK)
      }
      result.set(row.contextId, {
        lastCompletedConsultationAt: toDate(row.lastCompletedConsultationAt),
        nextScheduledConsultationAt: toDate(row.nextScheduledConsultationAt),
      });
    }
    return result;
  },
};

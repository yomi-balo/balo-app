import { and, asc, eq, exists, gt, inArray, isNull, lte, sql } from 'drizzle-orm';
import { db } from '../client';
import {
  rescheduleProposals,
  rescheduleProposalOptions,
  meetings,
  type RescheduleProposal,
  type RescheduleProposalOption,
} from '../schema';
import type { DbExecutor } from './_shared/db-executor';
import { isUniqueViolation } from './experts';

/** One proposed alternative time. `scheduled_end` is server-pinned by the CALLER at propose time. */
export interface RescheduleProposalOptionInput {
  scheduledStart: Date;
  /** ⚠ DISPLAY ONLY — the accept path re-pins the duration from the live meeting (§D7 step 7). */
  scheduledEnd: Date;
}

export interface ProposeRescheduleInput {
  meetingId: string;
  /** The proposing expert. Attribution only — the capability check is the CALLER'S (ADR-1029). */
  proposedByUserId: string;
  /** The meeting's `scheduled_start` as read in this same request — the staleness anchor. */
  originalScheduledStart: Date;
  /** The deadline. Must be `<= originalScheduledStart` (DB CHECK). */
  expiresAt: Date;
  /**
   * 1..3 options, in DISPLAY ORDER — the array index BECOMES `position`. A 4th option fails
   * `23514` on `reschedule_proposal_option_position_range`, and a duplicate
   * `scheduledStart` fails `23505` on `reschedule_proposal_option_start_idx`; both are
   * backstops for validation the route performs first, not the primary rejection.
   */
  options: readonly RescheduleProposalOptionInput[];
}

export interface RescheduleProposalWithOptions {
  proposal: RescheduleProposal;
  /** Live options only, in `position` order. */
  options: RescheduleProposalOption[];
}

/** The case-surface projection — PROJECTED COLUMNS ONLY, never a relational hydration. */
export interface LiveRescheduleProposalSummary {
  proposalId: string;
  meetingId: string;
  optionCount: number;
  originalScheduledStart: Date;
  expiresAt: Date;
}

export interface AnswerRescheduleProposalInput {
  proposalId: string;
  /** ⚠ Always paired with the proposal id: a bare `proposalId` is never a subject. */
  meetingId: string;
  /** The client who accepted/declined, or the expert who withdrew. */
  actorUserId: string;
}

export interface AcceptRescheduleProposalInput extends AnswerRescheduleProposalInput {
  optionId: string;
}

export interface AcceptedRescheduleProposal {
  proposal: RescheduleProposal;
  /** The winning option, with `accepted_at` stamped. */
  option: RescheduleProposalOption;
}

/**
 * A second live proposal was attempted on a meeting that already has one pending
 * (`reschedule_proposal_one_pending_idx`). Named, so the route branches on a TYPE rather
 * than string-matching a driver SQLSTATE, and maps it to 409 `proposal_already_pending`.
 */
export class RescheduleProposalAlreadyPendingError extends Error {
  constructor(meetingId: string) {
    super(`A pending reschedule proposal already exists for meeting: ${meetingId}`);
    this.name = 'RescheduleProposalAlreadyPendingError';
  }
}

/**
 * ⚠ PRIVATE, AND IT IS A ROLLBACK MECHANISM — NOT AN ERROR SIGNAL. Thrown inside `accept`'s
 * transaction when the named option does not belong to the proposal, purely to force the
 * (sub)transaction to unwind the proposal CAS that has already run in it; it is caught two
 * lines later and converted to `undefined`. It must never escape this module, and the route
 * must never see it — an unknown option collapses into the SAME one wire literal as a lost
 * CAS (`proposal_not_answerable`), per §D7 step 5.
 */
class RescheduleProposalOptionMissError extends Error {
  constructor() {
    super('reschedule proposal option miss');
    this.name = 'RescheduleProposalOptionMissError';
  }
}

/**
 * THE ANSWERABILITY PREDICATE — restated ONCE and shared by `accept`, `decline` and
 * `withdraw`, because three copies of it is three chances for one to drift.
 *
 * `status = 'pending' AND expires_at > now AND deleted_at IS NULL`, scoped to
 * `(id, meeting_id)`. This single conditional `UPDATE … RETURNING` is what serialises every
 * race the feature has — two concurrent accepts of different options, withdraw-vs-accept,
 * double-decline, double-withdraw: Postgres takes the row lock and performs the transition
 * together, so exactly one caller can observe it. Zero rows is therefore not an error, it is
 * the LOSER'S ANSWER, and every caller maps it to one 409 literal.
 *
 * ⚠ THE EXPIRY HALF IS THE ENFORCEMENT, NOT THE DERIVATION. Expiry is evaluated lazily
 * (§D1) and a lapsed row keeps `status = 'pending'`, so `deriveRescheduleProposalState`
 * READS it as expired while this predicate REFUSES it. Enforcement does not depend on any
 * caller remembering to derive first.
 *
 * ⚠ `gt`, NOT `gte`. At exactly `expires_at` the ask has lapsed; the deadline is the
 * original start, and "accepting" at the instant the call was due to begin is not an answer.
 */
function answerableProposal(proposalId: string, meetingId: string, now: Date) {
  return and(
    eq(rescheduleProposals.id, proposalId),
    eq(rescheduleProposals.meetingId, meetingId),
    eq(rescheduleProposals.status, 'pending'),
    gt(rescheduleProposals.expiresAt, now),
    isNull(rescheduleProposals.deletedAt)
  );
}

/** Live options of one proposal, in display order. Shared by every read that returns them. */
async function listLiveOptions(
  proposalId: string,
  exec: DbExecutor
): Promise<RescheduleProposalOption[]> {
  return exec
    .select()
    .from(rescheduleProposalOptions)
    .where(
      and(
        eq(rescheduleProposalOptions.proposalId, proposalId),
        isNull(rescheduleProposalOptions.deletedAt)
      )
    )
    .orderBy(asc(rescheduleProposalOptions.position));
}

/**
 * The shared body of `expireStaleForMeeting`, threaded onto whatever executor the caller is
 * already inside — so `propose` can run it as the FIRST statement of its own transaction
 * without opening a second one.
 */
async function expireStaleForMeetingTx(
  meetingId: string,
  now: Date,
  exec: DbExecutor
): Promise<number> {
  const rows = await exec
    .update(rescheduleProposals)
    .set({
      status: 'expired',
      // ⚠ `resolved_at = expires_at`, NOT `now`. The proposal lapsed WHEN THE DEADLINE
      // PASSED, not when a later write happened to notice; and the biconditional CHECK
      // demands a non-NULL `resolved_at` for any non-`pending` status. `resolved_by_user_id`
      // stays NULL — nobody acted (ADR-1030's system-actor attribution exemption).
      resolvedAt: sql`${rescheduleProposals.expiresAt}`,
      updatedAt: now,
    })
    .where(
      and(
        eq(rescheduleProposals.meetingId, meetingId),
        eq(rescheduleProposals.status, 'pending'),
        lte(rescheduleProposals.expiresAt, now),
        isNull(rescheduleProposals.deletedAt)
      )
    )
    .returning({ id: rescheduleProposals.id });
  return rows.length;
}

/**
 * `rescheduleProposalsRepository` (BAL-411) — the data-access layer for an expert-initiated
 * "can we move this to one of these times instead?" ask, and the four answers to it.
 *
 * POLICY-FREE BY CONSTRUCTION. `now`, `expiresAt` and every window arrive from the CALLER
 * (the `scheduledNotificationsRepository` / `listPendingAutoAccept(cutoff)` contract). This
 * file knows how to move a proposal between states; it does not know how long an ask lives,
 * who may make one, or whether the meeting is still reschedulable.
 *
 * ⚠ AUTHORIZATION IS THE CALLER'S, ON TWO AXES THAT ARE NEVER FOLDED (ADR-1029/ADR-1046):
 * propose/withdraw are ENGAGEMENT-axis (`manage_engagement`, the delivering expert ∪ their
 * agency owner/admin) and accept/decline are MEMBERSHIP-axis (`participate` on the client
 * company). Nothing in this file checks either, and nothing in it should: a gate inside a
 * repository would be the deviation, not the fix. The tenancy obligation on `meetingId` is
 * the one `schema/meeting-contexts.ts` documents.
 *
 * Every method takes `exec: DbExecutor = db` as its LAST, DEFAULTED argument, so an
 * `apps/api` caller can write a proposal and its BAL-420 reminder row in ONE transaction —
 * the outbox property that whole design depends on.
 *
 * Every read AND every write predicate filters `deleted_at IS NULL`.
 */
export const rescheduleProposalsRepository = {
  /**
   * Create one proposal and its 1..3 options, atomically.
   *
   * ⚠ `expireStaleForMeeting` RUNS FIRST, INSIDE THIS TRANSACTION, AND IT IS NOT AN
   * OPTIMISATION. `reschedule_proposal_one_pending_idx` cannot mention `now()` (not
   * IMMUTABLE), so a LAPSED proposal still occupies the meeting's pending slot. Without this
   * statement a meeting whose client later moved it forward (BAL-409) would carry a dead
   * `pending` row that blocks EVERY future proposal, permanently. It is also the only writer
   * of the `expired` label — which is what keeps that label producible rather than reserved.
   *
   * ⚠ NO `ON CONFLICT`. The arbiter would be a PARTIAL index, where a Drizzle `eq()` emits a
   * bind parameter that Postgres's predicate-implication prover cannot match, failing `42P10`
   * at runtime (memory `reference_pg_partial_index_arbiter_param_42p10`) — and folding would
   * silently hand back a proposal the caller never inspected. A genuine concurrent proposal
   * raises `23505`, which is caught here and re-thrown as the named
   * {@link RescheduleProposalAlreadyPendingError}.
   *
   * The whole body runs in `exec.transaction(…)`: a `Database` gets a real transaction and a
   * `Transaction` gets a SAVEPOINT, so the expected `23505` is CONTAINED. Raising it bare
   * inside a caller's transaction would poison it and leave every later statement failing
   * `25P02` (the `meetingContextsRepository.attach` precedent).
   */
  async propose(
    input: ProposeRescheduleInput,
    now: Date,
    exec: DbExecutor = db
  ): Promise<RescheduleProposalWithOptions> {
    if (input.options.length === 0) {
      // A proposal with nothing to accept is not an ask. The route rejects this at Zod
      // (`options` is `.min(1).max(3)`); this is the backstop the DB cannot express.
      throw new Error('A reschedule proposal must carry at least one option');
    }

    return exec.transaction(async (tx) => {
      await expireStaleForMeetingTx(input.meetingId, now, tx);

      try {
        const [proposal] = await tx
          .insert(rescheduleProposals)
          .values({
            meetingId: input.meetingId,
            proposedByUserId: input.proposedByUserId,
            originalScheduledStart: input.originalScheduledStart,
            expiresAt: input.expiresAt,
          })
          .returning();
        if (proposal === undefined) {
          throw new Error(`Failed to insert reschedule proposal for meeting: ${input.meetingId}`);
        }

        const options = await tx
          .insert(rescheduleProposalOptions)
          .values(
            input.options.map((option, position) => ({
              proposalId: proposal.id,
              // The array index IS the display order — see `ProposeRescheduleInput.options`.
              position,
              scheduledStart: option.scheduledStart,
              scheduledEnd: option.scheduledEnd,
            }))
          )
          .returning();

        return {
          proposal,
          options: [...options].sort((a, b) => a.position - b.position),
        };
      } catch (error) {
        if (isUniqueViolation(error, 'reschedule_proposal_one_pending_idx')) {
          throw new RescheduleProposalAlreadyPendingError(input.meetingId);
        }
        throw error;
      }
    });
  },

  /**
   * THE CASE-SURFACE READ — every PENDING, live proposal across a set of meetings, as a
   * projection.
   *
   * ⚠ PROJECTED COLUMNS ONLY, never a relational `with:` hydration: that hydrates FULL rows
   * (memory `reference_drizzle_with_hydration_leaks_secrets`), and this result crosses into a
   * client graph.
   *
   * ⚠ IT DOES NOT FILTER EXPIRY OR STALENESS, DELIBERATELY. Liveness is decided by ONE pure
   * function in `@balo/shared` (`rescheduleProposalIsLive`), so the loader and the nudge
   * cannot disagree about what "live" means; filtering here would put a second definition in
   * a second package with no `now` of its own to reason about. "Live" in this method's name
   * means NOT SOFT-DELETED.
   */
  async findLivePendingByMeetingIds(
    meetingIds: readonly string[],
    exec: DbExecutor = db
  ): Promise<LiveRescheduleProposalSummary[]> {
    if (meetingIds.length === 0) {
      return [];
    }
    return (
      exec
        .select({
          proposalId: rescheduleProposals.id,
          meetingId: rescheduleProposals.meetingId,
          originalScheduledStart: rescheduleProposals.originalScheduledStart,
          expiresAt: rescheduleProposals.expiresAt,
          // `count()` over the LEFT-joined live options. bigint on the wire ⇒ `mapWith(Number)`.
          optionCount: sql<number>`count(${rescheduleProposalOptions.id})`.mapWith(Number),
        })
        .from(rescheduleProposals)
        .leftJoin(
          rescheduleProposalOptions,
          and(
            eq(rescheduleProposalOptions.proposalId, rescheduleProposals.id),
            isNull(rescheduleProposalOptions.deletedAt)
          )
        )
        .where(
          and(
            inArray(rescheduleProposals.meetingId, [...meetingIds]),
            eq(rescheduleProposals.status, 'pending'),
            isNull(rescheduleProposals.deletedAt)
          )
        )
        // Grouping by the PRIMARY KEY is what lets the other `reschedule_proposals` columns be
        // selected un-aggregated (Postgres functional dependency).
        .groupBy(rescheduleProposals.id)
    );
  },

  /**
   * The answer path's read: one live proposal by `(proposalId, meetingId)`, with its live
   * options in display order.
   *
   * ⚠ THE NAME MARKS THE CALL SITE, NOT A `status` FILTER — AND THAT IS LOAD-BEARING. This
   * returns a proposal in ANY status (soft-deleted rows excepted), because its two consumers
   * must tell three facts apart that a `status = 'pending'` filter would collapse into one
   * `undefined`: the shared `resolveProposalAnswerRefusal` distinguishes `not_pending` from
   * `expired` from `stale`, and BAL-420's fire-time recheck must distinguish
   * `proposal_missing` from `proposal_answered`. Filtering here would make
   * `resolveProposalAnswerRefusal`'s `'not_pending'` arm unreachable — a state nothing can
   * produce, which is exactly the shape the case-surface rule forbids.
   *
   * ⚠ IT IS A READ, NOT A GATE. Answerability is enforced by the CAS in `accept` / `decline`
   * / `withdraw`, which re-checks `status` and `expires_at` at WRITE time; nothing may treat
   * a row returned here as permission to write.
   */
  async findPendingForAnswer(
    input: { proposalId: string; meetingId: string },
    exec: DbExecutor = db
  ): Promise<RescheduleProposalWithOptions | undefined> {
    const [proposal] = await exec
      .select()
      .from(rescheduleProposals)
      .where(
        and(
          eq(rescheduleProposals.id, input.proposalId),
          eq(rescheduleProposals.meetingId, input.meetingId),
          isNull(rescheduleProposals.deletedAt)
        )
      )
      .limit(1);
    if (proposal === undefined) {
      return undefined;
    }
    return { proposal, options: await listLiveOptions(proposal.id, exec) };
  },

  /**
   * CLIENT ACCEPTS ONE OPTION. `undefined` ⇒ the caller writes NOTHING and answers 409
   * `proposal_not_answerable`: the proposal was already answered, has lapsed, is
   * soft-deleted, belongs to another meeting, or the option is not one of its own.
   *
   * ⚠ THIS DOES NOT MOVE THE MEETING. It records the ANSWER; the caller then calls
   * `rescheduleMeeting`, and compensates with {@link revertAccept} if that fails (§D7 step
   * 9c). NEVER the reverse ordering: a committed move with a still-`pending` proposal invites
   * a second accept.
   *
   * ORDER INSIDE THE TRANSACTION IS DELIBERATE — the proposal CAS runs FIRST because it is
   * the serialisation point. Two concurrent accepts of DIFFERENT options both pass an
   * option-first write (different rows) and one would then have to be unwound; proposal-first
   * means the loser writes nothing at all.
   */
  async accept(
    input: AcceptRescheduleProposalInput,
    now: Date,
    exec: DbExecutor = db
  ): Promise<AcceptedRescheduleProposal | undefined> {
    try {
      return await exec.transaction(async (tx) => {
        const [proposal] = await tx
          .update(rescheduleProposals)
          .set({
            status: 'accepted',
            resolvedAt: now,
            resolvedByUserId: input.actorUserId,
            updatedAt: now,
          })
          .where(answerableProposal(input.proposalId, input.meetingId, now))
          .returning();
        if (proposal === undefined) {
          return undefined;
        }

        const [option] = await tx
          .update(rescheduleProposalOptions)
          .set({ acceptedAt: now, updatedAt: now })
          .where(
            and(
              eq(rescheduleProposalOptions.id, input.optionId),
              eq(rescheduleProposalOptions.proposalId, input.proposalId),
              isNull(rescheduleProposalOptions.deletedAt)
            )
          )
          .returning();
        if (option === undefined) {
          // ⚠ THE THROW IS THE ROLLBACK — see `RescheduleProposalOptionMissError`. An
          // accepted proposal with no accepted option would be a lie in the ledger, so the
          // CAS above must not survive.
          throw new RescheduleProposalOptionMissError();
        }

        return { proposal, option };
      });
    } catch (error) {
      if (error instanceof RescheduleProposalOptionMissError) {
        return undefined;
      }
      throw error;
    }
  },

  /**
   * THE §D7 STEP-9C COMPENSATOR: the answer was recorded but the meeting move failed, so
   * restore answerability. CAS `accepted → pending`; `undefined` ⇒ nothing to revert (it was
   * never accepted, something else already moved it, or the meeting's `scheduled_start` no
   * longer matches `expectedOriginalScheduledStart` — see the next paragraph).
   *
   * ⚠ FIX ROUND 1 ITEM 4(b) — SCOPED TO A GENUINE NO-OP. `rescheduleMeeting` can throw AFTER
   * its DB write has already committed (e.g. a post-commit availability-rebuild enqueue
   * failure), so "the move failed" is not always true — the meeting may already sit at the
   * NEW window. Reverting the proposal to `pending` in that case would make an
   * ALREADY-COMMITTED accept answerable again, and a second accept would write a second
   * `meeting.rescheduled` audit row and a second `booking.rescheduled` fan-out for one move.
   * Requiring `meetings.scheduled_start = expectedOriginalScheduledStart` — the anchor the
   * caller read BEFORE calling `rescheduleMeeting` — makes the revert a no-op whenever the
   * write actually landed, instead of relying on the ANSWER-time staleness check (which a
   * same-instant "reschedule" — an option equal to the meeting's own current start — would
   * pass, since `originalScheduledStart` and the post-move `scheduled_start` would be equal
   * too). Pairs with the `duplicate_option` propose-time refusal in
   * `routes/meetings/reschedule-proposals.ts`, which prevents that same-instant option from
   * ever being proposed in the first place; this is the second, independent half.
   *
   * ⚠ BOTH HALVES ARE MANDATORY. `resolved_at` must go back to NULL or the biconditional
   * CHECK refuses the write outright; and every option's `accepted_at` must be cleared or
   * `reschedule_proposal_option_accepted_idx` makes accepting a DIFFERENT option afterwards
   * fail `23505` — the proposal would read answerable and be unanswerable.
   *
   * ⚠ NOT GUARDED ON `expires_at`. A revert must work even if the deadline passed during the
   * failed move; the row returns to `pending` and the ordinary lazy-expiry rules apply.
   */
  async revertAccept(
    input: { proposalId: string; expectedOriginalScheduledStart: Date },
    exec: DbExecutor = db
  ): Promise<RescheduleProposal | undefined> {
    const now = new Date();
    return exec.transaction(async (tx) => {
      const [proposal] = await tx
        .update(rescheduleProposals)
        .set({ status: 'pending', resolvedAt: null, resolvedByUserId: null, updatedAt: now })
        .where(
          and(
            eq(rescheduleProposals.id, input.proposalId),
            eq(rescheduleProposals.status, 'accepted'),
            isNull(rescheduleProposals.deletedAt),
            exists(
              tx
                .select({ one: sql`1` })
                .from(meetings)
                .where(
                  and(
                    eq(meetings.id, rescheduleProposals.meetingId),
                    eq(meetings.scheduledStart, input.expectedOriginalScheduledStart)
                  )
                )
            )
          )
        )
        .returning();
      if (proposal === undefined) {
        return undefined;
      }

      await tx
        .update(rescheduleProposalOptions)
        .set({ acceptedAt: null, updatedAt: now })
        .where(
          and(
            eq(rescheduleProposalOptions.proposalId, input.proposalId),
            isNull(rescheduleProposalOptions.deletedAt)
          )
        );

      return proposal;
    });
  },

  /**
   * CLIENT KEEPS THEIR ORIGINAL TIME. `undefined` ⇒ 409 `proposal_not_answerable`.
   * Touches no `meetings` row, no `consultations` projection, no calendar and no money.
   */
  async decline(
    input: AnswerRescheduleProposalInput,
    now: Date,
    exec: DbExecutor = db
  ): Promise<RescheduleProposal | undefined> {
    const [proposal] = await exec
      .update(rescheduleProposals)
      .set({
        status: 'declined',
        resolvedAt: now,
        resolvedByUserId: input.actorUserId,
        updatedAt: now,
      })
      .where(answerableProposal(input.proposalId, input.meetingId, now))
      .returning();
    return proposal;
  },

  /**
   * THE EXPERT PULLS THEIR OWN ASK BACK. `undefined` ⇒ 409 `proposal_not_answerable` — which
   * on this path most often means THE CLIENT ALREADY ACCEPTED, and the same CAS is what
   * closes the withdraw-vs-accept and double-withdraw races.
   *
   * Publishes nothing and notifies nobody by design (§D5): withdrawing removes the client's
   * nudge, and a "never mind" email to a client who may never have looked is noise.
   */
  async withdraw(
    input: AnswerRescheduleProposalInput,
    now: Date,
    exec: DbExecutor = db
  ): Promise<RescheduleProposal | undefined> {
    const [proposal] = await exec
      .update(rescheduleProposals)
      .set({
        status: 'withdrawn',
        resolvedAt: now,
        resolvedByUserId: input.actorUserId,
        updatedAt: now,
      })
      .where(answerableProposal(input.proposalId, input.meetingId, now))
      .returning();
    return proposal;
  },

  /**
   * Mark every LAPSED pending proposal on one meeting `expired`, returning how many moved.
   * Zero is the normal case.
   *
   * ⚠ THIS IS THE INDEX'S MISSING HALF, NOT A SWEEP. It is called as the first statement of
   * `propose`'s transaction (and nowhere else in a background job): expiry is LAZY by
   * decision (§D1), so this exists only to free the meeting's pending slot for the next ask.
   * Exported in its own right so the write path can be driven — and asserted — directly.
   */
  async expireStaleForMeeting(
    meetingId: string,
    now: Date,
    exec: DbExecutor = db
  ): Promise<number> {
    return expireStaleForMeetingTx(meetingId, now, exec);
  },
};

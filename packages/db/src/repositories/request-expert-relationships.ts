import { and, desc, eq, isNull, ne } from 'drizzle-orm';
import { db } from '../client';
import {
  projectRequests,
  requestExpertRelationships,
  type RelationshipDeclineReason,
  type RequestExpertRelationship,
} from '../schema';
import { deriveRequestStatus } from './_shared/derive-request-status';
import type { DbExecutor } from './_shared/db-executor';
import { recordRelationshipTransition } from './_shared/relationship-audit';
import { conversationsRepository } from './conversations';
// ⚠ A DELIBERATE, BENIGN IMPORT CYCLE (`proposals.ts` imports `advanceRelationshipStatus`
// from here). Both directions import ONLY hoisted `function` declarations that are called
// from method bodies — never at module-evaluation time — so neither module reads a
// half-initialised binding from the other, in any evaluation order. It is the natural shape:
// a proposal advance moves the relationship spine, and `declineTrack` below ends the track's
// open proposals. The alternative (hoisting `PROPOSAL_STATUS_TRANSITIONS`, its guard, its
// error class and `advanceProposalStatus` into `_shared/`) was considered and rejected as a
// larger, unrelated refactor of a file this ticket otherwise barely touches.
import { advanceProposalStatus, lockOpenProposalsForRelationshipTx } from './proposals';
import type { DeclinableRelationshipStatus } from '@balo/shared/project-requests';

export type RelationshipStatus = RequestExpertRelationship['status'];

// ── Type-agreement pin (BAL-540 fix round) ────────────────────────────────
//
// ⚠ `@balo/shared/project-requests` RESTATES the four declinable stages (it must — a client
// island cannot value-import `@balo/db`; see that module's docblock). This assignment makes a
// drift a TYPE ERROR: if a stage named there ever stops being a real
// `request_expert_relationship_status`, `DeclinableRelationshipStatusAgreement` resolves to
// `never` and `true` is not assignable to it. The complementary VALUE-level proof — that the
// tuple is EXACTLY the set of sources carrying a `'declined'` edge in
// `RELATIONSHIP_STATUS_TRANSITIONS` below — is
// `invariants/declinable-statuses-match-the-transitions.test.ts`.
type DeclinableIsARelationshipStatus<A, B> = [A] extends [B] ? true : never;

export type DeclinableRelationshipStatusAgreement = DeclinableIsARelationshipStatus<
  DeclinableRelationshipStatus,
  RelationshipStatus
>;

export const declinableRelationshipStatusAgreement: DeclinableRelationshipStatusAgreement = true;

/**
 * Allowed per-expert relationship transitions. Linear advance with a terminal
 * `declined` branch reachable from every non-terminal state. `accepted` and
 * `declined` are terminal.
 */
export const RELATIONSHIP_STATUS_TRANSITIONS: Record<
  RelationshipStatus,
  readonly RelationshipStatus[]
> = {
  // BAL-315: an ADMIN may request a proposal directly from an `invited` expert
  // (full bypass — no client EOI required), so `proposal_requested` is reachable
  // from `invited`. The client path still requires `eoi_submitted` (enforced by
  // its `expectedFrom` guard, not this map).
  invited: ['eoi_submitted', 'proposal_requested', 'declined'],
  eoi_submitted: ['proposal_requested', 'declined'],
  proposal_requested: ['proposal_submitted', 'declined'],
  proposal_submitted: ['accepted', 'declined'],
  accepted: [],
  declined: [],
};

export function isAllowedRelationshipTransition(
  from: RelationshipStatus,
  to: RelationshipStatus
): boolean {
  return RELATIONSHIP_STATUS_TRANSITIONS[from].includes(to);
}

export class InvalidRelationshipTransitionError extends Error {
  constructor(
    public readonly from: RelationshipStatus,
    public readonly to: RelationshipStatus
  ) {
    super(`Invalid request_expert_relationship status transition: ${from} → ${to}`);
    this.name = 'InvalidRelationshipTransitionError';
  }
}

/**
 * Shared transition implementation. Locks the live relationship row FOR UPDATE,
 * validates against `RELATIONSHIP_STATUS_TRANSITIONS`, sets `declinedAt` when
 * advancing to `declined` and `proposalRequestedAt` when advancing to
 * `proposal_requested`, persists the relationship, THEN re-derives and (if it
 * changed) writes the parent `project_requests.status` — the centrally-derived
 * max-progress rollup over the request's live relationships (ADR-1025 /
 * BAL-295). Request + relationship therefore advance ATOMICALLY through a single
 * source of truth (`deriveRequestStatus`), so cross-table callers no longer
 * double-write the request status ad hoc. Exported so cross-table writers (EOI /
 * proposal submit, proposal accept) can advance the relationship inside their own
 * transaction atomically with their content insert.
 *
 * LOCK ORDER (BAL-295) — relationship row FIRST, then request row LAST. The
 * request (the shared aggregate every relationship rolls up into) is acquired as
 * the FINAL lock in every path that touches it, which keeps this consistent with
 * the documented order in `proposalsRepository.accept` (proposal → relationship →
 * request) and `promoteToSubmit` (relationship → request → proposal header):
 *  - `submit-eoi` / `request-proposal` paths: relationship → request.
 *  - `promoteToSubmit`: relationship → request (here) → proposal header.
 *  - `accept`: proposal → relationship → request (here).
 * Two concurrent advances on DIFFERENT relationships of the same request cannot
 * deadlock (disjoint relationship rows; one waits on the request lock the other
 * holds while holding nothing the other needs). The `FOR UPDATE` on the request
 * also serialises derivation: the later transaction re-reads the committed sibling
 * statuses and re-derives the true max, so concurrent advances can't lost-update
 * the rollup.
 *
 * The request write goes DIRECT (not via `isAllowedTransition` /
 * `projectRequestsRepository.transitionStatus`): the rollup is authoritative and
 * may legitimately differ from the single-step admin transition map. If the
 * request row is missing/soft-deleted the request update is SKIPPED (defensive —
 * a live relationship normally implies a live request); the relationship advance
 * still stands.
 *
 * ⚠ IT ALSO WRITES THE ATTRIBUTION AND THE AUDIT ROW (BAL-540 / ADR-1030, orchestrator D3).
 * `actorUserId` is REQUIRED on every arm, and a `→ declined` advance additionally stamps
 * `declined_by_user_id` + `decline_reason` IN THE SAME `.set()` as `declined_at`. One
 * `request_expert_relationship.*` audit row is appended LAST, inside this transaction, and its
 * id comes back in the result: it is the colon-free, per-WRITE `correlationId` BAL-540's
 * `project.track_declined` fan-out keys its BullMQ job on. The `AdvanceRelationshipInput` union
 * makes `reason` a compile-time requirement of the `declined` arm and impossible elsewhere.
 *
 * ⚠ THE RETURN IS A TRIPLE, NOT THE ROW (widened by BAL-540). `previousStatus` is read under
 * the same `FOR UPDATE` lock as the write, so it is provably the value the transition moved
 * from — callers that need "what stage did this track end at" (the decline notification's copy
 * selector) must not re-read it afterwards.
 *
 * `tx` is the active transaction (a Drizzle transaction client). Throws
 * `InvalidRelationshipTransitionError` for illegal moves / `expectedFrom`
 * mismatch and `Error` for a missing/soft-deleted relationship.
 */
/**
 * BAL-540 / ADR-1030 (orchestrator D3) — `advanceRelationshipStatus`'s input, DISCRIMINATED
 * ON `to` so `reason` is REQUIRED exactly when the destination is `declined` and
 * IMPOSSIBLE otherwise.
 *
 * ⚠ THE DISCRIMINATION IS THE POINT, not decoration. `declined_by_user_id` /
 * `decline_reason` are attribution columns, and the house rule
 * (`_shared/meeting-audit.ts`, `schema/meeting-presence.ts`) is that an attribution column
 * with no writer is a worse lie than its absence. A single optional `reason?` would let a
 * caller silently write a NULL reason onto a real decline; this shape makes that a compile
 * error. It also stops a non-decline caller from passing a reason that would be dropped.
 *
 * ⚠ `actorUserId` IS REQUIRED ON EVERY ARM. There is no system-actor exemption on this
 * path — every relationship transition has a human behind it (the expert, the client, Balo
 * staff, or whoever closed the request).
 */
export type AdvanceRelationshipInput =
  | {
      id: string;
      to: Exclude<RelationshipStatus, 'declined'>;
      expectedFrom?: RelationshipStatus;
      actorUserId: string;
    }
  | {
      id: string;
      to: 'declined';
      expectedFrom?: RelationshipStatus;
      actorUserId: string;
      reason: RelationshipDeclineReason;
    };

/** What one advance produced. Widened by BAL-540 from the bare row. */
export interface AdvanceRelationshipResult {
  relationship: RequestExpertRelationship;
  /** The status the row held BEFORE the write — read under the same `FOR UPDATE` lock. */
  previousStatus: RelationshipStatus;
  /**
   * The `request_expert_relationship.*` audit row's id. UNIQUE PER SUCCESSFUL TRANSITION
   * (`audit_events` is append-only) and colon-free, so BAL-540's `project.track_declined`
   * fan-out can use it as the notification `correlationId` — per WRITE, never per STATE.
   */
  auditId: string;
}

export async function advanceRelationshipStatus(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  input: AdvanceRelationshipInput
): Promise<AdvanceRelationshipResult> {
  const [current] = await tx
    .select()
    .from(requestExpertRelationships)
    .where(
      and(eq(requestExpertRelationships.id, input.id), isNull(requestExpertRelationships.deletedAt))
    )
    .for('update');

  if (current === undefined) {
    throw new Error(`Request expert relationship not found: ${input.id}`);
  }

  if (input.expectedFrom !== undefined && current.status !== input.expectedFrom) {
    throw new InvalidRelationshipTransitionError(current.status, input.to);
  }

  if (!isAllowedRelationshipTransition(current.status, input.to)) {
    throw new InvalidRelationshipTransitionError(current.status, input.to);
  }

  const previousStatus = current.status;

  const [updated] = await tx
    .update(requestExpertRelationships)
    .set({
      status: input.to,
      // ⚠ ALL THREE DECLINE COLUMNS IN ONE STATEMENT (BAL-540 / D3). WHEN, WHO and WHY move
      // together or not at all — a second UPDATE could be interleaved by a future edit and
      // leave a declined row with no attribution.
      ...(input.to === 'declined'
        ? {
            declinedAt: new Date(),
            declinedByUserId: input.actorUserId,
            declineReason: input.reason,
          }
        : {}),
      ...(input.to === 'proposal_requested' ? { proposalRequestedAt: new Date() } : {}),
    })
    .where(eq(requestExpertRelationships.id, input.id))
    .returning();

  if (updated === undefined) {
    throw new Error(`Failed to update request expert relationship: ${input.id}`);
  }

  // ── Request-level rollup (ADR-1025 / BAL-295) ────────────────────────────
  // Lock the parent request row LAST (see LOCK ORDER above), then re-read ALL
  // live relationship statuses AFTER the lock — the just-updated row already
  // reflects `input.to`, so the rollup sees a consistent committed-or-pending set.
  const [request] = await tx
    .select({ status: projectRequests.status })
    .from(projectRequests)
    .where(and(eq(projectRequests.id, updated.projectRequestId), isNull(projectRequests.deletedAt)))
    .for('update');

  // Defensive: a missing/soft-deleted request → skip the rollup (the relationship
  // advance still stands). A live relationship normally implies a live request.
  if (request !== undefined) {
    const liveStatuses = await tx
      .select({ status: requestExpertRelationships.status })
      .from(requestExpertRelationships)
      .where(
        and(
          eq(requestExpertRelationships.projectRequestId, updated.projectRequestId),
          isNull(requestExpertRelationships.deletedAt)
        )
      );

    const derived = deriveRequestStatus(
      liveStatuses.map((r) => r.status),
      request.status
    );

    if (derived !== request.status) {
      // DIRECT write (mirrors `transitionStatus`: set only `status`; `updatedAt` is
      // auto-managed). NOT routed through `isAllowedTransition` — the rollup is the
      // authoritative source of truth and may differ from the single-step admin map.
      await tx
        .update(projectRequests)
        .set({ status: derived })
        .where(eq(projectRequests.id, updated.projectRequestId));
    }
  }

  // ── Audit (BAL-540 / ADR-1030, D3) ───────────────────────────────────────
  // LAST, after every write this transition performs. An audit row left behind by a
  // rolled-back transition would attest to a status change that never happened —
  // `meetingsRepository.cancel`'s rule, verbatim.
  const auditId = await recordRelationshipTransition(tx, {
    actorUserId: input.actorUserId,
    relationshipId: updated.id,
    projectRequestId: updated.projectRequestId,
    from: previousStatus,
    to: input.to,
    ...(input.to === 'declined' ? { declineReason: input.reason } : {}),
  });

  return { relationship: updated, previousStatus, auditId };
}

/**
 * BAL-431 / ADR-1048 §5 (Ruling 2) — AWARD CLOSURE. Stamp `not_selected_at` on every LIVE,
 * not-already-closed relationship of a request EXCEPT the winner.
 *
 * ⚠ EXPORTED SO `materializeFromKickoff` RUNS IT INSIDE ITS OWN TRANSACTION. Closure and
 * lineage are ONE hook, both effects, so a rolled-back kickoff closes nobody. It is NOT
 * called from `proposalsRepository.accept` — that path creates no engagement, and a second
 * write site is exactly the "two mechanisms" Ruling 2 forbids. (The resulting kickoff-window
 * divergence from `deriveThreadStage` is accepted in OSD-5 and documented on the column.)
 *
 * ⚠ FILE PLANE ONLY IN THIS PR. Messages, meetings and the thread stage are NOT adopted onto
 * this predicate (standing constraint 3).
 *
 * IDEMPOTENT — `not_selected_at IS NULL` is in the WHERE, so a replayed kickoff is a no-op
 * and never re-stamps a LATER instant over an earlier one (historical-read is an inequality
 * against that instant, so re-stamping would silently WIDEN access).
 *
 * ALREADY-DECLINED ROWS ARE EXCLUDED, deliberately. `resolveRequestTrackFileAccess` takes the
 * EARLIEST of the three instants, so stamping a declined row would be harmless — but leaving
 * it unstamped keeps "earliest instant" honest at the source rather than relying on the
 * reducer to undo a write we chose to make.
 *
 * NO AUDIT EVENT. Closure is a derived consequence of `engagement.created`, which is already
 * audited in the same transaction, and Ruling 4's contract names four FILE actions, not five.
 * Returns the stamped ids so the caller can `log.info` the count.
 */
export async function markNotSelectedByAward(
  tx: DbExecutor,
  input: { projectRequestId: string; winningRelationshipId: string; at: Date }
): Promise<string[]> {
  const stamped = await tx
    .update(requestExpertRelationships)
    // ⚠ A MAPPED `.set()`, NOT A RAW `sql` TEMPLATE. A `Date` inside a raw `sql` template
    // throws at bind time; typecheck stays green and only an integration test catches it
    // (memory `reference_date_in_raw_sql_template_throws`).
    .set({ notSelectedAt: input.at, updatedAt: input.at })
    .where(
      and(
        eq(requestExpertRelationships.projectRequestId, input.projectRequestId),
        ne(requestExpertRelationships.id, input.winningRelationshipId),
        isNull(requestExpertRelationships.deletedAt),
        isNull(requestExpertRelationships.notSelectedAt),
        isNull(requestExpertRelationships.declinedAt),
        ne(requestExpertRelationships.status, 'declined')
      )
    )
    .returning({ id: requestExpertRelationships.id });

  return stamped.map((row) => row.id);
}

/** BAL-540 — what one deliberate track decline produced. */
export interface DeclineTrackResult {
  relationship: RequestExpertRelationship;
  /** The stage the track ended at — picks the decline notice's copy. Read under the lock. */
  previousStatus: RelationshipStatus;
  /** The `request_expert_relationship.declined` audit row id: the fan-out's correlationId. */
  declineAuditId: string;
  /** The proposals this decline ended. Empty when the track had none open. */
  declinedProposalIds: string[];
  hadOpenProposal: boolean;
}

/**
 * BAL-540 — the target request is CLOSED, so no new track may be opened on it. Thrown by
 * {@link requestExpertRelationshipsRepository.invite} from inside its transaction, so nothing
 * is inserted and no conversation is provisioned.
 *
 * ⚠ THIS IS THE AUTHORITATIVE GUARD, not the UI's, and it FAILS CLOSED. `invite-experts.ts`'s
 * `INVITE_WINDOW_STATUSES` pre-check on the already-loaded request excludes `closed` and gives
 * the stale-UI copy without a round trip; a close committing between that check and the insert
 * still lands here.
 *
 * ⚠ NO CONSUMER BRANCHES ON THIS TYPE YET, and the docblock used to claim one did.
 * `invite-experts.ts` does not import it — a race therefore surfaces as that action's generic
 * failure copy rather than a specific "This request has been closed". That is a COPY gap, not
 * a correctness gap (the invite is refused either way); wiring the `catch` arm is a follow-up.
 * Named rather than a bare `Error` so that follow-up can branch on a TYPE instead of
 * string-matching, and so `repositories/index.ts` can re-export it for that purpose.
 */
export class RequestClosedError extends Error {
  constructor(public readonly projectRequestId: string) {
    super(`Project request ${projectRequestId} is closed: no expert may be invited to it.`);
    this.name = 'RequestClosedError';
  }
}

export const requestExpertRelationshipsRepository = {
  /**
   * Admin invites an expert → creates an `invited` relationship row.
   *
   * Returns `undefined` when a LIVE relationship for this (request, expert)
   * already exists: the partial unique index
   * (`request_expert_relationship_unique_idx WHERE deleted_at IS NULL`) is the
   * `ON CONFLICT` arbiter, so a live duplicate is a clean DO-NOTHING no-op (the
   * caller treats it as an idempotent skip) rather than a thrown 23505 — which
   * means a genuine failure (FK / connection) still throws and is never masked.
   * A previously REMOVED (soft-deleted) expert is outside the partial index, so
   * re-inviting them inserts a fresh `invited` row.
   *
   * ⚠ THE CONVERSATION IS PROVISIONED EAGERLY, IN THIS TRANSACTION (BAL-424). Lazy creation
   * would leave the Ably token action with nothing to grant a channel on until the first
   * message existed, so the FIRST message of every thread would be invisible to the
   * counterparty until their 15-minute token refreshed. One row per relationship, written
   * once, closes that. Nothing is provisioned on the conflict (no-op) branch — that
   * relationship already has its thread.
   *
   * ⚠ SOFT-DELETING A RELATIONSHIP DOES NOT TOUCH ITS CONVERSATION, DELIBERATELY.
   * `softDelete` means "removed from the request's invite list"; the history stays, and the
   * read path already gates on `isThreadOpenStatus`. Re-inviting the same expert inserts a
   * FRESH relationship row (the partial unique permits it), which gets a FRESH conversation
   * — the old thread is not resurrected. That matches the pre-BAL-424 behaviour, where
   * messages keyed to the dead relationship id.
   */
  async invite(input: {
    projectRequestId: string;
    expertProfileId: string;
    invitedByUserId: string;
  }): Promise<RequestExpertRelationship | undefined> {
    return db.transaction(async (tx) => {
      // ⚠ BAL-540 — REFUSE A CLOSED REQUEST, UNDER THE REQUEST LOCK. Without this, an admin
      // invite racing a close leaves an `invited` track on a `closed` request that the
      // cascade's snapshot never saw and nothing ever declines. Taking the REQUEST lock and
      // then INSERTING introduces NO new deadlock pair: no relationship row is locked here,
      // so this path can never hold a relationship lock while waiting on the request lock
      // (the inversion `advanceRelationshipStatus`'s LOCK ORDER block guards against).
      // A missing / soft-deleted request is left to the FK and the existing behaviour.
      const [request] = await tx
        .select({ status: projectRequests.status })
        .from(projectRequests)
        .where(
          and(eq(projectRequests.id, input.projectRequestId), isNull(projectRequests.deletedAt))
        )
        .for('update');
      if (request?.status === 'closed') {
        throw new RequestClosedError(input.projectRequestId);
      }

      const [row] = await tx
        .insert(requestExpertRelationships)
        .values({
          projectRequestId: input.projectRequestId,
          expertProfileId: input.expertProfileId,
          invitedByUserId: input.invitedByUserId,
        })
        .onConflictDoNothing({
          target: [
            requestExpertRelationships.projectRequestId,
            requestExpertRelationships.expertProfileId,
          ],
          // The arbiter is the PARTIAL unique index, so its predicate must be given.
          where: isNull(requestExpertRelationships.deletedAt),
        })
        .returning();

      if (row !== undefined) {
        await conversationsRepository.ensureForContext(
          { contextType: 'relationship', contextId: row.id },
          tx
        );
      }
      return row;
    });
  },

  /**
   * Soft-delete a live relationship (admin "remove invited expert"). Sets
   * `deletedAt` (and touches `updatedAt`, mirroring `usersRepository.softDelete`
   * / `calendarRepository.softDeleteConnection`). Filters `deletedAt IS NULL` so
   * it is idempotent — re-removing an already-removed row is a no-op that returns
   * `undefined`. The removed relationship then disappears from `listByRequest`
   * and `findByIdWithRelations` (both filter `deletedAt IS NULL`).
   */
  async softDelete(id: string): Promise<RequestExpertRelationship | undefined> {
    const [updated] = await db
      .update(requestExpertRelationships)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(
        and(eq(requestExpertRelationships.id, id), isNull(requestExpertRelationships.deletedAt))
      )
      .returning();
    return updated;
  },

  /** Live relationship by id (guards `deletedAt`). */
  async findById(id: string): Promise<RequestExpertRelationship | undefined> {
    return db.query.requestExpertRelationships.findFirst({
      where: and(
        eq(requestExpertRelationships.id, id),
        isNull(requestExpertRelationships.deletedAt)
      ),
    });
  },

  /** All live relationships for a request, newest-invited first. */
  async listByRequest(projectRequestId: string): Promise<RequestExpertRelationship[]> {
    return db
      .select()
      .from(requestExpertRelationships)
      .where(
        and(
          eq(requestExpertRelationships.projectRequestId, projectRequestId),
          isNull(requestExpertRelationships.deletedAt)
        )
      )
      .orderBy(desc(requestExpertRelationships.invitedAt));
  },

  /**
   * BAL-283 (Ruling 3) — stamp "the expert shared availability on this thread, NOW", and
   * report what the column said BEFORE. Returns `undefined` when there is no live row
   * (missing, or soft-deleted = the expert was removed from the invite list).
   *
   * BOTH HALVES OF THE RETURN MATTER. `previousSharedAt` is the ONLY input to the flat 24h
   * re-notify window the notification rule applies (the engine has no cooldown primitive and
   * no last-sent store, so the state has to come from here), and it is what `is_reshare` is
   * derived from. `null` ⇒ this was the first share.
   *
   * ⚠ ONE TRANSACTION WITH `FOR UPDATE`, NOT TWO STATEMENTS. Two tabs clicking "Share again"
   * a second apart must not BOTH read `previousSharedAt: null` and both be judged a first
   * share — that is precisely the double-email the throttle exists to prevent. Drizzle cannot
   * express `UPDATE … RETURNING old.col`, so the lock is what makes the read-then-write
   * atomic. `.for('update')` mirrors `projectRequestsRepository.transitionStatus`.
   *
   * ⚠ THIS IS A PURE STAMP: no status transition, no rollup, no notification. Sharing
   * availability is not a lifecycle event — the relationship stays exactly where it was, and
   * the client picking a slot later runs the ordinary `request_interaction` booking path.
   * Publishing the domain event is the caller's (feature code publishes; the engine delivers).
   */
  async stampAvailabilityShared(
    id: string
  ): Promise<{ previousSharedAt: Date | null; sharedAt: Date } | undefined> {
    return db.transaction(async (tx) => {
      const [current] = await tx
        .select({ availabilitySharedAt: requestExpertRelationships.availabilitySharedAt })
        .from(requestExpertRelationships)
        .where(
          and(eq(requestExpertRelationships.id, id), isNull(requestExpertRelationships.deletedAt))
        )
        .for('update');

      if (current === undefined) {
        return undefined;
      }

      const now = new Date();
      const [updated] = await tx
        .update(requestExpertRelationships)
        .set({ availabilitySharedAt: now, updatedAt: now })
        .where(eq(requestExpertRelationships.id, id))
        .returning({ availabilitySharedAt: requestExpertRelationships.availabilitySharedAt });

      // Read the PERSISTED instant back rather than trusting `now`: the caller puts this
      // value in a notification payload and in the `correlationId` that keys BullMQ's dedup,
      // so it must be the value a later read of this row will agree with.
      const sharedAt = updated?.availabilitySharedAt;
      if (sharedAt === undefined || sharedAt === null) {
        throw new Error(`Failed to stamp availability_shared_at on relationship: ${id}`);
      }

      return { previousSharedAt: current.availabilitySharedAt, sharedAt };
    });
  },

  /**
   * Advance a single relationship's per-expert status with validation against
   * `RELATIONSHIP_STATUS_TRANSITIONS`. Sets `declinedAt` / `declinedByUserId` /
   * `declineReason` when `to='declined'` and `proposalRequestedAt` when
   * `to='proposal_requested'`, and appends the `request_expert_relationship.*` audit row —
   * all in ONE transaction. Optional `expectedFrom` optimistic guard. Throws
   * `InvalidRelationshipTransitionError`.
   *
   * ⚠ FOR A DELIBERATE DECLINE, PREFER {@link declineTrack} — it ALSO ends the track's open
   * proposals. This wrapper flips only the relationship, which is correct for the four
   * forward transitions and would leave a `submitted` proposal dangling on a declined track.
   */
  async transitionStatus(input: AdvanceRelationshipInput): Promise<AdvanceRelationshipResult> {
    return db.transaction((tx) => advanceRelationshipStatus(tx, input));
  },

  /**
   * BAL-540 — DECLINE ONE TRACK: the client says no to this expert, or Balo says it on their
   * behalf. ONE transaction: the track's open proposals are locked, the relationship is
   * advanced to `declined` (which stamps WHO/WHY/WHEN, re-derives the parent request status
   * and appends the audit row), then each locked proposal is flipped to `declined`.
   *
   * ⚠ LOCK ORDER — PROPOSAL → RELATIONSHIP → REQUEST, the order `proposalsRepository.accept`
   * documents and every writer that touches both must preserve. That is why the proposals are
   * LOCKED (step 1) before `advanceRelationshipStatus` runs (step 2) even though they are not
   * WRITTEN until step 3: taking the proposal locks after the relationship lock would invert
   * the order against `accept` and open an AB/BA deadlock class.
   *
   * ⚠ `withdrawn` vs `declined` — THE DISTINCTION IS DELIBERATE AND LOAD-BEARING.
   * `declined` here means the CLIENT SIDE judged this proposal and said no. The BAL-540 close
   * cascade uses `withdrawn` for the same rows, because there the request ended and nobody
   * judged anything. Both are terminal; only the reader-facing copy differs.
   *
   * ⚠ NO MEETING CANCELLATION (plan deviation V2). The ticket's decline bullet does not ask
   * for one and CLAUDE.md's ADR-1046 summary is explicit that the declined-track host denial
   * "answers at call time only: it voids no already-booked call and runs no cascade or sweep".
   * Residual, stated rather than hidden: a `scheduled` `request_interaction` call on a
   * declined track survives and becomes unhostable at join time. A CLOSE does cancel.
   *
   * ⚠ NO FILE-GRANT REVOCATION (orchestrator D9). `resolveRequestTrackFileAccess`
   * (`@balo/shared/authz`) already returns `{ kind: 'closed', closedAt }` = HISTORICAL READ
   * for a `declined` track, keyed off the `status` / `declined_at` this path stamps. The file
   * plane flips for free; calling `revokeGrant` here would DESTROY the historical read
   * ADR-1048 guarantees. Proved by test, not by code.
   *
   * Throws `InvalidRelationshipTransitionError` from a terminal track (`accepted` /
   * `declined`) — nothing is written.
   */
  async declineTrack(input: {
    relationshipId: string;
    actorUserId: string;
    /** `request_closed` is NOT accepted here — that reason belongs to the close cascade. */
    reason: Exclude<RelationshipDeclineReason, 'request_closed'>;
  }): Promise<DeclineTrackResult> {
    return db.transaction(async (tx) => {
      // 1. Proposal rows FIRST (lock order — see the docblock).
      const openProposals = await lockOpenProposalsForRelationshipTx(tx, input.relationshipId);

      // 2. Relationship, then request (the request lock is taken inside).
      const advanced = await advanceRelationshipStatus(tx, {
        id: input.relationshipId,
        to: 'declined',
        actorUserId: input.actorUserId,
        reason: input.reason,
      });

      // 3. End each open proposal. Already locked in step 1, so `advanceProposalStatus`'s own
      //    `FOR UPDATE` re-take is free and its transition guard still runs.
      const declinedProposalIds: string[] = [];
      for (const proposal of openProposals) {
        await advanceProposalStatus(tx, { id: proposal.id, to: 'declined' });
        declinedProposalIds.push(proposal.id);
      }

      return {
        relationship: advanced.relationship,
        previousStatus: advanced.previousStatus,
        declineAuditId: advanced.auditId,
        declinedProposalIds,
        hadOpenProposal: declinedProposalIds.length > 0,
      };
    });
  },
};

import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from '../client';
import {
  projectRequests,
  requestExpertRelationships,
  type RequestExpertRelationship,
} from '../schema';
import { deriveRequestStatus } from './_shared/derive-request-status';

export type RelationshipStatus = RequestExpertRelationship['status'];

/**
 * Allowed per-expert relationship transitions. Linear advance with a terminal
 * `declined` branch reachable from every non-terminal state. `accepted` and
 * `declined` are terminal.
 */
export const RELATIONSHIP_STATUS_TRANSITIONS: Record<
  RelationshipStatus,
  readonly RelationshipStatus[]
> = {
  invited: ['eoi_submitted', 'declined'],
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
 * `tx` is the active transaction (a Drizzle transaction client). Throws
 * `InvalidRelationshipTransitionError` for illegal moves / `expectedFrom`
 * mismatch and `Error` for a missing/soft-deleted relationship.
 */
export async function advanceRelationshipStatus(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  input: {
    id: string;
    to: RelationshipStatus;
    expectedFrom?: RelationshipStatus;
  }
): Promise<RequestExpertRelationship> {
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

  const [updated] = await tx
    .update(requestExpertRelationships)
    .set({
      status: input.to,
      ...(input.to === 'declined' ? { declinedAt: new Date() } : {}),
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

  return updated;
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
   */
  async invite(input: {
    projectRequestId: string;
    expertProfileId: string;
    invitedByUserId: string;
  }): Promise<RequestExpertRelationship | undefined> {
    const [row] = await db
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
    return row;
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
   * Advance a single relationship's per-expert status with validation against
   * `RELATIONSHIP_STATUS_TRANSITIONS`. Sets `declinedAt` when `to='declined'`
   * and `proposalRequestedAt` when `to='proposal_requested'`. Optional
   * `expectedFrom` optimistic guard. Throws
   * `InvalidRelationshipTransitionError`.
   */
  async transitionStatus(input: {
    id: string;
    to: RelationshipStatus;
    expectedFrom?: RelationshipStatus;
  }): Promise<RequestExpertRelationship> {
    return db.transaction((tx) => advanceRelationshipStatus(tx, input));
  },
};

import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from '../client';
import { requestExpertRelationships, type RequestExpertRelationship } from '../schema';

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
 * advancing to `declined`, then persists. Exported so cross-table writers (EOI /
 * proposal submit, proposal accept) can advance the relationship inside their own
 * transaction atomically with their content insert.
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
    })
    .where(eq(requestExpertRelationships.id, input.id))
    .returning();

  if (updated === undefined) {
    throw new Error(`Failed to update request expert relationship: ${input.id}`);
  }

  return updated;
}

export const requestExpertRelationshipsRepository = {
  /**
   * Admin invites an expert → creates an `invited` relationship row. The unique
   * `(project_request_id, expert_profile_id)` index rejects a duplicate invite.
   */
  async invite(input: {
    projectRequestId: string;
    expertProfileId: string;
    invitedByUserId: string;
  }): Promise<RequestExpertRelationship> {
    const [row] = await db
      .insert(requestExpertRelationships)
      .values({
        projectRequestId: input.projectRequestId,
        expertProfileId: input.expertProfileId,
        invitedByUserId: input.invitedByUserId,
      })
      .returning();
    if (row === undefined) {
      throw new Error('Failed to create request expert relationship');
    }
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
   * `RELATIONSHIP_STATUS_TRANSITIONS`. Sets `declinedAt` when `to='declined'`.
   * Optional `expectedFrom` optimistic guard. Throws
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

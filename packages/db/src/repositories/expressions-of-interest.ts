import { and, asc, eq, isNull } from 'drizzle-orm';
import { db } from '../client';
import {
  expressionsOfInterest,
  requestExpertRelationships,
  type ExpressionOfInterest,
} from '../schema';
import {
  advanceRelationshipStatus,
  InvalidRelationshipTransitionError,
} from './request-expert-relationships';

export const expressionsOfInterestRepository = {
  /**
   * Expert submits an EOI for a relationship. In ONE transaction: insert the EOI
   * row AND advance the relationship `invited`→`eoi_submitted` (via the
   * relationship transition validation, which locks the row FOR UPDATE). The
   * denormalised `project_request_id`/`expert_profile_id` are read FROM the
   * (locked) relationship row, never trusted from the caller. Returns the EOI.
   *
   * BOUNDARY (ADR-1025 / BAL-295): advancing the relationship here ALSO advances
   * the request-level status via `deriveRequestStatus` inside
   * `advanceRelationshipStatus`, in the SAME transaction. The request rollup is no
   * longer caller-owned — the web action must NOT separately
   * `transitionStatus(experts_invited → eoi_submitted)`; it only re-reads the now
   * coherent stored status to source its `transitioned` flag.
   */
  async submit(input: { relationshipId: string; message: string }): Promise<ExpressionOfInterest> {
    return db.transaction(async (tx) => {
      // Lock + validate-advance the relationship; throws if it isn't `invited`
      // (or is missing/soft-deleted) → whole txn rolls back, no orphan EOI.
      const relationship = await advanceRelationshipStatus(tx, {
        id: input.relationshipId,
        to: 'eoi_submitted',
        expectedFrom: 'invited',
      });

      const [row] = await tx
        .insert(expressionsOfInterest)
        .values({
          relationshipId: relationship.id,
          projectRequestId: relationship.projectRequestId,
          expertProfileId: relationship.expertProfileId,
          message: input.message,
        })
        .returning();
      if (row === undefined) {
        throw new Error('Failed to create expression of interest');
      }
      return row;
    });
  },

  /**
   * Withdraw the live EOI for a relationship (expert "withdraw"). Soft-deletes the
   * EOI row (sets `deletedAt`, touches `updatedAt`). Filters `deletedAt IS NULL` so
   * it is idempotent — re-withdrawing returns `undefined`. Does NOT touch the
   * relationship or request status (no reverse state machine — see plan §4): the
   * expert keeps participant access and may resubmit (the now-freed PARTIAL unique
   * slot lets `resubmit()` insert a fresh EOI). Mirrors
   * `requestExpertRelationshipsRepository.softDelete`. Returns the soft-deleted
   * row, or `undefined` when there was no live EOI.
   */
  async withdraw(input: { relationshipId: string }): Promise<ExpressionOfInterest | undefined> {
    const [updated] = await db
      .update(expressionsOfInterest)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(expressionsOfInterest.relationshipId, input.relationshipId),
          isNull(expressionsOfInterest.deletedAt)
        )
      )
      .returning();
    return updated;
  },

  /**
   * Resubmit an EOI after a prior withdrawal. The relationship is already
   * `eoi_submitted` (withdraw never reverts it — plan §4), so this ONLY inserts a
   * fresh EOI — NO relationship transition. In ONE transaction it row-locks the
   * relationship FOR UPDATE and asserts it is live + `eoi_submitted`, asserts there
   * is NO live EOI, then inserts deriving `projectRequestId`/`expertProfileId` FROM
   * the locked relationship row (never from the caller). Symmetric with `submit()`
   * but with no `invited→eoi_submitted` advance. Throws
   * `InvalidRelationshipTransitionError` when the relationship is not
   * `eoi_submitted`, and `Error` for a missing/soft-deleted relationship or when a
   * live EOI already exists.
   */
  async resubmit(input: {
    relationshipId: string;
    message: string;
  }): Promise<ExpressionOfInterest> {
    return db.transaction(async (tx) => {
      // Lock the live relationship for the duration of the txn (serialises a
      // concurrent submit/resubmit on the same relationship).
      const [relationship] = await tx
        .select()
        .from(requestExpertRelationships)
        .where(
          and(
            eq(requestExpertRelationships.id, input.relationshipId),
            isNull(requestExpertRelationships.deletedAt)
          )
        )
        .for('update');

      if (relationship === undefined) {
        throw new Error(`Request expert relationship not found: ${input.relationshipId}`);
      }

      // Resubmit is only valid once the relationship has already reached
      // `eoi_submitted` (a first EOI goes through `submit()` instead). Reuse the
      // relationship transition error for a consistent typed failure.
      if (relationship.status !== 'eoi_submitted') {
        throw new InvalidRelationshipTransitionError(relationship.status, 'eoi_submitted');
      }

      // Guard against a live EOI already existing (defense-in-depth alongside the
      // partial unique index, which would otherwise throw a raw 23505).
      const existingLive = await tx
        .select({ id: expressionsOfInterest.id })
        .from(expressionsOfInterest)
        .where(
          and(
            eq(expressionsOfInterest.relationshipId, relationship.id),
            isNull(expressionsOfInterest.deletedAt)
          )
        )
        .for('update');
      if (existingLive.length > 0) {
        throw new Error(
          `A live expression of interest already exists for relationship: ${relationship.id}`
        );
      }

      const [row] = await tx
        .insert(expressionsOfInterest)
        .values({
          relationshipId: relationship.id,
          projectRequestId: relationship.projectRequestId,
          expertProfileId: relationship.expertProfileId,
          message: input.message,
        })
        .returning();
      if (row === undefined) {
        throw new Error('Failed to create expression of interest');
      }
      return row;
    });
  },

  /** Live EOI for a relationship (one per relationship). */
  async findByRelationship(relationshipId: string): Promise<ExpressionOfInterest | undefined> {
    return db.query.expressionsOfInterest.findFirst({
      where: and(
        eq(expressionsOfInterest.relationshipId, relationshipId),
        isNull(expressionsOfInterest.deletedAt)
      ),
    });
  },

  /** All live EOIs for a request, oldest-submitted first. */
  async listByRequest(projectRequestId: string): Promise<ExpressionOfInterest[]> {
    return db
      .select()
      .from(expressionsOfInterest)
      .where(
        and(
          eq(expressionsOfInterest.projectRequestId, projectRequestId),
          isNull(expressionsOfInterest.deletedAt)
        )
      )
      .orderBy(asc(expressionsOfInterest.submittedAt));
  },
};

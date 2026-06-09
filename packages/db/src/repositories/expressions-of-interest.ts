import { and, asc, eq, isNull } from 'drizzle-orm';
import { db } from '../client';
import { expressionsOfInterest, type ExpressionOfInterest } from '../schema';
import { advanceRelationshipStatus } from './request-expert-relationships';

export const expressionsOfInterestRepository = {
  /**
   * Expert submits an EOI for a relationship. In ONE transaction: insert the EOI
   * row AND advance the relationship `invited`→`eoi_submitted` (via the
   * relationship transition validation, which locks the row FOR UPDATE). The
   * denormalised `project_request_id`/`expert_profile_id` are read FROM the
   * (locked) relationship row, never trusted from the caller. Returns the EOI.
   *
   * BOUNDARY: this does NOT advance the request-level status. The caller (web
   * action) calls `projectRequestsRepository.transitionStatus` for the
   * `experts_invited`→`eoi_submitted` request-level move only on the FIRST EOI —
   * request-level aggregation stays explicit and caller-owned.
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

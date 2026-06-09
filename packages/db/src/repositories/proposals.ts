import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { db } from '../client';
import { proposals, type Proposal } from '../schema';
import { advanceRelationshipStatus } from './request-expert-relationships';

export const proposalsRepository = {
  /**
   * Expert submits a proposal for a relationship. In ONE transaction: insert the
   * proposal (status `submitted`) AND advance the relationship
   * `proposal_requested`→`proposal_submitted`. Denormalised request/expert ids
   * are read FROM the (locked) relationship row, not trusted from the caller.
   * `priceCents` is integer minor units; `currency` defaults to `aud`.
   *
   * BOUNDARY: does NOT advance request-level status — caller-owned.
   */
  async submit(input: {
    relationshipId: string;
    scope: string;
    priceCents: number;
    currency?: string;
  }): Promise<Proposal> {
    return db.transaction(async (tx) => {
      const relationship = await advanceRelationshipStatus(tx, {
        id: input.relationshipId,
        to: 'proposal_submitted',
        expectedFrom: 'proposal_requested',
      });

      const [row] = await tx
        .insert(proposals)
        .values({
          relationshipId: relationship.id,
          projectRequestId: relationship.projectRequestId,
          expertProfileId: relationship.expertProfileId,
          scope: input.scope,
          priceCents: input.priceCents,
          ...(input.currency !== undefined ? { currency: input.currency } : {}),
        })
        .returning();
      if (row === undefined) {
        throw new Error('Failed to create proposal');
      }
      return row;
    });
  },

  /** Live proposal by id. */
  async findById(id: string): Promise<Proposal | undefined> {
    return db.query.proposals.findFirst({
      where: and(eq(proposals.id, id), isNull(proposals.deletedAt)),
    });
  },

  /** All live proposals for a request, newest-submitted first. */
  async listByRequest(projectRequestId: string): Promise<Proposal[]> {
    return db
      .select()
      .from(proposals)
      .where(and(eq(proposals.projectRequestId, projectRequestId), isNull(proposals.deletedAt)))
      .orderBy(desc(proposals.submittedAt));
  },

  /** All live proposals for a relationship, oldest-submitted first (revision order). */
  async listByRelationship(relationshipId: string): Promise<Proposal[]> {
    return db
      .select()
      .from(proposals)
      .where(and(eq(proposals.relationshipId, relationshipId), isNull(proposals.deletedAt)))
      .orderBy(asc(proposals.submittedAt));
  },

  /**
   * Client accepts a proposal. In ONE transaction: proposal status→`accepted`
   * (set `acceptedAt`) AND relationship `proposal_submitted`→`accepted`.
   *
   * BOUNDARY: does NOT touch request-level status and creates NO
   * delivery/engagement record (the delivery epic owns that). The method's scope
   * is exactly these two updates.
   *
   * LOCK ORDER: proposal row first, then the relationship row (via
   * `advanceRelationshipStatus`). Any future writer that locks both must preserve
   * this order to avoid a deadlock cycle.
   */
  async accept(input: { id: string }): Promise<Proposal> {
    return db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(proposals)
        .where(and(eq(proposals.id, input.id), isNull(proposals.deletedAt)))
        .for('update');

      if (current === undefined) {
        throw new Error(`Proposal not found: ${input.id}`);
      }

      // Advance the relationship first (locks + validates the spine state).
      await advanceRelationshipStatus(tx, {
        id: current.relationshipId,
        to: 'accepted',
        expectedFrom: 'proposal_submitted',
      });

      const [updated] = await tx
        .update(proposals)
        .set({ status: 'accepted', acceptedAt: new Date() })
        .where(eq(proposals.id, input.id))
        .returning();
      if (updated === undefined) {
        throw new Error(`Failed to accept proposal: ${input.id}`);
      }
      return updated;
    });
  },
};

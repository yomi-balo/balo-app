import { and, asc, eq, isNull } from 'drizzle-orm';
import { db } from '../client';
import { proposalMilestones, type ProposalMilestone } from '../schema';

/** One milestone in a `setForProposal` replace-all set. `sortOrder` is assigned by
 *  the repo (= array index), so callers supply ordering by array position only. */
export interface ProposalMilestoneInput {
  title: string;
  descriptionHtml?: string | null;
  acceptanceCriteria?: string | null;
  /** Fixed-only deliverable value (integer minor units); null/undefined for T&M. */
  valueCents?: number | null;
}

export const proposalMilestonesRepository = {
  /**
   * Replace-all the milestone set for a proposal in ONE transaction: soft-delete
   * the existing LIVE rows, then insert the new ordered set with
   * `sortOrder = index`. Matches the composer's "edit the whole list" model — the
   * caller always sends the complete intended list, never a partial patch. Returns
   * the new live rows in order. An empty input clears the set (soft-deletes all,
   * inserts nothing).
   *
   * BOUNDARY: does NOT enforce milestone-value sum vs `priceCents` — that is a
   * submit-time repo/Zod rule (drafts are partial).
   */
  async setForProposal(input: {
    proposalId: string;
    milestones: ProposalMilestoneInput[];
  }): Promise<ProposalMilestone[]> {
    return db.transaction(async (tx) => {
      await tx
        .update(proposalMilestones)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(proposalMilestones.proposalId, input.proposalId),
            isNull(proposalMilestones.deletedAt)
          )
        );

      if (input.milestones.length === 0) {
        return [];
      }

      const rows = await tx
        .insert(proposalMilestones)
        .values(
          input.milestones.map((m, index) => ({
            proposalId: input.proposalId,
            sortOrder: index,
            title: m.title,
            descriptionHtml: m.descriptionHtml ?? null,
            acceptanceCriteria: m.acceptanceCriteria ?? null,
            valueCents: m.valueCents ?? null,
          }))
        )
        .returning();
      return rows;
    });
  },

  /** Live milestones for a proposal, ordered by `sortOrder` asc (ties by `id`). */
  async listByProposal(proposalId: string): Promise<ProposalMilestone[]> {
    return db
      .select()
      .from(proposalMilestones)
      .where(
        and(eq(proposalMilestones.proposalId, proposalId), isNull(proposalMilestones.deletedAt))
      )
      .orderBy(asc(proposalMilestones.sortOrder), asc(proposalMilestones.id));
  },
};

import { and, asc, eq, isNull } from 'drizzle-orm';
import { db } from '../client';
import { proposalMilestones, type ProposalMilestone } from '../schema';

/** Active transaction handle (matches `advanceProposalStatus` in proposals.ts). */
type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** One milestone in a `setForProposal` replace-all set. `sortOrder` is assigned by
 *  the repo (= array index), so callers supply ordering by array position only. */
export interface ProposalMilestoneInput {
  title: string;
  descriptionHtml?: string | null;
  acceptanceCriteria?: string | null;
  /** Fixed-only deliverable value (integer minor units); null/undefined for T&M. */
  valueCents?: number | null;
  /** T&M-only estimated effort in minutes (integer); null/undefined when not
   *  estimated or for Fixed. Mirrors `valueCents` (the two are mutually exclusive by
   *  pricing method — BAL-294). */
  estimatedMinutes?: number | null;
}

/**
 * Insert an ordered milestone set (`sortOrder = index`) for a proposal within an
 * EXISTING transaction. Empty input is a no-op (returns `[]`). Returns the inserted
 * rows. Exported so a caller (e.g. `proposalsRepository.resubmit`) can write a
 * proposal's children INSIDE the same transaction that creates the header row —
 * keeping header + children atomic. `setForProposal` reuses this so the INSERT
 * logic lives in exactly one place.
 */
export async function insertMilestonesTx(
  tx: DbTx,
  proposalId: string,
  milestones: ProposalMilestoneInput[]
): Promise<ProposalMilestone[]> {
  if (milestones.length === 0) {
    return [];
  }
  return tx
    .insert(proposalMilestones)
    .values(
      milestones.map((m, index) => ({
        proposalId,
        sortOrder: index,
        title: m.title,
        descriptionHtml: m.descriptionHtml ?? null,
        acceptanceCriteria: m.acceptanceCriteria ?? null,
        valueCents: m.valueCents ?? null,
        estimatedMinutes: m.estimatedMinutes ?? null,
      }))
    )
    .returning();
}

/**
 * Live milestones for a proposal within an EXISTING transaction, ordered by
 * `sortOrder` asc (ties by `id`) — the `Tx` variant of
 * `proposalMilestonesRepository.listByProposal`. Exported so a caller (e.g.
 * `proposalsRepository.promoteToSubmit`/`accept`) can RE-READ a proposal's live
 * children INSIDE the same transaction that holds the proposal's `FOR UPDATE` lock,
 * for transition-time coherence assembly. Mirrors the `insertMilestonesTx` `Tx`
 * primitive + `db`-convenience-method split.
 */
export async function listByProposalTx(tx: DbTx, proposalId: string): Promise<ProposalMilestone[]> {
  return tx
    .select()
    .from(proposalMilestones)
    .where(and(eq(proposalMilestones.proposalId, proposalId), isNull(proposalMilestones.deletedAt)))
    .orderBy(asc(proposalMilestones.sortOrder), asc(proposalMilestones.id));
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

      return insertMilestonesTx(tx, input.proposalId, input.milestones);
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

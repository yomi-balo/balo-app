import { and, asc, eq, isNull } from 'drizzle-orm';
import { db } from '../client';
import { proposalPaymentInstallments, type ProposalPaymentInstallment } from '../schema';

/** Active transaction handle (matches `advanceProposalStatus` in proposals.ts). */
type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** One installment in a `setForProposal` replace-all set. `sortOrder` is assigned
 *  by the repo (= array index). `pct` is a whole percent (0–100). */
export interface ProposalPaymentInstallmentInput {
  label: string;
  pct: number;
}

/**
 * Insert an ordered installment set (`sortOrder = index`) for a proposal within an
 * EXISTING transaction. Empty input is a no-op (returns `[]`). Returns the inserted
 * rows. Exported so a caller (e.g. `proposalsRepository.resubmit`) can write a
 * proposal's children INSIDE the same transaction that creates the header row —
 * keeping header + children atomic. `setForProposal` reuses this so the INSERT
 * logic lives in exactly one place.
 */
export async function insertInstallmentsTx(
  tx: DbTx,
  proposalId: string,
  installments: ProposalPaymentInstallmentInput[]
): Promise<ProposalPaymentInstallment[]> {
  if (installments.length === 0) {
    return [];
  }
  return tx
    .insert(proposalPaymentInstallments)
    .values(
      installments.map((i, index) => ({
        proposalId,
        sortOrder: index,
        label: i.label,
        pct: i.pct,
      }))
    )
    .returning();
}

/**
 * Pure helper: do the installment percentages sum EXACTLY to 100? Integer sum, so
 * there is no float rounding. A6.2's submit action calls this to gate Fixed-price
 * submission; A6.1 does NOT block inserts on it (drafts are partial — the per-row
 * 0–100 CHECK is the only DB backstop). An empty list is not 100 → false.
 */
export function installmentsSumTo100(installments: Array<{ pct: number }>): boolean {
  const total = installments.reduce((sum, i) => sum + i.pct, 0);
  return total === 100;
}

export const proposalPaymentInstallmentsRepository = {
  /**
   * Replace-all the payment-installment set for a proposal in ONE transaction:
   * soft-delete the existing LIVE rows, then insert the new ordered set with
   * `sortOrder = index`. Mirrors `proposalMilestonesRepository.setForProposal` —
   * the caller sends the complete intended list. Returns the new live rows in
   * order. Empty input clears the set.
   *
   * BOUNDARY: does NOT enforce sum-to-100 (use `installmentsSumTo100` at submit
   * time). The per-row 0–100 CHECK is the DB backstop.
   */
  async setForProposal(input: {
    proposalId: string;
    installments: ProposalPaymentInstallmentInput[];
  }): Promise<ProposalPaymentInstallment[]> {
    return db.transaction(async (tx) => {
      await tx
        .update(proposalPaymentInstallments)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(proposalPaymentInstallments.proposalId, input.proposalId),
            isNull(proposalPaymentInstallments.deletedAt)
          )
        );

      return insertInstallmentsTx(tx, input.proposalId, input.installments);
    });
  },

  /** Live installments for a proposal, ordered by `sortOrder` asc (ties by `id`). */
  async listByProposal(proposalId: string): Promise<ProposalPaymentInstallment[]> {
    return db
      .select()
      .from(proposalPaymentInstallments)
      .where(
        and(
          eq(proposalPaymentInstallments.proposalId, proposalId),
          isNull(proposalPaymentInstallments.deletedAt)
        )
      )
      .orderBy(asc(proposalPaymentInstallments.sortOrder), asc(proposalPaymentInstallments.id));
  },
};

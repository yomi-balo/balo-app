import { db } from '../../client';
import { proposalPaymentInstallments } from '../../schema';
import type { ProposalPaymentInstallment, NewProposalPaymentInstallment } from '../../schema';
import { proposalFactory, type ProposalFactoryResult } from './proposal.factory';

interface ProposalPaymentInstallmentFactoryOverrides {
  /** Reuse an existing proposal instead of seeding a fresh one. */
  proposal?: ProposalFactoryResult;
  /** Row-level overrides (label, pct, sortOrder, deletedAt, …). */
  values?: Partial<NewProposalPaymentInstallment>;
}

export interface ProposalPaymentInstallmentFactoryResult {
  installment: ProposalPaymentInstallment;
  proposalId: string;
}

/**
 * Seeds a single `proposal_payment_installments` row (under a fresh proposal by
 * default). Defaults to a 100%-upfront installment at `sortOrder` 0. Overrides
 * flow through `.values(...)`.
 */
export async function proposalPaymentInstallmentFactory(
  overrides: ProposalPaymentInstallmentFactoryOverrides = {}
): Promise<ProposalPaymentInstallmentFactoryResult> {
  const proposal = overrides.proposal ?? (await proposalFactory());

  const [installment] = await db
    .insert(proposalPaymentInstallments)
    .values({
      proposalId: proposal.proposal.id,
      sortOrder: 0,
      label: 'Upfront',
      pct: 100,
      ...overrides.values,
    })
    .returning();
  if (installment === undefined) {
    throw new Error('proposal payment installment insert failed');
  }

  return { installment, proposalId: proposal.proposal.id };
}

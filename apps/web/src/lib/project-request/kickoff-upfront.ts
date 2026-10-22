import 'server-only';
import {
  proposalsRepository,
  proposalPaymentInstallmentsRepository,
  type Proposal,
} from '@balo/db';
import { applyBaloFee } from '@balo/shared/pricing';
import { upfrontDueCents } from '@balo/shared/project-requests';
import type { KickoffUpfront } from './request-detail-view';

/** A resolved upfront amount — never withheld on the server (see `KickoffUpfront`). */
export type ResolvedKickoffUpfront = KickoffUpfront & { amountCents: number };

/**
 * What `proposal` makes due before kickoff, or `null` when nothing is. Fixed proposals
 * read their installments (the first one is due upfront); T&M needs only the deposit.
 *
 * The amount is the CLIENT's fee-inclusive figure — the invoice is raised to the client,
 * and it must equal the accept modal's "Due now", which grosses up the total and deposit
 * the same way (`hydrateReviewDoc`'s client audience) before taking the first
 * installment. It is a client price: never render it to the expert lens.
 */
export async function upfrontForProposal(
  proposal: Proposal
): Promise<ResolvedKickoffUpfront | null> {
  const installments =
    proposal.pricingMethod === 'fixed'
      ? await proposalPaymentInstallmentsRepository.listByProposal(proposal.id)
      : [];
  const fee = (cents: number): number => applyBaloFee(cents, proposal.baloFeeBps);
  const amountCents = upfrontDueCents({
    pricingMethod: proposal.pricingMethod,
    priceCents: fee(proposal.priceCents),
    depositCents: proposal.depositCents === null ? null : fee(proposal.depositCents),
    installments,
  });
  return amountCents > 0 ? { amountCents, currency: proposal.currency } : null;
}

/** {@link upfrontForProposal} for the accepted relationship's current proposal. */
export async function loadKickoffUpfront(
  acceptedRelationshipId: string
): Promise<ResolvedKickoffUpfront | null> {
  const proposal = await proposalsRepository.findCurrentByRelationship(acceptedRelationshipId);
  if (proposal === undefined) return null;
  return upfrontForProposal(proposal);
}

import 'server-only';
import {
  companyBillingRepository,
  proposalsRepository,
  proposalMilestonesRepository,
  proposalPaymentInstallmentsRepository,
} from '@balo/db';
import {
  mapAdminKickoffBillingView,
  type AdminKickoffBillingView,
} from './admin-kickoff-billing-view';

/**
 * BAL-324 — server loader for the admin kickoff billing panel. Keeps repository
 * calls out of the component (reads flow through repositories only). Resolves the
 * company's billing details and the accepted relationship's current proposal in
 * parallel; only when a proposal exists does it fetch its milestones + installments
 * (a second parallel pair). Shapes everything through the pure
 * {@link mapAdminKickoffBillingView}. Mirrors the existing `loadReviewDoc` pattern.
 */
export async function loadAdminKickoffBilling(
  companyId: string,
  acceptedRelationshipId: string
): Promise<AdminKickoffBillingView> {
  const [billing, proposal] = await Promise.all([
    companyBillingRepository.findByCompanyId(companyId),
    proposalsRepository.findCurrentByRelationship(acceptedRelationshipId),
  ]);

  if (proposal === undefined) {
    return mapAdminKickoffBillingView(billing, null, [], []);
  }

  const [milestones, installments] = await Promise.all([
    proposalMilestonesRepository.listByProposal(proposal.id),
    proposalPaymentInstallmentsRepository.listByProposal(proposal.id),
  ]);

  return mapAdminKickoffBillingView(billing, proposal, milestones, installments);
}

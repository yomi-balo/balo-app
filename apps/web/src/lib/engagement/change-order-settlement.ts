import 'server-only';

import { engagementChangeOrdersRepository } from '@balo/db';
import { deriveProjectSettlement, type ProjectSettlement } from '@balo/shared/engagements';
import { applyBaloFee } from '@balo/shared/pricing';
import { upfrontDueCents } from '@balo/shared/project-requests';

/**
 * The project's settlement: what the client was invoiced up front, what the approved change
 * orders did to the price, and the final invoice that remains. Staff and the approve action
 * read it; the client and expert view models never do.
 *
 * The upfront figure is the CLIENT's fee-inclusive amount, derived the same way the kickoff
 * checklist and the repository's kickoff gate derive it (`upfrontDueCents` over the grossed-up
 * price and deposit), always against the ACCEPTED price: a later change order does not move
 * what was invoiced at kickoff.
 */
export async function loadProjectSettlement(engagementId: string): Promise<ProjectSettlement> {
  const terms = await engagementChangeOrdersRepository.settlementTermsFor(engagementId);
  const fee = (cents: number): number => applyBaloFee(cents, terms.baloFeeBps);
  const upfrontDueClientCents = upfrontDueCents({
    pricingMethod: terms.pricingMethod,
    priceCents: fee(terms.acceptedPriceCents),
    depositCents: terms.depositCents === null ? null : fee(terms.depositCents),
    installments: terms.installments,
  });
  return deriveProjectSettlement({
    acceptedPriceCents: terms.acceptedPriceCents,
    approvedDeltasInOrder: terms.approvedDeltas.map((delta) => delta.priceDeltaCents),
    baloFeeBps: terms.baloFeeBps,
    upfrontDueClientCents,
  });
}

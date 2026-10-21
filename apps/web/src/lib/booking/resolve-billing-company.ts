import 'server-only';

import { partyMembershipsRepository } from '@balo/db';
import { CAPABILITIES } from '@/lib/authz';

/** Resolve which company bills this booking (Decision 5's fail-closed IDOR guard). */
export async function resolveBillingCompanyId(
  userId: string,
  requestedCompanyId: string | undefined
): Promise<
  | { ok: true; companyId: string }
  | {
      ok: false;
      code: 'no_eligible_company' | 'company_selection_required' | 'company_not_eligible';
    }
> {
  const eligible = await partyMembershipsRepository.listCapabilityEligibleCompanies(
    userId,
    CAPABILITIES.CONSUME_CREDITS
  );
  if (eligible.length === 0) {
    return { ok: false, code: 'no_eligible_company' };
  }
  if (eligible.length > 1) {
    if (requestedCompanyId === undefined) {
      return { ok: false, code: 'company_selection_required' };
    }
    const match = eligible.find((company) => company.id === requestedCompanyId);
    if (match === undefined) {
      return { ok: false, code: 'company_not_eligible' };
    }
    return { ok: true, companyId: match.id };
  }
  const [only] = eligible;
  if (only === undefined) {
    // Unreachable (length === 1 above), guarded rather than asserted for
    // `noUncheckedIndexedAccess`.
    return { ok: false, code: 'no_eligible_company' };
  }
  return { ok: true, companyId: only.id };
}

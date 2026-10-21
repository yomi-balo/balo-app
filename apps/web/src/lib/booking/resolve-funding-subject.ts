import 'server-only';

import { authorizeCaseAttach } from './authorize-case-attach';
import { resolveBillingCompanyId } from './resolve-billing-company';

/** The part of a booking request that decides which company is billed. */
export interface FundingSubjectRequest {
  readonly expertProfileId: string;
  readonly caseChoice:
    | { readonly kind: 'new'; readonly companyId?: string }
    | { readonly kind: 'existing'; readonly engagementId: string };
}

export type FundingSubject =
  | { readonly ok: true; readonly companyId: string; readonly expertProfileId: string }
  | { readonly ok: false };

/**
 * The (company, expert) pair a booking's funding is evaluated for, resolved WITHOUT writing
 * anything and through the same two gates the submit uses. The client's claims are inputs, never
 * answers: an `existing` case is authorized by {@link authorizeCaseAttach} and the pair is read
 * off the case row; a `new` case bills the company {@link resolveBillingCompanyId} proves the
 * actor may bill. Any refusal collapses to `{ ok: false }`, so the pre-flight and the Save action
 * reveal nothing about why (no existence or eligibility oracle).
 */
export async function resolveFundingSubject(
  userId: string,
  request: FundingSubjectRequest
): Promise<FundingSubject> {
  if (request.caseChoice.kind === 'existing') {
    const attach = await authorizeCaseAttach({
      actorUserId: userId,
      engagementId: request.caseChoice.engagementId,
      expertProfileId: request.expertProfileId,
    });
    if (!attach.ok) {
      return { ok: false };
    }
    return { ok: true, companyId: attach.companyId, expertProfileId: attach.expertProfileId };
  }

  const company = await resolveBillingCompanyId(userId, request.caseChoice.companyId);
  if (!company.ok) {
    return { ok: false };
  }
  return { ok: true, companyId: company.companyId, expertProfileId: request.expertProfileId };
}

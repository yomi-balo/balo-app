import 'server-only';

import { hasCapability, CAPABILITIES } from '@/lib/authz';
import type { SessionUser } from '@/lib/auth/session';
import { authorizeCaseMutation, type CaseMutationGate } from './authorize-case-mutation';

/**
 * Fix round 2 item 2 — THE SHARED MEMBERSHIP-AXIS (client-lens) PREAMBLE for the case-surface
 * mutations only the CLIENT may perform: reschedule, accept a proposal, decline a proposal.
 * `reschedule-consultation.ts` and `respond-to-reschedule-proposal.ts` each carried a
 * byte-identical copy of this gate — `authorizeCaseMutation`, the `lens !== 'client'` check, then
 * `hasCapability(user, CAPABILITIES.PARTICIPATE, { companyId })` — varying only in the
 * caller-specific `deniedMessage` copy.
 *
 * ⚠ CLIENT-LENS AXIS ONLY. `propose-reschedule.ts`'s EXPERT-lens sibling checks a DIFFERENT
 * axis (`hasEngagementCapability` / `MANAGE_ENGAGEMENT`, the ENGAGEMENT axis) and is
 * deliberately NOT folded in here — the two axes have different holder sets and different
 * gates (CLAUDE.md's authorization model); merging them would blur that distinction for a
 * resemblance that is only skin-deep.
 *
 * N1 — `lens` alone is never authorization (CLAUDE.md bans gating on `lens ===` alone); this
 * helper always pairs it with the actual `PARTICIPATE` membership-axis check.
 */
export type ClientCaseMutationGate =
  | {
      ok: true;
      companyId: string;
      expertProfileId: string;
      caseRow: Extract<CaseMutationGate, { ok: true }>['caseRow'];
    }
  | { ok: false; error: string };

export async function authorizeClientCaseMutation(
  engagementId: string,
  user: SessionUser,
  deniedMessage: string
): Promise<ClientCaseMutationGate> {
  const gate = await authorizeCaseMutation({ engagementId });
  if (!gate.ok) {
    return { ok: false, error: gate.error };
  }
  if (gate.lens !== 'client') {
    return { ok: false, error: deniedMessage };
  }
  const { companyId, expertProfileId, caseRow } = gate;

  const allowed = await hasCapability(user, CAPABILITIES.PARTICIPATE, { companyId });
  if (!allowed) {
    return { ok: false, error: deniedMessage };
  }

  return { ok: true, companyId, expertProfileId, caseRow };
}

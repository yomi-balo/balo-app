'use server';

import 'server-only';

import { requireOnboardedUser } from '@/lib/auth/session';
import { runAcceptProposal, NOT_SIGNED_IN } from './_shared/accept-proposal-core';
import type { AcceptProposalInput, AcceptProposalResult } from './_shared/accept-proposal-core';

export type {
  AcceptProposalInput,
  AcceptProposalResult,
  ProposalCoherenceFailure,
} from './_shared/accept-proposal-core';

/**
 * Client accepts a submitted proposal (A6.4 / BAL-289) — the CLIENT mirror of the
 * expert's submit action. Commits the status flip through the EXISTING
 * `proposalsRepository.accept` (proposal `submitted → accepted` + relationship
 * `proposal_submitted → accepted` + the derived request rollup `proposal_submitted
 * → accepted`, all one tx — ADR-1025 / BAL-295), re-sources the `transitioned`
 * flag from the stored column, then publishes the client→expert acceptance
 * notification (fire-and-forget).
 *
 * Control flow: requireOnboardedUser → validate input → `resolveConversationAccess`
 * (denies non-participants and foreign relationship ids) → CLIENT-lens gate →
 * re-load + verify the proposal (live, `submitted`, current, belongs to this
 * relationship) → `accept` (typed transition errors → friendly stale copy) →
 * re-source the `transitioned` flag → log → notify → revalidate → return.
 */
export async function acceptProposalAction(
  input: AcceptProposalInput
): Promise<AcceptProposalResult> {
  let user;
  try {
    user = await requireOnboardedUser();
  } catch {
    return { success: false, error: NOT_SIGNED_IN };
  }

  return runAcceptProposal(user, input);
}

'use server';

import 'server-only';

import { requireOnboardedUser } from '@/lib/auth/session';
import { runSubmitProposal, NOT_SIGNED_IN } from './_shared/submit-proposal-core';
import type { SubmitProposalInput, SubmitProposalResult } from './_shared/submit-proposal-core';

export type {
  SubmitProposalInput,
  SubmitProposalResult,
  ProposalCoherenceFailure,
} from './_shared/submit-proposal-core';

/**
 * Expert submits their built proposal (A6.2 / BAL-288) — the draft→submitted
 * commit. Trusts the SERVER-PERSISTED draft as the submit content (the client
 * flushes a final autosave before opening the confirm dialog, decided Q2): the
 * action re-reads the persisted milestones/installments, re-validates readiness
 * server-side, re-sanitises every rich-text field, re-persists, then promotes.
 *
 * Transactional ordering (per the plan, steps 5-14): load+verify the draft →
 * re-read children → readiness → sanitise → persist (`updateDraft` +
 * `setForProposal` ×2) → `promoteToSubmit` (relationship + proposal spine + the
 * derived request rollup, all in one tx — ADR-1025 / BAL-295) → re-source the
 * `transitioned` flag from the stored column → publish the client notification
 * (fire-and-forget) → revalidate → return analytics for the island.
 *
 * Expert-lens guarded; `resolveConversationAccess` denies non-participants and
 * foreign relationship ids. A stale double-submit maps to friendly copy.
 */
export async function submitProposalAction(
  input: SubmitProposalInput
): Promise<SubmitProposalResult> {
  let user;
  try {
    user = await requireOnboardedUser();
  } catch {
    return { success: false, error: NOT_SIGNED_IN };
  }

  return runSubmitProposal(user, input);
}

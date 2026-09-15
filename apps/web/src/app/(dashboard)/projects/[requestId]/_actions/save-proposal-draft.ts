'use server';

import 'server-only';

import { requireOnboardedUser } from '@/lib/auth/session';
import { runSaveProposalDraft, NOT_SIGNED_IN } from './_shared/save-proposal-draft-core';
import type {
  SaveProposalDraftInput,
  SaveProposalDraftResult,
} from './_shared/save-proposal-draft-core';

export type {
  SaveProposalDraftInput,
  SaveProposalDraftResult,
} from './_shared/save-proposal-draft-core';

/**
 * Autosave the expert's current `draft` proposal for a relationship (A6.2 /
 * BAL-288). Create-or-update: if no current proposal exists yet → `createDraft`,
 * else → `updateDraft`; then replace-all the milestone + installment sets via
 * their `setForProposal` repos. Returns the draft's `proposalId` so the composer
 * can persist it in state and update-in-place on the next autosave.
 *
 * Best-effort by design (the composer never blocks typing on it): on a stale
 * autosave landing AFTER submit, `updateDraft` throws `ProposalNotDraftError` —
 * we warn-log it and return friendly stale-UI copy rather than corrupting a
 * submitted proposal. `ProposalTrackNotOpenError` (BAL-540 fix round: the track was
 * declined, or its request closed, before this autosave landed) is the same shape of
 * expected-stale event and reuses the SAME `STALE_DRAFT` string — no new user-facing
 * copy, and no `log.error` noise for a state the server is right to refuse. Expert-lens guarded (mirrors `request-proposal.ts`'s
 * client guard); `resolveConversationAccess` denies non-participants / foreign
 * relationship ids.
 */
export async function saveProposalDraftAction(
  input: SaveProposalDraftInput
): Promise<SaveProposalDraftResult> {
  let user;
  try {
    user = await requireOnboardedUser();
  } catch {
    return { success: false, error: NOT_SIGNED_IN };
  }

  return runSaveProposalDraft(user, input);
}

'use server';

import 'server-only';

import { requireOnboardedUser } from '@/lib/auth/session';
import type { ProposalDraftGenerationView } from '@/lib/project-request/proposal/proposal-draft-types';
import {
  runStartProposalDraft,
  type StartProposalDraftInput,
} from './_shared/proposal-draft-generation';

/**
 * Start the one automatic AI draft for an expert's first composer open (BAL-611). Idempotent
 * per relationship: a second call (another tab, a StrictMode double mount, a revisit) returns
 * the existing generation's view and makes no second model call.
 *
 * Fails soft: an unauthenticated caller reads as `skipped`, so the composer simply renders
 * blank. The expert-side gate and every other check live in `runStartProposalDraft`.
 */
export async function startProposalDraftAction(
  input: StartProposalDraftInput
): Promise<ProposalDraftGenerationView> {
  let user;
  try {
    user = await requireOnboardedUser();
  } catch {
    return { status: 'skipped' };
  }

  return runStartProposalDraft(user, input);
}

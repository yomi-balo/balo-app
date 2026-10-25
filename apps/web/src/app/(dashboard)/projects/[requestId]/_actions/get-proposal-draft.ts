'use server';

import 'server-only';

import { requireOnboardedUser } from '@/lib/auth/session';
import type { ProposalDraftGenerationView } from '@/lib/project-request/proposal/proposal-draft-types';
import {
  runGetProposalDraft,
  type GetProposalDraftInput,
} from './_shared/proposal-draft-generation';

/**
 * Poll a proposal draft generation (BAL-611). The view it returns is already sanitised: raw
 * model output never reaches the browser. An unauthenticated caller reads as `failed`, the
 * same answer a foreign or missing generation id gets.
 */
export async function getProposalDraftAction(
  input: GetProposalDraftInput
): Promise<ProposalDraftGenerationView> {
  let user;
  try {
    user = await requireOnboardedUser();
  } catch {
    return { status: 'failed' };
  }

  return runGetProposalDraft(user, input);
}

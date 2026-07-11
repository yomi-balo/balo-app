'use server';

import 'server-only';

import { z } from 'zod';
import { proposalsRepository } from '@balo/db';
import { requireOnboardedUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { resolveConversationAccess } from '@/lib/project-request/resolve-conversation-access';
import {
  PROPOSAL_DOCUMENT_ALLOWED_CONTENT_TYPES,
  createPresignedProposalDocumentUpload,
} from '@/lib/storage/proposal-document';

const inputSchema = z.object({
  requestId: z.uuid(),
  relationshipId: z.uuid(),
  proposalId: z.uuid(),
  kind: z.enum(['terms', 'ref']),
  contentType: z.string().min(1).max(255),
  fileName: z.string().trim().min(1).max(255),
});

export type RequestProposalDocumentUploadInput = z.infer<typeof inputSchema>;

export type RequestProposalDocumentUploadResult =
  | { success: true; presignedUrl: string; key: string }
  | { success: false; error: string };

const NOT_SIGNED_IN = 'You are not signed in.';
const INVALID_REQUEST = 'Invalid request.';
const ONLY_EXPERT = 'Only the expert can attach proposal documents.';
const STALE_PROPOSAL = 'This proposal can no longer be edited.';
const UNSUPPORTED_TYPE = 'This file type is not supported.';
const GENERIC_FAILURE = "Attaching documents isn't available right now.";

/**
 * Presign a PUT for one proposal document (A6.2 / BAL-288, step 1 of
 * presign → PUT → confirm). Guards: expert lens, the proposal belongs to the
 * VALIDATED relationship, and the proposal is still a live `draft` (no edits
 * after submit). The key is scoped to the validated proposal + the session user
 * — never client-supplied. `kind` carries through to the confirm/insert.
 */
export async function requestProposalDocumentUploadAction(
  input: RequestProposalDocumentUploadInput
): Promise<RequestProposalDocumentUploadResult> {
  let user;
  try {
    user = await requireOnboardedUser();
  } catch {
    return { success: false, error: NOT_SIGNED_IN };
  }

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: INVALID_REQUEST };
  }
  const { requestId, relationshipId, proposalId, contentType } = parsed.data;

  try {
    const access = await resolveConversationAccess(user, requestId, relationshipId);
    if (!access.ok) {
      return { success: false, error: access.error };
    }
    if (access.ctx.lens !== 'expert') {
      return { success: false, error: ONLY_EXPERT };
    }

    // The proposal must belong to this relationship and still be an editable draft.
    const proposal = await proposalsRepository.findById(proposalId);
    if (
      proposal === undefined ||
      proposal.relationshipId !== relationshipId ||
      proposal.status !== 'draft'
    ) {
      return { success: false, error: STALE_PROPOSAL };
    }

    if (!PROPOSAL_DOCUMENT_ALLOWED_CONTENT_TYPES.has(contentType)) {
      return { success: false, error: UNSUPPORTED_TYPE };
    }

    const { presignedUrl, key } = await createPresignedProposalDocumentUpload(
      proposalId,
      user.id,
      contentType
    );
    return { success: true, presignedUrl, key };
  } catch (error) {
    log.error('Failed to presign proposal document upload', {
      requestId,
      relationshipId,
      proposalId,
      userId: user.id,
      contentType,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: GENERIC_FAILURE };
  }
}

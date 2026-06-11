'use server';

import 'server-only';

import { z } from 'zod';
import { proposalsRepository, proposalDocumentsRepository } from '@balo/db';
import { requireUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { resolveConversationAccess } from '@/lib/project-request/resolve-conversation-access';
import { deleteProposalDocumentFromR2 } from '@/lib/storage/proposal-document';

const inputSchema = z.object({
  requestId: z.uuid(),
  relationshipId: z.uuid(),
  proposalId: z.uuid(),
  documentId: z.uuid(),
});

export type RemoveProposalDocumentInput = z.infer<typeof inputSchema>;

export type RemoveProposalDocumentResult =
  | { success: true; documentId: string }
  | { success: false; error: string };

const NOT_SIGNED_IN = 'You are not signed in.';
const INVALID_REQUEST = 'Invalid request.';
const ONLY_EXPERT = 'Only the expert can remove proposal documents.';
const STALE_PROPOSAL = 'This proposal can no longer be edited.';
const NOT_FOUND = 'This document is no longer available.';
const GENERIC_FAILURE = 'Could not remove this document. Please try again.';

/**
 * Remove one proposal document (A6.2 / BAL-288): soft-delete the row + best-effort
 * prefix-guarded R2 delete. Guards: expert lens, the proposal belongs to the
 * VALIDATED relationship and is still a live `draft`, and the document belongs to
 * that proposal (the lookup goes through `listByProposal`, so a foreign
 * documentId never resolves). Idempotent — a re-remove returns NOT_FOUND.
 */
export async function removeProposalDocumentAction(
  input: RemoveProposalDocumentInput
): Promise<RemoveProposalDocumentResult> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { success: false, error: NOT_SIGNED_IN };
  }

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: INVALID_REQUEST };
  }
  const { requestId, relationshipId, proposalId, documentId } = parsed.data;

  try {
    const access = await resolveConversationAccess(user, requestId, relationshipId);
    if (!access.ok) {
      return { success: false, error: access.error };
    }
    if (access.ctx.lens !== 'expert') {
      return { success: false, error: ONLY_EXPERT };
    }

    const proposal = await proposalsRepository.findById(proposalId);
    if (
      proposal === undefined ||
      proposal.relationshipId !== relationshipId ||
      proposal.status !== 'draft'
    ) {
      return { success: false, error: STALE_PROPOSAL };
    }

    // Ownership: the document must be a live row of THIS proposal.
    const documents = await proposalDocumentsRepository.listByProposal(proposalId);
    const document = documents.find((d) => d.id === documentId);
    if (document === undefined) {
      return { success: false, error: NOT_FOUND };
    }

    const removed = await proposalDocumentsRepository.softDelete(documentId);
    if (removed === undefined) {
      // Lost a race with a concurrent remove — already gone, treat as not found.
      return { success: false, error: NOT_FOUND };
    }

    // Best-effort R2 delete — never fail the removal over it.
    deleteProposalDocumentFromR2(document.r2Key).catch(() => {});

    log.info('Proposal document removed', {
      requestId,
      relationshipId,
      proposalId,
      userId: user.id,
      documentId,
    });

    return { success: true, documentId };
  } catch (error) {
    log.error('Failed to remove proposal document', {
      requestId,
      relationshipId,
      proposalId,
      documentId,
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: GENERIC_FAILURE };
  }
}

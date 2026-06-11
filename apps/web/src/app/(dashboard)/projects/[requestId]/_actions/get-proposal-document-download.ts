'use server';

import 'server-only';

import { z } from 'zod';
import { proposalsRepository, proposalDocumentsRepository } from '@balo/db';
import { requireUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { resolveConversationAccess } from '@/lib/project-request/resolve-conversation-access';
import { createPresignedProposalDocumentDownload } from '@/lib/storage/proposal-document';

const inputSchema = z.object({
  requestId: z.uuid(),
  relationshipId: z.uuid(),
  proposalId: z.uuid(),
  documentId: z.uuid(),
});

export type GetProposalDocumentDownloadInput = z.infer<typeof inputSchema>;

export type GetProposalDocumentDownloadResult =
  | { success: true; url: string }
  | { success: false; error: string };

const NOT_SIGNED_IN = 'You are not signed in.';
const INVALID_REQUEST = 'Invalid request.';
const NO_ACCESS = 'You do not have access to this document.';
const NOT_FOUND = 'This document is no longer available.';
const GENERIC_FAILURE = 'Could not download this document. Please try again.';

/**
 * Short-lived presigned GET for one proposal document (A6.2 / BAL-288). These
 * documents are PRIVATE to the proposal's client↔expert pair — never
 * `R2_PUBLIC_URL`. The document must be live AND belong to the VALIDATED
 * relationship's proposal (the lookup goes through `listByProposal`, so a foreign
 * documentId never resolves).
 *
 * LENS GATE (Q5): for THIS slice the download is EXPERT-author-only — A6.3 adds
 * the client path. Written lens-extensibly: the gate is a single explicit check
 * so the client arm is a one-line relaxation later. The proposal need NOT be a
 * draft (the author may download their attachments after submit too).
 */
export async function getProposalDocumentDownloadAction(
  input: GetProposalDocumentDownloadInput
): Promise<GetProposalDocumentDownloadResult> {
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
    // Expert-author-only for this slice (lens-extensible — A6.3 relaxes this).
    if (access.ctx.lens !== 'expert') {
      return { success: false, error: NO_ACCESS };
    }

    const proposal = await proposalsRepository.findById(proposalId);
    if (proposal === undefined || proposal.relationshipId !== relationshipId) {
      return { success: false, error: NOT_FOUND };
    }

    const documents = await proposalDocumentsRepository.listByProposal(proposalId);
    const document = documents.find((d) => d.id === documentId);
    if (document === undefined) {
      return { success: false, error: NOT_FOUND };
    }

    const url = await createPresignedProposalDocumentDownload(document.r2Key, document.fileName);
    return { success: true, url };
  } catch (error) {
    log.error('Failed to presign proposal document download', {
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

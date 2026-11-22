'use server';

import 'server-only';

import { z } from 'zod';
import { proposalsRepository, proposalDocumentsRepository } from '@balo/db';
import { requireUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { trackServerAndFlush, PROJECT_SERVER_EVENTS } from '@/lib/analytics/server';
import {
  authorizeRequestFileScope,
  type RequestFileScope,
} from '@/lib/request-files/authorize-request-file-scope';
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

/** The proposal statuses a client or Balo staff may open documents from: those reached only by sending. */
const PARTY_READABLE_STATUSES: ReadonlySet<string> = new Set([
  'submitted',
  'changes_requested',
  'resubmitted',
  'accepted',
]);

/** Whether the viewer's scope carries the named track: the expert's own, or one the client / admin sees. */
function canReadTrack(
  scope: Extract<RequestFileScope, { ok: true }>,
  relationshipId: string
): boolean {
  if (scope.side === 'expert') {
    return scope.viewer.relationshipId === relationshipId;
  }
  return scope.tracks.some((track) => track.relationshipId === relationshipId);
}

/**
 * Short-lived presigned GET for one proposal document. These documents are PRIVATE to the
 * proposal's parties — never `R2_PUBLIC_URL`. The document must be live AND belong to the
 * VALIDATED relationship's proposal (the lookup goes through `listByProposal`, so a foreign
 * documentId never resolves).
 *
 * THE GATE is the request-file scope (`authorizeRequestFileScope`), the same one the brief's
 * document download uses: the client party by the membership `participate` capability, Balo
 * staff by the platform `view_any_request_file` capability, and the expert only on their OWN
 * track. The relationship named in the input must then be a track the viewer may see: the
 * expert's own, or one the client / admin scope carries (the client never receives an unopened
 * track). A mismatch answers `NO_ACCESS`.
 *
 * STATUS: the client and Balo staff read documents only from a proposal that was sent
 * (`PARTY_READABLE_STATUSES`). A draft, withdrawn or declined one answers `NOT_FOUND` for them,
 * since a draft can reach either of the latter two without ever being shared. The expert may
 * open the files of their own proposal in any status.
 *
 * ⚠ GENUINELY READ-ONLY, AND IT MUST STAY THAT WAY. It authenticates with bare
 * `requireUser()` and sits on `onboarding-mutation-gate.test.ts`'s `READ_ONLY_ALLOWLIST`.
 * `authorizeRequestFileScope` performs no writes on any path (unlike `resolveConversationAccess`,
 * which get-or-CREATES the conversation), and that gate test reads THIS file's source and cannot
 * see a write reached through an import. `conversation-access-read-only.test.ts` derives its
 * subject list from the allowlist.
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
    const scope = await authorizeRequestFileScope(user, requestId);
    if (!scope.ok) {
      return { success: false, error: NO_ACCESS };
    }
    if (!canReadTrack(scope, relationshipId)) {
      log.warn('Proposal document download denied', {
        requestId,
        relationshipId,
        proposalId,
        side: scope.side,
        userId: user.id,
        reason: 'wrong_track',
      });
      return { success: false, error: NO_ACCESS };
    }

    const proposal = await proposalsRepository.findById(proposalId);
    if (proposal === undefined || proposal.relationshipId !== relationshipId) {
      return { success: false, error: NOT_FOUND };
    }
    if (scope.side !== 'expert' && !PARTY_READABLE_STATUSES.has(proposal.status)) {
      log.warn('Proposal document download denied', {
        requestId,
        relationshipId,
        proposalId,
        side: scope.side,
        userId: user.id,
        reason: 'status_not_shared',
        status: proposal.status,
      });
      return { success: false, error: NOT_FOUND };
    }

    const documents = await proposalDocumentsRepository.listByProposal(proposalId);
    const document = documents.find((d) => d.id === documentId);
    if (document === undefined) {
      return { success: false, error: NOT_FOUND };
    }

    const url = await createPresignedProposalDocumentDownload(document.r2Key, document.fileName);

    trackServerAndFlush(PROJECT_SERVER_EVENTS.PROPOSAL_ATTACHMENT_DOWNLOADED, {
      request_id: requestId,
      relationship_id: relationshipId,
      proposal_id: proposalId,
      lens: scope.side,
      distinct_id: user.id,
    });

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

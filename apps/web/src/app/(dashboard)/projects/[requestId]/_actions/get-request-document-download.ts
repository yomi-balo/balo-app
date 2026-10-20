'use server';

import 'server-only';

import { z } from 'zod';
import { projectRequestsRepository } from '@balo/db';
import { requireUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { trackServerAndFlush, REQUEST_DOCUMENT_SERVER_EVENTS } from '@/lib/analytics/server';
import { BEFORE_INVITE_STATUSES } from '@/lib/project-request/resolve-request-lens';
import { createPresignedProjectDocumentDownload } from '@/lib/storage/project-document';
import { authorizeRequestFileScope } from '@/lib/request-files/authorize-request-file-scope';

const inputSchema = z.object({
  requestId: z.uuid(),
  documentId: z.uuid(),
});

export type GetRequestDocumentDownloadResult =
  | { success: true; url: string }
  | { success: false; error: string };

const DOCUMENT_GONE = 'This document is no longer available.';

const BEFORE_INVITE = new Set<string>(BEFORE_INVITE_STATUSES);

/**
 * Short-lived presigned GET for one of the brief's attached documents
 * (`project_request_documents`). The brief is shown whole to every reader of the request, so
 * its documents carry no per-file audience: the request-file scope gate decides who may read
 * the request (client member, a platform admin holding `VIEW_ANY_REQUEST_FILE`, or the viewer's
 * own NON-DECLINED expert track), then `findDocumentInRequest` proves the document belongs to
 * THAT request. A denial, a foreign document and a soft-deleted one all answer the same copy.
 *
 * ⚠ "NON-DECLINED" IS THE LENS RULE (`resolveRequestLens`), NOT THE FILE PLANE'S
 * `requestTrackIsLiveForFiles`. An expert swept by an award (`notSelectedAt`) still reads the
 * brief text on the page, so they still open its documents. Do not tighten this onto the
 * file-plane predicate.
 *
 * The page hides the brief from an expert while the request is before invite
 * (`BEFORE_INVITE_STATUSES`, the shell's `isExpertGated`); this action enforces the same rule
 * rather than trusting the UI.
 *
 * Read-only: authenticates with bare `requireUser()` and sits on `READ_ONLY_ALLOWLIST`, like
 * `get-request-file-download.ts` — the gate performs no writes.
 */
export async function getRequestDocumentDownloadAction(
  input: z.infer<typeof inputSchema>
): Promise<GetRequestDocumentDownloadResult> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { success: false, error: 'You are not signed in.' };
  }

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: 'Invalid request.' };
  }
  const { requestId, documentId } = parsed.data;

  try {
    const scope = await authorizeRequestFileScope(user, requestId);
    if (!scope.ok) {
      return { success: false, error: DOCUMENT_GONE };
    }
    if (scope.side === 'expert' && BEFORE_INVITE.has(scope.request.status)) {
      return { success: false, error: DOCUMENT_GONE };
    }

    const document = await projectRequestsRepository.findDocumentInRequest(
      documentId,
      scope.request.id
    );
    if (document === undefined) {
      return { success: false, error: DOCUMENT_GONE };
    }

    const url = await createPresignedProjectDocumentDownload(document.r2Key, document.fileName);

    trackServerAndFlush(REQUEST_DOCUMENT_SERVER_EVENTS.DOWNLOADED, {
      viewer_side: scope.side,
      distinct_id: user.id,
    });

    return { success: true, url };
  } catch (error) {
    log.error('Failed to presign request document download', {
      requestId,
      documentId,
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: 'Could not open this document. Please try again.' };
  }
}

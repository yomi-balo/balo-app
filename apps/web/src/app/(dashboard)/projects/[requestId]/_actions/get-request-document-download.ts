'use server';

import 'server-only';

import { z } from 'zod';
import { projectRequestsRepository } from '@balo/db';
import { requireUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
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

/**
 * Short-lived presigned GET for one of the brief's attached documents
 * (`project_request_documents`). The brief is shown whole to every reader of the request, so
 * its documents carry no per-file audience: the request-file scope gate decides who may read
 * the request (client member, the viewer's own live expert track, or a platform admin holding
 * `VIEW_ANY_REQUEST_FILE`), then `findDocumentInRequest` proves the document belongs to THAT
 * request. A denial, a foreign document and a soft-deleted one all answer the same copy.
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

    const document = await projectRequestsRepository.findDocumentInRequest(
      documentId,
      scope.request.id
    );
    if (document === undefined) {
      return { success: false, error: DOCUMENT_GONE };
    }

    const url = await createPresignedProjectDocumentDownload(document.r2Key, document.fileName);
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

'use server';

import 'server-only';

import { z } from 'zod';
import {
  requestSharedFilesRepository,
  RequestFileNotFoundError,
  RequestFileAlreadyDeletedError,
} from '@balo/db';
import { requireOnboardedUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { deleteRequestFileFromR2 } from '@/lib/storage/request-file';
import {
  authorizeRequestFileScope,
  REQUEST_FILES_UNAVAILABLE_COPY,
  type RequestFileScope,
} from '@/lib/request-files/authorize-request-file-scope';
import type { RequestFileWithGrants } from '@balo/db';

const inputSchema = z.object({
  requestId: z.uuid(),
  fileId: z.uuid(),
});

export type DeleteRequestFileResult = { success: true } | { success: false; error: string };

const FILE_GONE = 'This file is no longer available.';

/**
 * RULING 3, applied — delete right ≡ upload right on that side, PARTY-LEVEL on both sides. See
 * the action's own docblock for the full rule; this is its structural expression.
 */
function actorMayDeleteFile(
  scope: Extract<RequestFileScope, { ok: true; side: 'client' | 'expert' }>,
  found: RequestFileWithGrants
): boolean {
  if (scope.side === 'client') return found.file.side === 'client';
  const ownsTrack = found.file.expertRelationshipId === scope.viewer.relationshipId;
  const trackIsLive = scope.viewer.access.kind === 'live';
  return ownsTrack && trackIsLive;
}

/**
 * Delete (tombstone) one request-shared file (BAL-431 / ADR-1048, Ruling 1 + Ruling 3).
 *
 * RULING 3 — delete right ≡ upload right on that side, PARTY-LEVEL on both sides, no
 * `uploaded_by_user_id === actor` check, no new predicate:
 *  - `side === 'client'` → allowed iff the gate returned `side: 'client'` (the SAME
 *    PARTICIPATE-capability check that grants upload).
 *  - `side === 'expert'` → allowed iff the gate returned `side: 'expert'`, the file's
 *    `expertRelationshipId` matches the viewer's OWN track, and that track is LIVE.
 *  - admin → never (read-only lens).
 *
 * RULING 1 — the transaction (tombstone + the audit snapshot of the RESOLVED AUDIENCE at
 * delete time) commits FIRST; the best-effort, prefix-guarded R2 object delete happens AFTER
 * commit. Reversing that order can leave a live row pointing at deleted bytes. SILENT BY
 * DECISION: no notification is published.
 */
export async function deleteRequestFileAction(
  input: z.infer<typeof inputSchema>
): Promise<DeleteRequestFileResult> {
  let user;
  try {
    user = await requireOnboardedUser();
  } catch {
    return { success: false, error: 'You are not signed in.' };
  }

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: 'Invalid request.' };
  }
  const { requestId, fileId } = parsed.data;

  try {
    const scope = await authorizeRequestFileScope(user, requestId);
    if (!scope.ok) {
      return { success: false, error: REQUEST_FILES_UNAVAILABLE_COPY };
    }
    if (scope.side === 'admin') {
      return { success: false, error: REQUEST_FILES_UNAVAILABLE_COPY };
    }

    // Containment + Ruling 3 authorization, before any write.
    const found = await requestSharedFilesRepository.findByIdInRequest(fileId, scope.request.id);
    if (found === undefined || !actorMayDeleteFile(scope, found)) {
      return { success: false, error: FILE_GONE };
    }

    const result = await requestSharedFilesRepository.softDelete({
      fileId,
      projectRequestId: scope.request.id,
      actorUserId: user.id,
    });

    // AFTER COMMIT ONLY — best-effort, never blocks or fails the user-facing result.
    deleteRequestFileFromR2(result.r2Key).catch((error: unknown) => {
      log.warn('Best-effort request file R2 delete failed', {
        requestId: scope.request.id,
        fileId,
        error: error instanceof Error ? error.message : String(error),
      });
    });

    log.info('Request file deleted', {
      requestId: scope.request.id,
      fileId,
      userId: user.id,
      resolvedAudienceSize: result.resolvedAudience.length,
    });

    return { success: true };
  } catch (error) {
    if (
      error instanceof RequestFileNotFoundError ||
      error instanceof RequestFileAlreadyDeletedError
    ) {
      return { success: false, error: FILE_GONE };
    }
    log.error('Failed to delete request file', {
      requestId,
      fileId,
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: 'Could not remove this file. Please try again.' };
  }
}

'use server';

import 'server-only';

import { z } from 'zod';
import { requestSharedFilesRepository } from '@balo/db';
import { requestFileVisibleToTrack } from '@balo/shared/authz';
import { requireUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { trackServerAndFlush, REQUEST_FILE_SERVER_EVENTS } from '@/lib/analytics/server';
import { createPresignedRequestFileDownload } from '@/lib/storage/request-file';
import { authorizeRequestFileScope } from '@/lib/request-files/authorize-request-file-scope';
import { toSerializerFile } from '@/lib/request-files/load-request-files';

const inputSchema = z.object({
  requestId: z.uuid(),
  fileId: z.uuid(),
});

export type GetRequestFileDownloadResult =
  | { success: true; url: string }
  | { success: false; error: string };

const FILE_GONE = 'This file is no longer available.';

/**
 * Short-lived presigned GET for one request-shared file (BAL-431 / ADR-1048). Layer 3 of the
 * gate stack: the scope gate (layer 2) authorizes the ACTOR/REQUEST, then this function proves
 * CONTAINMENT (the file belongs to the gate-validated request — `findByIdInRequest`, the direct
 * replacement for `listFiles(conversationId)`'s accidental IDOR defence) AND — for the expert
 * arm — the per-file AUDIENCE check (`requestFileVisibleToTrack`), the real boundary once a
 * file is readable from more than one track.
 *
 * ⚠ GENUINELY READ-ONLY, AND IT MUST STAY THAT WAY. It authenticates with bare `requireUser()`
 * and sits on `READ_ONLY_ALLOWLIST`: `authorizeRequestFileScope` performs NO WRITES AT ALL — it
 * never mints a conversation/relationship row, so there is no writing/read-only pair to choose
 * between and no `resolveConversationAccess` equivalent in its import graph. Same shape as the
 * BAL-423 meeting-file entries.
 */
export async function getRequestFileDownloadAction(
  input: z.infer<typeof inputSchema>
): Promise<GetRequestFileDownloadResult> {
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
  const { requestId, fileId } = parsed.data;

  try {
    const scope = await authorizeRequestFileScope(user, requestId);
    if (!scope.ok) {
      return { success: false, error: FILE_GONE };
    }

    // Containment: a file on another request (or a foreign uuid) resolves `undefined`,
    // identically to a soft-deleted one — probing learns nothing.
    //
    // ⚠ NOBODY DOWNLOADS A TOMBSTONE — THE ADMIN LENS INCLUDED. Under Ruling 1 a delete removes
    // the R2 OBJECT; the tombstone row plus the `audit_events` entry (with the audience snapshot
    // resolved at delete time) ARE the surviving record. Presigning a deleted file would hand
    // out a URL for bytes that no longer exist. So this read never sets `includeDeleted`, and a
    // tombstone resolves `undefined` → the FILE_GONE copy above, byte-identical to a foreign
    // uuid — which is exactly the containment property this comment describes.
    const found = await requestSharedFilesRepository.findByIdInRequest(fileId, scope.request.id);
    if (found === undefined) {
      return { success: false, error: FILE_GONE };
    }

    let viaAllAudience = false;
    if (scope.side === 'expert') {
      const serialized = toSerializerFile(found.file);
      const grantedIds = new Set(found.grants.map((g) => g.relationshipId));
      if (!requestFileVisibleToTrack(serialized, scope.viewer, grantedIds)) {
        return { success: false, error: FILE_GONE };
      }
      viaAllAudience = found.file.side === 'client' && found.file.audience === 'all_live_tracks';
    }
    // side === 'client': every live file on its own request is visible (ticket §Read rule).
    // side === 'admin': every LIVE file — the read-only oversight lens reads tombstones in the
    // list view (`loadRequestFiles` still passes `includeDeleted: true`), but cannot download
    // one, because the bytes are gone (Ruling 1).

    const url = await createPresignedRequestFileDownload(found.file.r2Key, found.file.fileName);

    trackServerAndFlush(REQUEST_FILE_SERVER_EVENTS.DOWNLOADED, {
      viewer_side: scope.side,
      via_all_audience: viaAllAudience,
      distinct_id: user.id,
    });

    return { success: true, url };
  } catch (error) {
    log.error('Failed to presign request file download', {
      requestId,
      fileId,
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: 'Could not download this file. Please try again.' };
  }
}

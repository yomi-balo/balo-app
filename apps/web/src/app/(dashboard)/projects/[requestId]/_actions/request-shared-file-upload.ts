'use server';

import 'server-only';

import { z } from 'zod';
import { requireOnboardedUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import {
  authorizeRequestFileScope,
  REQUEST_FILES_UNAVAILABLE_COPY,
  REQUEST_FILE_TRACK_CLOSED_SELF_COPY,
} from '@/lib/request-files/authorize-request-file-scope';
import {
  REQUEST_FILE_ALLOWED_CONTENT_TYPES,
  MAX_REQUEST_FILE_BYTES,
  createPresignedRequestFileUpload,
} from '@/lib/storage/request-file';

const inputSchema = z.object({
  requestId: z.uuid(),
  contentType: z.string().min(1).max(255),
  fileName: z.string().trim().min(1).max(255),
  /**
   * ⚠ SIGNED INTO THE URL, NOT MERELY VALIDATED. The declared size becomes the PUT's
   * `ContentLength` condition, so an oversized (or differently-sized) body is refused by R2 at
   * the edge instead of only by the confirm step's `HeadObject` — which an attacker never has
   * to call. The ceiling itself is checked below (not in the schema) so an oversized file gets
   * the real "too large" copy rather than the generic "Invalid request."
   */
  sizeBytes: z.number().int().positive(),
});
// ⚠ NO `side`. NO `expertRelationshipId`. NO `audience`. NO `relationshipId`. Every one of
// those comes from the GATE (the `meeting_files.party` rule).

export type RequestSharedFileUploadResult =
  | { success: true; presignedUrl: string; key: string }
  | { success: false; error: string };

/**
 * Presign a PUT for one request-shared file (BAL-431 / ADR-1048 — step 1 of presign → PUT →
 * confirm). The key is scoped to the GATE-VALIDATED request + the session user, never
 * client-supplied.
 */
export async function requestSharedFileUploadAction(
  input: z.infer<typeof inputSchema>
): Promise<RequestSharedFileUploadResult> {
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
  const { requestId, contentType, sizeBytes } = parsed.data;

  try {
    const scope = await authorizeRequestFileScope(user, requestId);
    if (!scope.ok) {
      return { success: false, error: REQUEST_FILES_UNAVAILABLE_COPY };
    }
    // The admin lens is READ-ONLY (design ref: "Read model only here") — it never reaches an
    // upload/grant/delete path.
    if (scope.side === 'admin') {
      return { success: false, error: REQUEST_FILES_UNAVAILABLE_COPY };
    }
    // Ruling 3 — upload right requires a LIVE track (delete right mirrors this exactly).
    // ⚠ SECOND PERSON: this arm is reached only when the READER is the expert.
    if (scope.side === 'expert' && scope.viewer.access.kind !== 'live') {
      return { success: false, error: REQUEST_FILE_TRACK_CLOSED_SELF_COPY };
    }

    if (!REQUEST_FILE_ALLOWED_CONTENT_TYPES.has(contentType)) {
      return { success: false, error: 'This file type is not supported.' };
    }
    if (sizeBytes > MAX_REQUEST_FILE_BYTES) {
      return { success: false, error: 'This file is too large. Please try a smaller file.' };
    }

    const { presignedUrl, key } = await createPresignedRequestFileUpload(
      scope.request.id,
      user.id,
      contentType,
      sizeBytes
    );
    return { success: true, presignedUrl, key };
  } catch (error) {
    log.error('Failed to presign request file upload', {
      requestId,
      userId: user.id,
      contentType,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: "File sharing isn't available right now." };
  }
}

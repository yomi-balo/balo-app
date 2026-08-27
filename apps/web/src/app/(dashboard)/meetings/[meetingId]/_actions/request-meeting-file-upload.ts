'use server';

import 'server-only';

import { z } from 'zod';
import { requireOnboardedUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { authorizeMeetingFileAccess } from '@/lib/meetings/authorize-meeting-file-access';
import {
  MEETING_ALLOWED_CONTENT_TYPES,
  MAX_MEETING_FILE_BYTES,
  createPresignedMeetingFileUpload,
} from '@/lib/storage/meeting-file';

const inputSchema = z.object({
  meetingId: z.uuid(),
  contentType: z.string().min(1).max(255),
  fileName: z.string().trim().min(1).max(255),
  /**
   * ⚠ THE CLIENT-DECLARED BYTE LENGTH, AND IT IS NOT TAKEN ON TRUST — IT IS BOUND INTO THE
   * SIGNATURE. It becomes the PUT's signed `ContentLength`, so R2 rejects a body of any other
   * length at the edge. A client that lies about it does not get a bigger upload; it gets a
   * credential its own bytes cannot satisfy. Bounded at `MAX_SAFE_INTEGER` so the cap
   * comparison below is always an exact integer comparison.
   */
  sizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

export type RequestMeetingFileUploadResult =
  | { success: true; presignedUrl: string; key: string }
  | { success: false; error: string };

/**
 * Presign a PUT for one in-call meeting file (BAL-423 — step 1 of presign → PUT → confirm).
 *
 * The key is scoped to the GATE-VALIDATED meeting + the session user — never client-supplied.
 * The browser PUTs directly to R2 with XHR for progress; the app never proxies bytes.
 *
 * ⚠ THE GATE RUNS BEFORE THE ALLOW-LIST AND SIZE CHECKS, and the order matters: an actor who
 * is not a participant must not learn from the response whether a content type or a size is
 * acceptable, nor anything else about a guessed `meetingId`. Authorization first, every time.
 *
 * ⚠ MUTATION-GATED. It authenticates with `requireOnboardedUser()` — it mints a credential
 * that writes to object storage, so it is a write in every sense that matters.
 *
 * ⚠⚠ THE 10 MB CAP IS ENFORCED **INTO THE SIGNATURE**, NOT MERELY POST-HOC. The declared
 * `sizeBytes` is rejected here for friendly copy AND signed as the PUT's `ContentLength`, so
 * R2 refuses a body of any other length at the edge. Without that, one valid presigned URL
 * would let its holder park an arbitrarily large object in the bucket — billable, never
 * confirmed, therefore unreachable by every read path and never deleted — simply by not
 * calling confirm. The confirm-time HEAD check REMAINS as defence in depth and as the source
 * of truth for what is persisted.
 *
 * ⚠ THE `meetingId` AND THE SESSION `userId` ARE LOWERCASED INTO THE KEY (inside
 * `generateMeetingFileKey`, via the shared `meetingFileKeyPrefix`). `z.uuid()` accepts
 * UPPERCASE hex and Postgres resolves it to the same row, so without that normalisation an
 * uppercase id would mint a key the confirm action's lowercase-only
 * `MEETING_FILE_KEY_PATTERN` then rejects — permanently orphaning an object that is already
 * in R2. Both sides derive the prefix from the SAME function, so they cannot disagree.
 */
export async function requestMeetingFileUploadAction(
  input: z.infer<typeof inputSchema>
): Promise<RequestMeetingFileUploadResult> {
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
  const { meetingId, contentType, sizeBytes } = parsed.data;

  try {
    const access = await authorizeMeetingFileAccess({
      meetingId,
      actor: { kind: 'member', userId: user.id },
    });
    if (!access.ok) {
      // ONE literal from the gate → ONE generic copy. Never surface the denial shape.
      return { success: false, error: 'This meeting is no longer available.' };
    }

    if (!MEETING_ALLOWED_CONTENT_TYPES.has(contentType)) {
      return { success: false, error: 'This file type is not supported.' };
    }

    // ⚠ DIFFERENT COPY FROM THE TYPE REJECTION, and different again from the confirm-time
    // "uploaded file is too large" — the remedies differ (pick a smaller file BEFORE
    // uploading vs. the object that arrived was over-cap), so the messages must too.
    if (sizeBytes > MAX_MEETING_FILE_BYTES) {
      return { success: false, error: 'This file is too large. Please choose a smaller file.' };
    }

    const { presignedUrl, key } = await createPresignedMeetingFileUpload(
      meetingId,
      user.id,
      contentType,
      sizeBytes
    );
    return { success: true, presignedUrl, key };
  } catch (error) {
    log.error('Failed to presign meeting file upload', {
      meetingId,
      userId: user.id,
      contentType,
      sizeBytes,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: "File sharing isn't available right now." };
  }
}

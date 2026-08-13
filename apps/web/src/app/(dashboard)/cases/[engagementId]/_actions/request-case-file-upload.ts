'use server';

import 'server-only';

import { z } from 'zod';
import { requireOnboardedUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { resolveCaseAccess } from '@/lib/cases/resolve-case-access';
import {
  CONVERSATION_ALLOWED_CONTENT_TYPES,
  createPresignedConversationFileUpload,
} from '@/lib/storage/conversation-file';
import type { RequestCaseFileUploadResult } from './_types/case-action-types';

const inputSchema = z
  .object({
    engagementId: z.uuid(),
    contentType: z.string().min(1).max(255),
    fileName: z.string().trim().min(1).max(255),
  })
  .strict();

/**
 * BAL-421 — presign a PUT for a file shared into a CASE's conversation (step 1 of
 * presign → PUT → confirm).
 *
 * ⚠⚠ THE CASE SURFACE WRITES TO `conversation_files`, NOT `meeting_files`, AND THAT IS THE
 * CORRECT SIDE OF THE D4 MERGE. `meeting_files` rows belong to a specific CALL (they carry a
 * two-sided `party` and an in-call `source`); a file shared from the case surface was not
 * shared in a call and has no meeting to hang off. The Files card MERGES both tables on READ —
 * that is a read-side union, not an invitation to write to either.
 *
 * ⚠ THE R2 KEY IS SCOPED TO THE GATE-VALIDATED CONVERSATION + THE SESSION USER, never to
 * anything the caller supplied. The key shape `conversation-files/{conversationId}/{userId}/
 * {uuid}` is already case-ready: BAL-424 moved the first segment off the relationship id
 * precisely because "a Case has no relationship", so the storage helper is reused VERBATIM.
 *
 * ⚠ WRITABLE REQUIRED. Sharing a file into a CLOSED case is a write, and a closed case is
 * read-only. Composed once at the gate — never re-derived here.
 */
export async function requestCaseFileUploadAction(
  input: z.infer<typeof inputSchema>
): Promise<RequestCaseFileUploadResult> {
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
  const { engagementId, contentType } = parsed.data;

  try {
    const access = await resolveCaseAccess(engagementId, user.id);
    if (access === null) {
      return { success: false, error: 'This case is no longer available.' };
    }
    if (!access.conversationWritable) {
      return { success: false, error: 'This case is closed, so the conversation is read-only.' };
    }

    if (!CONVERSATION_ALLOWED_CONTENT_TYPES.has(contentType)) {
      return { success: false, error: 'This file type is not supported.' };
    }

    const { presignedUrl, key } = await createPresignedConversationFileUpload(
      access.conversationId,
      user.id,
      contentType
    );
    return { success: true, presignedUrl, key };
  } catch (error) {
    log.error('Failed to presign case file upload', {
      engagementId,
      userId: user.id,
      contentType,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: "File sharing isn't available right now." };
  }
}

'use server';

import 'server-only';

import { z } from 'zod';
import { requireUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { resolveConversationAccess } from '@/lib/project-request/resolve-conversation-access';
import {
  CONVERSATION_ALLOWED_CONTENT_TYPES,
  createPresignedConversationFileUpload,
} from '@/lib/storage/conversation-file';

const inputSchema = z.object({
  requestId: z.uuid(),
  relationshipId: z.uuid(),
  contentType: z.string().min(1).max(255),
  fileName: z.string().trim().min(1).max(255),
});

export type RequestConversationFileUploadResult =
  | { success: true; presignedUrl: string; key: string }
  | { success: false; error: string };

/**
 * Presign a PUT for one conversation file (BAL-271 / A4 — D5, step 1 of
 * presign → PUT → confirm). The key is scoped to the VALIDATED relationship +
 * the session user — never client-supplied. The client PUTs directly with XHR
 * for progress, then calls the confirm action which inserts the row.
 */
export async function requestConversationFileUploadAction(
  input: z.infer<typeof inputSchema>
): Promise<RequestConversationFileUploadResult> {
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
  const { requestId, relationshipId, contentType } = parsed.data;

  try {
    const access = await resolveConversationAccess(user, requestId, relationshipId);
    if (!access.ok) {
      return { success: false, error: access.error };
    }

    if (!CONVERSATION_ALLOWED_CONTENT_TYPES.has(contentType)) {
      return { success: false, error: 'This file type is not supported.' };
    }

    const { presignedUrl, key } = await createPresignedConversationFileUpload(
      relationshipId,
      user.id,
      contentType
    );
    return { success: true, presignedUrl, key };
  } catch (error) {
    log.error('Failed to presign conversation file upload', {
      requestId,
      relationshipId,
      userId: user.id,
      contentType,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: "File sharing isn't available right now." };
  }
}

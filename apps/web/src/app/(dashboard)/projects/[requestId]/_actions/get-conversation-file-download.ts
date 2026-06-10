'use server';

import 'server-only';

import { z } from 'zod';
import { conversationsRepository } from '@balo/db';
import { requireUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { resolveConversationAccess } from '@/lib/project-request/resolve-conversation-access';
import { createPresignedConversationFileDownload } from '@/lib/storage/conversation-file';

const inputSchema = z.object({
  requestId: z.uuid(),
  relationshipId: z.uuid(),
  fileId: z.uuid(),
});

export type GetConversationFileDownloadResult =
  | { success: true; url: string }
  | { success: false; error: string };

/**
 * Short-lived presigned GET for one conversation file (BAL-271 / A4 — D5).
 * These files are PRIVATE to the client↔expert pair — never `R2_PUBLIC_URL`.
 * The file must be live AND belong to the VALIDATED relationship (the lookup
 * goes through `listFiles(relationshipId)`, so a foreign fileId never resolves).
 */
export async function getConversationFileDownloadAction(
  input: z.infer<typeof inputSchema>
): Promise<GetConversationFileDownloadResult> {
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
  const { requestId, relationshipId, fileId } = parsed.data;

  try {
    const access = await resolveConversationAccess(user, requestId, relationshipId);
    if (!access.ok) {
      return { success: false, error: access.error };
    }

    const files = await conversationsRepository.listFiles(relationshipId);
    const file = files.find((f) => f.id === fileId);
    if (file === undefined) {
      return { success: false, error: 'This file is no longer available.' };
    }

    const url = await createPresignedConversationFileDownload(file.r2Key, file.fileName);
    return { success: true, url };
  } catch (error) {
    log.error('Failed to presign conversation file download', {
      requestId,
      relationshipId,
      userId: user.id,
      fileId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: 'Could not download this file. Please try again.' };
  }
}

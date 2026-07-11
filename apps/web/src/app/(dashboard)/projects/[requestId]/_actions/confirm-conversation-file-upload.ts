'use server';

import 'server-only';

import { z } from 'zod';
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { conversationsRepository } from '@balo/db';
import { requireOnboardedUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { publishNotificationEvent } from '@/lib/notifications/publish';
import { publishConversationEvent } from '@/lib/realtime/ably-server';
import { CONVERSATION_EVENT_FILE } from '@/lib/realtime/channels';
import { r2Client, R2_BUCKET } from '@/lib/storage/r2';
import {
  CONVERSATION_ALLOWED_CONTENT_TYPES,
  CONVERSATION_FILE_PREFIX,
  MAX_CONVERSATION_FILE_BYTES,
  deleteConversationFileFromR2,
} from '@/lib/storage/conversation-file';
import { resolveConversationAccess } from '@/lib/project-request/resolve-conversation-access';
import type { ConversationFileView } from '@/lib/project-request/conversation-view-types';

// conversation-files/{relationshipId uuid}/{userId uuid}/{uuid}
const CONVERSATION_FILE_KEY_PATTERN =
  /^conversation-files\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/;

const inputSchema = z.object({
  requestId: z.uuid(),
  relationshipId: z.uuid(),
  key: z.string().min(1).max(512),
  fileName: z.string().trim().min(1).max(255),
  contentType: z.string().min(1).max(255),
  sizeBytes: z.number().int().nonnegative(),
});

export type ConfirmConversationFileUploadResult =
  | { success: true; file: ConversationFileView }
  | { success: false; error: string };

/**
 * True when `error` is a Postgres unique-violation (SQLSTATE 23505) — a double
 * confirm of the same R2 key trips `conversation_file_key_idx`. Mirrors the
 * structural narrowing in `submit-eoi.ts` (no `any`, no assertion — the `in`
 * guard narrows `object` to carry `code`).
 */
function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  return 'code' in error && error.code === '23505';
}

/** Key shape + provenance: relationship from VALIDATED access, user from session. */
function validateUploadKey(key: string, relationshipId: string, userId: string): string | null {
  if (!CONVERSATION_FILE_KEY_PATTERN.test(key)) {
    return 'Invalid upload key.';
  }
  const expectedPrefix = `${CONVERSATION_FILE_PREFIX}${relationshipId}/${userId}/`;
  if (!key.startsWith(expectedPrefix)) {
    return 'Invalid upload key.';
  }
  return null;
}

type UploadedObjectCheck =
  | { ok: true; sizeBytes: number; contentType: string }
  | { ok: false; error: string };

/**
 * HEAD-checks the object in R2 — size + type re-checked at the source. A
 * rejected object is best-effort deleted. Missing/zero size and over-cap are
 * DIFFERENT failures — don't conflate an empty object under "too large" copy.
 */
async function verifyUploadedObject(
  key: string,
  claimedContentType: string
): Promise<UploadedObjectCheck> {
  const head = await r2Client.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }));

  const realSize = head.ContentLength;
  if (realSize === undefined || realSize === 0) {
    deleteConversationFileFromR2(key).catch(() => {});
    return { ok: false, error: 'The uploaded file appears to be empty.' };
  }
  if (realSize > MAX_CONVERSATION_FILE_BYTES) {
    deleteConversationFileFromR2(key).catch(() => {});
    return { ok: false, error: 'Uploaded file is too large. Please try a smaller file.' };
  }

  const resolvedContentType = head.ContentType ?? claimedContentType;
  if (!CONVERSATION_ALLOWED_CONTENT_TYPES.has(resolvedContentType)) {
    deleteConversationFileFromR2(key).catch(() => {});
    return { ok: false, error: 'This file type is not supported.' };
  }

  return { ok: true, sizeBytes: realSize, contentType: resolvedContentType };
}

/** Sharing = you've seen your own activity. Never fail the share over it. */
async function advanceReadWatermark(
  requestId: string,
  relationshipId: string,
  userId: string,
  at: Date
): Promise<void> {
  try {
    await conversationsRepository.markThreadRead({ relationshipId, userId, at });
  } catch (error) {
    log.warn('Failed to advance read watermark after file share', {
      requestId,
      relationshipId,
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Confirm an uploaded conversation file (BAL-271 / A4 — D5, step 3): validates
 * key shape + provenance (relationship from VALIDATED access, user from
 * session), HEAD-checks the real size/type in R2, then INSERTS the
 * `conversation_files` row immediately — the share IS the event (unlike
 * project documents, there is no later "submit" to defer to).
 *
 * `addFile` is called STANDALONE (no wider transaction) so its bare-insert
 * contract is satisfied; a duplicate r2Key (23505) maps to friendly copy.
 * No `revalidatePath` — island state + realtime own freshness.
 */
export async function confirmConversationFileUploadAction(
  input: z.infer<typeof inputSchema>
): Promise<ConfirmConversationFileUploadResult> {
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
  const { requestId, relationshipId, key, fileName, contentType, sizeBytes } = parsed.data;

  try {
    const access = await resolveConversationAccess(user, requestId, relationshipId);
    if (!access.ok) {
      return { success: false, error: access.error };
    }

    // 1. Key shape + provenance: relationship from VALIDATED access, user from session.
    const keyError = validateUploadKey(key, relationshipId, user.id);
    if (keyError !== null) {
      return { success: false, error: keyError };
    }

    // 2. Verify the object in R2 — size + type re-checked at the source.
    const verified = await verifyUploadedObject(key, contentType);
    if (!verified.ok) {
      return { success: false, error: verified.error };
    }

    // 3. The share IS the event — insert the row now (standalone, no wider tx).
    const row = await conversationsRepository.addFile({
      relationshipId,
      uploadedByUserId: user.id,
      r2Key: key,
      fileName,
      contentType: verified.contentType,
      sizeBytes: verified.sizeBytes,
    });

    const uploadedByName =
      [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || 'Participant';
    const fileView: ConversationFileView = {
      id: row.id,
      relationshipId,
      fileName: row.fileName,
      contentType: row.contentType,
      sizeBytes: row.sizeBytes,
      uploadedByUserId: user.id,
      uploadedByName,
      createdAtIso: row.createdAt.toISOString(),
    };

    await advanceReadWatermark(requestId, relationshipId, user.id, row.createdAt);

    // BAL-279: both publishes are deferred to Next's `after()` inside their
    // publishers — they run after the response flushes but before the function can
    // freeze, so neither the ephemeral realtime ping nor the durable notification
    // is cut short, and neither adds latency to this action. Both never throw.
    void publishConversationEvent(relationshipId, CONVERSATION_EVENT_FILE, fileView);

    publishNotificationEvent('project.file_shared', {
      correlationId: row.id,
      projectRequestId: requestId,
      relationshipId,
      title: access.request.title,
      senderName: uploadedByName,
      recipientRole: access.recipient.role,
      recipientId: access.recipient.role === 'client' ? access.recipient.userId : undefined,
      expertProfileId:
        access.recipient.role === 'expert' ? access.recipient.expertProfileId : undefined,
      fileName: row.fileName,
    }).catch(() => {
      // publishNotificationEvent logs internally.
    });

    log.info('Conversation file shared', {
      requestId,
      relationshipId,
      userId: user.id,
      fileId: row.id,
      sizeBytes: verified.sizeBytes,
      contentType: verified.contentType,
    });

    return { success: true, file: fileView };
  } catch (error) {
    // A duplicate confirm (double-click/retry) is EXPECTED — warn, not error.
    if (isUniqueViolation(error)) {
      log.warn('Duplicate conversation file confirm (expected double-click)', {
        requestId,
        relationshipId,
        userId: user.id,
        key,
      });
      return { success: false, error: 'This file was already shared.' };
    }
    log.error('Failed to confirm conversation file upload', {
      requestId,
      relationshipId,
      userId: user.id,
      key,
      sizeBytes,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: 'Could not share your file. Please try again.' };
  }
}

'use server';

import 'server-only';

import { z } from 'zod';
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { caseEngagementsRepository, conversationsRepository } from '@balo/db';
import { requireOnboardedUser } from '@/lib/auth/session';
import { errorMessage, log } from '@/lib/logging';
import { publishConversationEvent } from '@/lib/realtime/ably-server';
import { CONVERSATION_EVENT_FILE } from '@/lib/realtime/channels';
import { r2Client, R2_BUCKET } from '@/lib/storage/r2';
import {
  CONVERSATION_ALLOWED_CONTENT_TYPES,
  CONVERSATION_FILE_PREFIX,
  MAX_CONVERSATION_FILE_BYTES,
  deleteConversationFileFromR2,
} from '@/lib/storage/conversation-file';
import { resolveCaseAccess } from '@/lib/cases/resolve-case-access';
import type { ConversationFileView } from '@/lib/conversations/conversation-view-types';
import { publishCaseFileShared, resolveCaseNotifyContext } from '../_lib/case-conversation-notify';
import type { ConfirmCaseFileUploadResult } from './_types/case-action-types';

/**
 * `conversation-files/{conversationId uuid}/{userId uuid}/{uuid}` — the shape BAL-424 settled
 * when it moved the first segment off the relationship id ("a Case has no relationship").
 *
 * ⚠ NO NESTED QUANTIFIER AND NO OVERLAPPING ALTERNATION (SonarCloud S5852). Each segment is a
 * fixed-length bounded class, so there is nothing to backtrack over.
 */
const CONVERSATION_FILE_KEY_PATTERN =
  /^conversation-files\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/;

const inputSchema = z
  .object({
    engagementId: z.uuid(),
    key: z.string().min(1).max(512),
    fileName: z.string().trim().min(1).max(255),
    contentType: z.string().min(1).max(255),
    sizeBytes: z.number().int().nonnegative(),
  })
  .strict();

/**
 * True when `error` is a Postgres unique-violation (SQLSTATE 23505) — a double confirm of the
 * same R2 key trips `conversation_file_key_idx`. Structural narrowing: the `in` guard narrows
 * `object` to carry `code`, so there is no `any` and no assertion.
 */
function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  return 'code' in error && error.code === '23505';
}

/**
 * Key shape + PROVENANCE.
 *
 * ⚠⚠ THIS IS THE WHOLE IDOR STORY FOR `key`. The conversation comes from the VALIDATED gate
 * result and the user from the SESSION, so a caller cannot confirm an object into someone
 * else's thread by naming its key: the expected prefix is rebuilt from values they do not
 * control, and a mismatch is refused before any row is written.
 */
function validateUploadKey(key: string, conversationId: string, userId: string): string | null {
  if (!CONVERSATION_FILE_KEY_PATTERN.test(key)) {
    return 'Invalid upload key.';
  }
  if (!key.startsWith(`${CONVERSATION_FILE_PREFIX}${conversationId}/${userId}/`)) {
    return 'Invalid upload key.';
  }
  return null;
}

type UploadedObjectCheck =
  | { ok: true; sizeBytes: number; contentType: string }
  | { ok: false; error: string };

/**
 * HEAD-check the object in R2 — size and type re-verified AT THE SOURCE rather than trusted
 * from the request body. A rejected object is best-effort deleted so a refused upload does not
 * leave a billable orphan.
 *
 * ⚠ EMPTY AND OVER-CAP ARE DIFFERENT FAILURES with different copy — telling someone their
 * empty file is "too large" is a dead end.
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

/**
 * BAL-421 — confirm an uploaded case conversation file (step 3 of presign → PUT → confirm).
 *
 * The share IS the event: the `conversation_files` row is inserted immediately, standalone
 * (no wider transaction), so `addFile`'s bare-insert contract is satisfied without SAVEPOINTs.
 *
 * ⚠ NO `revalidatePath` — island state plus realtime own freshness, and a full-page revalidate
 * would wipe the composer mid-conversation.
 */
export async function confirmCaseFileUploadAction(
  input: z.infer<typeof inputSchema>
): Promise<ConfirmCaseFileUploadResult> {
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
  const { engagementId, key, fileName, contentType, sizeBytes } = parsed.data;

  try {
    const access = await resolveCaseAccess(engagementId, user.id);
    if (access === null) {
      return { success: false, error: 'This case is no longer available.' };
    }
    if (!access.conversationWritable) {
      return { success: false, error: 'This case is closed, so the conversation is read-only.' };
    }

    // 1. Key shape + provenance — conversation from the VALIDATED gate, user from the session.
    const { conversationId } = access;
    const keyError = validateUploadKey(key, conversationId, user.id);
    if (keyError !== null) {
      return { success: false, error: keyError };
    }

    // 2. Verify the object in R2 — size + type re-checked at the source.
    const verified = await verifyUploadedObject(key, contentType);
    if (!verified.ok) {
      return { success: false, error: verified.error };
    }

    // 3. The share IS the event — insert now.
    const row = await conversationsRepository.addFile({
      conversationId,
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
      conversationId,
      fileName: row.fileName,
      contentType: row.contentType,
      sizeBytes: row.sizeBytes,
      uploadedByUserId: user.id,
      uploadedByName,
      createdAtIso: row.createdAt.toISOString(),
    };

    // Sharing = you have seen your own activity. Never fail the share over the watermark.
    try {
      await conversationsRepository.markThreadRead({
        conversationId,
        userId: user.id,
        at: row.createdAt,
      });
    } catch (error) {
      log.warn('Failed to advance read watermark after case file share', {
        engagementId,
        conversationId,
        userId: user.id,
        error: errorMessage(error),
      });
    }

    void publishConversationEvent(conversationId, CONVERSATION_EVENT_FILE, fileView);

    // ── ⚠⚠ POST-COMMIT AND POST-BROADCAST. NOTHING BELOW MAY FAIL THIS SHARE. ──
    // The `conversation_files` row is persisted and the Ably event is already on the wire, so a
    // failure here would toast "could not share" for a file the uploader can SEE in the panel —
    // and the retry would trip `conversation_file_key_idx` and report "already shared". Both
    // reads are therefore individually `.catch`-guarded:
    //   · the case title degrades to a neutral label;
    //   · the recipient lookup degrades to NO fan-out. `resolveCaseNotifyTargets` reaches
    //     `companiesRepository.findOwnerUserIdByCompanyId` on the expert lens, which its own
    //     docblock says still THROWS on a transient DB error so a caller can retry — but this
    //     caller must not, and cannot. A missed notification beats a phantom failure.
    const { title: caseTitle, targets } = await resolveCaseNotifyContext({
      access,
      engagementId,
      conversationId,
      userId: user.id,
      findCaseTitle: (id) => caseEngagementsRepository.findByEngagementId(id),
      onTargetsFailed: (error) => {
        log.warn('Case notify target resolution failed after commit — no fan-out', {
          engagementId,
          conversationId,
          userId: user.id,
          error: errorMessage(error),
        });
      },
    });
    if (targets !== undefined) {
      publishCaseFileShared({
        access,
        targets,
        title: caseTitle,
        senderName: uploadedByName,
        correlationId: row.id,
        fileName: row.fileName,
      });
    }

    log.info('Case conversation file shared', {
      engagementId,
      conversationId,
      userId: user.id,
      fileId: row.id,
      sizeBytes: verified.sizeBytes,
      contentType: verified.contentType,
    });

    return { success: true, file: fileView };
  } catch (error) {
    // A duplicate confirm (double-click / retry) is EXPECTED — warn, not error.
    if (isUniqueViolation(error)) {
      log.warn('Duplicate case file confirm (expected double-click)', {
        engagementId,
        userId: user.id,
        key,
      });
      return { success: false, error: 'This file was already shared.' };
    }
    log.error('Failed to confirm case file upload', {
      engagementId,
      userId: user.id,
      key,
      sizeBytes,
      error: errorMessage(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: 'Could not share your file. Please try again.' };
  }
}

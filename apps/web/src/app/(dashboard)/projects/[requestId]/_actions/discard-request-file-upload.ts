'use server';

import 'server-only';

import { z } from 'zod';
import { requestSharedFilesRepository } from '@balo/db';
import { requireOnboardedUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { deleteRequestFileFromR2 } from '@/lib/storage/request-file';
import { authorizeRequestFileScope } from '@/lib/request-files/authorize-request-file-scope';
import { validateRequestUploadKey } from '@/lib/request-files/request-upload-key';

const inputSchema = z.object({
  requestId: z.uuid(),
  key: z.string().min(1).max(512),
});

export type DiscardRequestFileUploadResult = { success: true } | { success: false };

/**
 * Discards an upload that was never shared — the sharer cancelled the dialog (or its upload) after
 * the bytes landed in R2 but before Share (BAL-617). Without it every cancelled share would leave
 * an unreferenced, never-reaped object under `request-files/`.
 *
 * ⚠ IT CAN ONLY EVER DELETE AN OBJECT THAT NOTHING CLAIMS, THAT THE CALLER UPLOADED, ON A REQUEST
 * THEY MAY SHARE ON:
 *  - the scope gate authorizes the actor/request, and the read-only admin lens is refused;
 *  - the key must be the caller's OWN key for THIS request (`validateRequestUploadKey`);
 *  - a key that ANY row — live or soft-deleted — already claims is refused and never deleted: a
 *    confirmed file's bytes are not a discard's to remove, and a tombstone's bytes belong to the
 *    soft-delete path.
 *
 * It ALWAYS RESOLVES with `{ success }` and never throws: it runs on a cancel path where there
 * is nothing useful to tell the user, and an R2 failure leaves a harmless orphan.
 */
export async function discardRequestFileUploadAction(
  input: z.infer<typeof inputSchema>
): Promise<DiscardRequestFileUploadResult> {
  let user;
  try {
    user = await requireOnboardedUser();
  } catch {
    return { success: false };
  }

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false };
  }
  const { requestId, key } = parsed.data;

  try {
    const scope = await authorizeRequestFileScope(user, requestId);
    if (!scope.ok || scope.side === 'admin') {
      log.warn('Request file discard refused: no share scope', { requestId, userId: user.id });
      return { success: false };
    }

    const keyError = validateRequestUploadKey(key, scope.request.id, user.id);
    if (keyError !== null) {
      log.warn('Request file discard refused: key is not the caller’s own', {
        requestId,
        userId: user.id,
      });
      return { success: false };
    }

    if (await requestSharedFilesRepository.isR2KeyClaimed(key)) {
      log.warn('Request file discard refused: key already claimed by a file', {
        requestId,
        userId: user.id,
        key,
      });
      return { success: false };
    }

    await deleteRequestFileFromR2(key);
    return { success: true };
  } catch (error) {
    log.error('Failed to discard request file upload', {
      requestId,
      userId: user.id,
      key,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false };
  }
}

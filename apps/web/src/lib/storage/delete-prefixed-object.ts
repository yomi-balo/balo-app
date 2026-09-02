import 'server-only';

import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { r2Client, R2_BUCKET } from '@/lib/storage/r2';
import { log } from '@/lib/logging';

/**
 * THE ONE R2 object-delete implementation (BAL-431 / OSD-4, extracted from
 * `conversation-file.ts`). Prefix-guarded and best-effort: a failure is logged, never thrown —
 * the tombstone plus the audit event are the record of record (Ruling 1).
 *
 * ⚠ EXTRACTED, NOT WIDENED. `deleteConversationFileFromR2` keeps its OWN prefix guard, and
 * `deleteRequestFileFromR2` gets its OWN — a guard that accepts two scopes protects neither.
 * There is exactly ONE implementation and NO `if (requestGrain)` fork at any caller; each
 * scope's storage module supplies its own `allowedPrefix` and `scopeLabel`.
 */
export async function deletePrefixedObjectFromR2(
  key: string,
  allowedPrefix: string,
  scopeLabel: string
): Promise<void> {
  // Prefix guard — refuse to delete anything outside this scope's key space.
  //
  // ⚠ NEVER A NORMAL CASE. Every caller derives its key from a row this scope owns, so a
  // mismatch is either a bug (a key built with the wrong prefix, a caller wired to the wrong
  // scope's helper) or an attempt to steer a delete at another scope's key space. Silence made
  // both indistinguishable from a successful delete. It stays a `return`, not a throw — delete
  // is best-effort by Ruling 1, and the tombstone plus the audit event are the record.
  if (!key.startsWith(allowedPrefix)) {
    log.warn('Refused an R2 delete outside the allowed prefix', { key, allowedPrefix, scopeLabel });
    return;
  }

  try {
    await r2Client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }));
  } catch (error) {
    log.warn(`Failed to delete ${scopeLabel} file from R2`, {
      key,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

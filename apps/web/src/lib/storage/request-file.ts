import 'server-only';

import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { r2Client, R2_BUCKET } from '@/lib/storage/r2';
import { deletePrefixedObjectFromR2 } from '@/lib/storage/delete-prefixed-object';
import {
  CONVERSATION_ALLOWED_CONTENT_TYPES,
  MAX_CONVERSATION_FILE_BYTES,
  CONVERSATION_FILE_ACCEPT,
} from './conversation-file-constraints';

/**
 * R2 storage seam for REQUEST-STAGE shared files (BAL-431 / ADR-1048 — the fifth file scope).
 * Mirrors `conversation-file.ts` structurally, with one deliberate difference: the key's first
 * segment is a REQUEST, not a conversation — a request-grain file has no single conversation.
 *
 * ⚠ THE ALLOW-LIST AND SIZE CAP ARE RE-EXPORTED FROM `./conversation-file-constraints`
 * DIRECTLY, NOT DUPLICATED. The rules are identical to conversation files; a second copy would
 * be new-code duplication (`npx jscpd`; memory `reference_sonar_duplication_not_caught_locally`).
 */

// ── Constants ──
/** Key prefix all request-shared files live under. */
export const REQUEST_FILE_PREFIX = 'request-files/';

export {
  CONVERSATION_ALLOWED_CONTENT_TYPES as REQUEST_FILE_ALLOWED_CONTENT_TYPES,
  MAX_CONVERSATION_FILE_BYTES as MAX_REQUEST_FILE_BYTES,
  CONVERSATION_FILE_ACCEPT as REQUEST_FILE_ACCEPT,
};

const UPLOAD_TTL_SECONDS = 60;
const DOWNLOAD_TTL_SECONDS = 300;

// ── Key generation ──
/**
 * Keys are scoped to REQUEST + uploader so the confirm action can verify provenance from the
 * GATE and the SESSION alone. Shape: `request-files/{projectRequestId}/{userId}/{uuid}`.
 *
 * ⚠ THE FIRST SEGMENT IS THE REQUEST, NOT A CONVERSATION, AND THAT IS THE WHOLE POINT: a
 * request-grain file has no single conversation. This is the SECOND deliberate key-layout break
 * in this family; BAL-424 made the first (`conversation-file.ts:38-42`, "there is deliberately
 * no compat read path"). There is no compat read path here either — this is a new prefix on a
 * new table, so nothing to be compatible with.
 *
 * ⚠ THE AUDIENCE IS NOT IN THE KEY, DELIBERATELY. Audience is dynamic and revocable; an R2 key
 * is permanent. Encoding it would create a second, stale source of truth.
 */
export function generateRequestFileKey(projectRequestId: string, userId: string): string {
  return `${REQUEST_FILE_PREFIX}${projectRequestId}/${userId}/${crypto.randomUUID()}`;
}

// ── Presigned PUT (server-only) ──
/**
 * ⚠ THE SIGNATURE IS BOUND TO AN EXACT BODY LENGTH. `ContentLength` is a SIGNED header for an
 * S3 presigned PUT (unlike `Content-Type`, which the S3 presigner marks unsignable), so R2
 * rejects a body of any other length at the edge — the size ceiling stops being enforceable
 * only by the confirm step's `HeadObject`, which an attacker can simply never call. `sizeBytes`
 * is the caller's Zod-validated, `MAX_REQUEST_FILE_BYTES`-bounded declared size; the confirm
 * step still re-reads the real size from R2, so this narrows the window rather than replacing
 * that check.
 */
export async function createPresignedRequestFileUpload(
  projectRequestId: string,
  userId: string,
  contentType: string,
  sizeBytes: number
): Promise<{ presignedUrl: string; key: string }> {
  if (!CONVERSATION_ALLOWED_CONTENT_TYPES.has(contentType)) {
    throw new Error(`Invalid content type: ${contentType}`);
  }
  if (!Number.isInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_CONVERSATION_FILE_BYTES) {
    throw new Error(`Invalid upload size: ${sizeBytes}`);
  }

  const key = generateRequestFileKey(projectRequestId, userId);
  const command = new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    ContentType: contentType,
    ContentLength: sizeBytes,
  });
  const presignedUrl = await getSignedUrl(r2Client, command, { expiresIn: UPLOAD_TTL_SECONDS });

  return { presignedUrl, key };
}

// ── Presigned GET (server-only) ──
/**
 * Short-lived download URL forcing an attachment disposition with the STORED file name
 * (quotes/control chars stripped so the header can't be broken).
 */
export async function createPresignedRequestFileDownload(
  key: string,
  fileName: string
): Promise<string> {
  // eslint-disable-next-line no-control-regex -- strip header-breaking control chars from the stored name
  const safeName = fileName.replaceAll(/["\\\x00-\x1f]/g, '_');
  const command = new GetObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    ResponseContentDisposition: `attachment; filename="${safeName}"`,
  });
  return getSignedUrl(r2Client, command, { expiresIn: DOWNLOAD_TTL_SECONDS });
}

// ── R2 deletion (server-only, fire-and-forget) ──
/**
 * Delegates to the ONE shared delete primitive (OSD-4) with the REQUEST-FILE prefix guard —
 * its own guard, never widened onto `deleteConversationFileFromR2`'s.
 */
export async function deleteRequestFileFromR2(key: string): Promise<void> {
  return deletePrefixedObjectFromR2(key, REQUEST_FILE_PREFIX, 'request');
}

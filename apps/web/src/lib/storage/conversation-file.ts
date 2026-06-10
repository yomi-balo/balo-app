import 'server-only';

import { PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { r2Client, R2_BUCKET } from '@/lib/storage/r2';
import { log } from '@/lib/logging';

/**
 * R2 storage seam for CONVERSATION files (BAL-271 / A4 — D5). Mirrors the
 * project-document presign pattern with two deliberate differences:
 *  - wider content-type allow-list (the design's worked example shares
 *    .docx/.xlsx) and a 10 MB cap;
 *  - downloads use PRESIGNED GETs — these files are private to the
 *    client↔expert pair, never served from `R2_PUBLIC_URL`.
 */

// ── Constants ──
/** Key prefix all conversation files live under. */
export const CONVERSATION_FILE_PREFIX = 'conversation-files/';

// Allow-list + cap live in the client-safe constraints module (the composer
// pre-validates); re-exported here so server callers keep one import site.
export {
  CONVERSATION_ALLOWED_CONTENT_TYPES,
  MAX_CONVERSATION_FILE_BYTES,
} from './conversation-file-constraints';
import { CONVERSATION_ALLOWED_CONTENT_TYPES } from './conversation-file-constraints';

const UPLOAD_TTL_SECONDS = 60;
const DOWNLOAD_TTL_SECONDS = 300;

// ── Key generation ──
/**
 * Keys are scoped to relationship + uploader so the confirm action can verify
 * provenance from the session alone. Shape:
 * `conversation-files/{relationshipId}/{userId}/{uuid}`.
 */
export function generateConversationFileKey(relationshipId: string, userId: string): string {
  return `${CONVERSATION_FILE_PREFIX}${relationshipId}/${userId}/${crypto.randomUUID()}`;
}

// ── Presigned PUT (server-only) ──
export async function createPresignedConversationFileUpload(
  relationshipId: string,
  userId: string,
  contentType: string
): Promise<{ presignedUrl: string; key: string }> {
  if (!CONVERSATION_ALLOWED_CONTENT_TYPES.has(contentType)) {
    throw new Error(`Invalid content type: ${contentType}`);
  }

  const key = generateConversationFileKey(relationshipId, userId);
  const command = new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    ContentType: contentType,
  });
  const presignedUrl = await getSignedUrl(r2Client, command, { expiresIn: UPLOAD_TTL_SECONDS });

  return { presignedUrl, key };
}

// ── Presigned GET (server-only) ──
/**
 * Short-lived download URL forcing an attachment disposition with the STORED
 * file name (quotes/control chars stripped so the header can't be broken).
 */
export async function createPresignedConversationFileDownload(
  key: string,
  fileName: string
): Promise<string> {
  // eslint-disable-next-line no-control-regex -- strip header-breaking control chars from the stored name
  const safeName = fileName.replaceAll(/["\\\u0000-\u001f]/g, '_');
  const command = new GetObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    ResponseContentDisposition: `attachment; filename="${safeName}"`,
  });
  return getSignedUrl(r2Client, command, { expiresIn: DOWNLOAD_TTL_SECONDS });
}

// ── R2 deletion (server-only, fire-and-forget) ──
export async function deleteConversationFileFromR2(key: string): Promise<void> {
  // Prefix guard — refuse to delete anything outside the conversation-files space.
  if (!key.startsWith(CONVERSATION_FILE_PREFIX)) return;

  try {
    await r2Client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }));
  } catch (error) {
    log.warn('Failed to delete conversation file from R2', {
      key,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

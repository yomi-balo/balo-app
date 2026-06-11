import 'server-only';

import { PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { r2Client, R2_BUCKET } from '@/lib/storage/r2';
import { log } from '@/lib/logging';

/**
 * R2 storage seam for PROPOSAL documents (A6.2 / BAL-288). Mirrors
 * `conversation-file.ts` exactly — presign PUT + presign-GET forced-attachment +
 * prefix-guarded R2 delete, downloads via short-lived PRESIGNED GETs (these
 * documents are private to the proposal's client↔expert pair, never served from
 * `R2_PUBLIC_URL`) and **no ClamAV scan**.
 *
 * The only deliberate difference from conversation files is the key scoping:
 * proposal documents are scoped to `{proposalId}/{userId}` (not relationship +
 * user), so the confirm action verifies provenance from the validated proposal +
 * session user alone.
 */

// ── Constants ──
/** Key prefix all proposal documents live under. */
export const PROPOSAL_DOCUMENT_PREFIX = 'proposal-documents/';

// Allow-list + cap live in the client-safe constraints module (the composer
// pre-validates); re-exported here so server callers keep one import site.
export {
  PROPOSAL_DOCUMENT_ALLOWED_CONTENT_TYPES,
  MAX_PROPOSAL_DOCUMENT_BYTES,
  PROPOSAL_DOCUMENT_ACCEPT,
} from './proposal-document-constraints';
import { PROPOSAL_DOCUMENT_ALLOWED_CONTENT_TYPES } from './proposal-document-constraints';

const UPLOAD_TTL_SECONDS = 60;
const DOWNLOAD_TTL_SECONDS = 300;

// ── Key generation ──
/**
 * Keys are scoped to proposal + uploader so the confirm action can verify
 * provenance from the validated proposal + session alone. Shape:
 * `proposal-documents/{proposalId}/{userId}/{uuid}`.
 */
export function generateProposalDocumentKey(proposalId: string, userId: string): string {
  return `${PROPOSAL_DOCUMENT_PREFIX}${proposalId}/${userId}/${crypto.randomUUID()}`;
}

// ── Presigned PUT (server-only) ──
export async function createPresignedProposalDocumentUpload(
  proposalId: string,
  userId: string,
  contentType: string
): Promise<{ presignedUrl: string; key: string }> {
  if (!PROPOSAL_DOCUMENT_ALLOWED_CONTENT_TYPES.has(contentType)) {
    throw new Error(`Invalid content type: ${contentType}`);
  }

  const key = generateProposalDocumentKey(proposalId, userId);
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
 * file name (quotes/control chars stripped so the header can't be broken) —
 * identical hardening to `createPresignedConversationFileDownload`.
 */
export async function createPresignedProposalDocumentDownload(
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
export async function deleteProposalDocumentFromR2(key: string): Promise<void> {
  // Prefix guard — refuse to delete anything outside the proposal-documents space.
  if (!key.startsWith(PROPOSAL_DOCUMENT_PREFIX)) return;

  try {
    await r2Client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }));
  } catch (error) {
    log.warn('Failed to delete proposal document from R2', {
      key,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

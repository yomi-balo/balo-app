import 'server-only';

import { PutObjectCommand, DeleteObjectCommand, CopyObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { MAX_PARSE_DOCUMENT_BYTES } from '@balo/shared/project-requests';
import { r2Client, R2_BUCKET } from '@/lib/storage/r2';
import { log } from '@/lib/logging';
import { CONVERSATION_FILE_PREFIX } from '@/lib/storage/conversation-file';
import { MEETING_FILE_PREFIX } from '@/lib/storage/meeting-file';

// ── Constants ──
/** Content types accepted for project documents. Mirrors `schemas.ts`. */
export const ALLOWED_CONTENT_TYPES = new Set<string>([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
]);
const PRESIGN_TTL_SECONDS = 60;
/** ⚠ ONE definition, in `@balo/shared` — the worker enforces the same cap (BAL-254 W3). */
export const MAX_DOCUMENT_BYTES = MAX_PARSE_DOCUMENT_BYTES;
/** Key prefix all project documents live under. */
export const PROJECT_DOCUMENT_PREFIX = 'project-documents/';

// ── Key generation ──
/**
 * Keys are scoped to company + user (NOT expert) — in Match mode there is no
 * expert, but the buyer org/user is always present and owns the request.
 * Shape: `project-documents/{companyId}/{userId}/{uuid}`.
 */
export function generateProjectDocumentKey(companyId: string, userId: string): string {
  return `${PROJECT_DOCUMENT_PREFIX}${companyId}/${userId}/${crypto.randomUUID()}`;
}

// ── Presigned URL generation (server-only) ──
export async function createPresignedProjectDocumentUpload(
  companyId: string,
  userId: string,
  contentType: string
): Promise<{ presignedUrl: string; key: string }> {
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    throw new Error(
      `Invalid content type: ${contentType}. Allowed: ${[...ALLOWED_CONTENT_TYPES].join(', ')}`
    );
  }

  const key = generateProjectDocumentKey(companyId, userId);

  const command = new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    ContentType: contentType,
  });

  const presignedUrl = await getSignedUrl(r2Client, command, {
    expiresIn: PRESIGN_TTL_SECONDS,
  });

  return { presignedUrl, key };
}

// ── R2 server-side copy (server-only) ──
/**
 * The case-files origin a source key belongs to, for log/error context — never the key itself.
 * `null` means the key is outside the case-files space.
 */
function caseFileSourceOrigin(srcKey: string): 'conversation' | 'meeting' | null {
  if (srcKey.startsWith(CONVERSATION_FILE_PREFIX)) return 'conversation';
  if (srcKey.startsWith(MEETING_FILE_PREFIX)) return 'meeting';
  return null;
}

/**
 * BAL-589 — server-side copy of ONE case file (`conversation-files/…` or `meeting-files/…`)
 * into the requester's `project-documents/{companyId}/{userId}/{uuid}` prefix, so converting a
 * case to a project never makes the client re-upload a file they already shared. Modelled on
 * `copyProposalDocumentObject` (A6.4 / BAL-290 document carryover) — bytes-identical copy, no
 * re-scan needed.
 *
 * Both ends are prefix-guarded: the source must be a case file (conversation OR meeting), the
 * destination must be a project document. Unlike the fire-and-forget delete, this RETHROWS on
 * failure — the calling action catches it, logs, and returns a friendly error rather than
 * reporting a copy that did not happen as a success.
 */
export async function copyCaseFileIntoProjectDocuments(
  srcKey: string,
  destKey: string
): Promise<void> {
  const sourceOrigin = caseFileSourceOrigin(srcKey);
  if (sourceOrigin === null) {
    throw new Error('Refusing to copy from a key outside the case-files space');
  }
  if (!destKey.startsWith(PROJECT_DOCUMENT_PREFIX)) {
    throw new Error('Refusing to copy to a key outside the project-documents space');
  }

  try {
    await r2Client.send(
      new CopyObjectCommand({
        Bucket: R2_BUCKET,
        // S3/R2 expects CopySource URL-encoded; encodeURI preserves the `/` key separators.
        CopySource: encodeURI(`${R2_BUCKET}/${srcKey}`),
        Key: destKey,
      })
    );
  } catch (error) {
    // ⚠ Never log the R2 key; the origin + message are enough to debug.
    log.warn('Failed to copy case file into project documents', {
      sourceOrigin,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

// ── R2 deletion (server-only, fire-and-forget) ──
export async function deleteProjectDocumentFromR2(key: string): Promise<void> {
  // Prefix guard — refuse to delete anything outside the project-documents space.
  if (!key.startsWith(PROJECT_DOCUMENT_PREFIX)) return;

  try {
    await r2Client.send(
      new DeleteObjectCommand({
        Bucket: R2_BUCKET,
        Key: key,
      })
    );
  } catch (error) {
    log.warn('Failed to delete project document from R2', {
      key,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

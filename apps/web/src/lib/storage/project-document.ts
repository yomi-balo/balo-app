import 'server-only';

import { PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { r2Client, R2_BUCKET } from '@/lib/storage/r2';
import { log } from '@/lib/logging';

// ── Constants ──
/** Content types accepted for project documents. Mirrors `schemas.ts`. */
export const ALLOWED_CONTENT_TYPES = new Set<string>([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
]);
const PRESIGN_TTL_SECONDS = 60;
export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024; // 5 MB
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

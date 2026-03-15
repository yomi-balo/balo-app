import 'server-only';

import { PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { r2Client, R2_BUCKET } from '@/lib/storage/r2';
import { log } from '@/lib/logging';

// ── Constants ──
const ALLOWED_CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const PRESIGN_TTL_SECONDS = 60;
// Note: R2 presigned PUT URLs do not support Content-Length-Range conditions
// (that requires presigned POST). Client-side compression targets ~1 MB output,
// so server-side size enforcement is deferred. If needed, use HeadObjectCommand
// in confirmAvatarUploadAction to verify object size before persisting.

// ── Avatar key generation ──
export function generateAvatarKey(userId: string): string {
  return `avatars/${userId}/${crypto.randomUUID()}.webp`;
}

// ── Presigned URL generation (server-only) ──
export async function createPresignedAvatarUpload(
  userId: string,
  contentType: string
): Promise<{ presignedUrl: string; key: string }> {
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    throw new Error(
      `Invalid content type: ${contentType}. Allowed: ${[...ALLOWED_CONTENT_TYPES].join(', ')}`
    );
  }

  const key = generateAvatarKey(userId);

  const command = new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    ContentType: contentType,
  });

  // @smithy/types version mismatch between @aws-sdk/client-s3 and @aws-sdk/s3-request-presigner
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const presignedUrl = await getSignedUrl(r2Client as any, command as any, {
    expiresIn: PRESIGN_TTL_SECONDS,
  });

  return { presignedUrl, key };
}

// ── R2 deletion (server-only, fire-and-forget) ──
export async function deleteAvatarFromR2(key: string): Promise<void> {
  if (!key.startsWith('avatars/')) return;

  try {
    await r2Client.send(
      new DeleteObjectCommand({
        Bucket: R2_BUCKET,
        Key: key,
      })
    );
  } catch (error) {
    log.warn('Failed to delete old avatar from R2', {
      key,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

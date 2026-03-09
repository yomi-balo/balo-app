'use server';
import 'server-only';

import { revalidatePath } from 'next/cache';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { withAuth } from '@/lib/auth/with-auth';
import { usersRepository } from '@balo/db';
import { log } from '@/lib/logging';
import { r2Client, R2_BUCKET, R2_PUBLIC_URL } from '@/lib/storage/r2';

const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5MB

const EXTENSION_MAP: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export interface UploadAvatarResult {
  success: boolean;
  avatarUrl?: string;
  error?: string;
}

export const uploadAvatarAction = withAuth(
  async (session, formData: FormData): Promise<UploadAvatarResult> => {
    try {
      const file = formData.get('file');
      if (!(file instanceof File)) {
        return { success: false, error: 'No file provided' };
      }

      // Validate MIME type
      if (!ALLOWED_TYPES.has(file.type)) {
        return {
          success: false,
          error: 'Invalid file type. Please upload a JPG, PNG, or WebP image.',
        };
      }

      // Validate size
      if (file.size > MAX_SIZE_BYTES) {
        return { success: false, error: 'Image must be smaller than 5MB.' };
      }

      const ext = EXTENSION_MAP[file.type] ?? 'jpg';
      const key = `avatars/${session.user.id}/${Date.now()}.${ext}`;

      // Read file bytes
      const buffer = Buffer.from(await file.arrayBuffer());

      // Upload to R2
      await r2Client.send(
        new PutObjectCommand({
          Bucket: R2_BUCKET,
          Key: key,
          Body: buffer,
          ContentType: file.type,
        })
      );

      const publicUrl = `${R2_PUBLIC_URL}/${key}`;

      // Update user avatar
      await usersRepository.update(session.user.id, { avatarUrl: publicUrl });

      log.info('Avatar uploaded', {
        userId: session.user.id,
        key,
      });

      revalidatePath('/expert/settings');

      return { success: true, avatarUrl: publicUrl };
    } catch (error) {
      log.error('Failed to upload avatar', {
        userId: session.user.id,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });

      return { success: false, error: 'Failed to upload photo. Please try again.' };
    }
  }
);

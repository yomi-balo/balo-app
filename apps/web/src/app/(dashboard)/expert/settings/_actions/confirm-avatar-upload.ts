'use server';
import 'server-only';

import { revalidatePath } from 'next/cache';
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { withAuth } from '@/lib/auth/with-auth';
import { usersRepository } from '@balo/db';
import { r2Client, R2_BUCKET } from '@/lib/storage/r2';
import { deleteAvatarFromR2 } from '@/lib/storage/avatar';
import { getSession } from '@/lib/auth/session';
import { log } from '@/lib/logging';

const MAX_AVATAR_BYTES = 5 * 1024 * 1024; // 5 MB
// avatars/{uuid userId}/{uuid}.webp
const AVATAR_KEY_PATTERN = /^avatars\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.webp$/;

export interface ConfirmAvatarUploadInput {
  key: string;
}

export interface ConfirmAvatarUploadResult {
  success: boolean;
  avatarUrl?: string; // R2 key for client state
  error?: string;
}

export const confirmAvatarUploadAction = withAuth(
  async (session, input: ConfirmAvatarUploadInput): Promise<ConfirmAvatarUploadResult> => {
    try {
      // Validate key format — must match exact shape and be scoped to user
      if (!AVATAR_KEY_PATTERN.test(input.key)) {
        return { success: false, error: 'Invalid upload key.' };
      }
      const expectedPrefix = `avatars/${session.user.id}/`;
      if (!input.key.startsWith(expectedPrefix)) {
        return { success: false, error: 'Invalid upload key.' };
      }

      // Verify uploaded object size in R2 before persisting
      const head = await r2Client.send(
        new HeadObjectCommand({ Bucket: R2_BUCKET, Key: input.key })
      );
      if (!head.ContentLength || head.ContentLength > MAX_AVATAR_BYTES) {
        deleteAvatarFromR2(input.key).catch(() => {});
        return {
          success: false,
          error: 'Uploaded file is too large. Please try a smaller image.',
        };
      }

      // Fetch current user to get old avatar key for cleanup
      const currentUser = await usersRepository.findById(session.user.id);
      const oldAvatarValue = currentUser?.avatarUrl;

      // Persist new key
      await usersRepository.update(session.user.id, { avatarUrl: input.key });

      // Update session so sidebar reflects new avatar immediately
      const currentSession = await getSession();
      if (currentSession.user) {
        currentSession.user.avatarUrl = input.key;
        await currentSession.save();
      }

      // Delete old avatar from R2 (fire-and-forget, non-blocking)
      // Only delete if old value is an R2 key (not a legacy full URL or OAuth URL)
      if (oldAvatarValue && !oldAvatarValue.startsWith('http')) {
        deleteAvatarFromR2(oldAvatarValue).catch(() => {
          // Already logged inside deleteAvatarFromR2
        });
      }

      log.info('Avatar upload confirmed', {
        userId: session.user.id,
        key: input.key,
        replacedOld: !!oldAvatarValue,
      });

      revalidatePath('/expert/settings');

      // Return R2 key — client renders through getAvatarUrl() at display time
      return { success: true, avatarUrl: input.key };
    } catch (error) {
      log.error('Failed to confirm avatar upload', {
        userId: session.user.id,
        key: input.key,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      return { success: false, error: 'Failed to save photo. Please try again.' };
    }
  }
);

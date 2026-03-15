'use server';
import 'server-only';

import { revalidatePath } from 'next/cache';
import { withAuth } from '@/lib/auth/with-auth';
import { usersRepository } from '@balo/db';
import { deleteAvatarFromR2 } from '@/lib/storage/avatar';
import { getSession } from '@/lib/auth/session';
import { log } from '@/lib/logging';

export interface RemoveAvatarResult {
  success: boolean;
  error?: string;
}

export const removeAvatarAction = withAuth(async (session): Promise<RemoveAvatarResult> => {
  try {
    // Fetch current user to get old avatar key for cleanup
    const currentUser = await usersRepository.findById(session.user.id);
    const oldAvatarValue = currentUser?.avatarUrl;

    await usersRepository.update(session.user.id, { avatarUrl: null });

    // Update session so sidebar reflects removal immediately
    const currentSession = await getSession();
    if (currentSession.user) {
      currentSession.user.avatarUrl = null;
      await currentSession.save();
    }

    // Clean up R2 (fire-and-forget) — only if old value is an R2 key
    if (oldAvatarValue && !oldAvatarValue.startsWith('http')) {
      deleteAvatarFromR2(oldAvatarValue).catch(() => {
        // Already logged inside deleteAvatarFromR2
      });
    }

    log.info('Avatar removed', {
      userId: session.user.id,
      deletedKey: oldAvatarValue && !oldAvatarValue.startsWith('http') ? oldAvatarValue : null,
    });

    revalidatePath('/expert/settings');

    return { success: true };
  } catch (error) {
    log.error('Failed to remove avatar', {
      userId: session.user.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    return { success: false, error: 'Failed to remove photo. Please try again.' };
  }
});

'use server';
import 'server-only';

import { revalidatePath } from 'next/cache';
import { withAuth } from '@/lib/auth/with-auth';
import { usersRepository } from '@balo/db';
import { log } from '@/lib/logging';

export interface RemoveAvatarResult {
  success: boolean;
  error?: string;
}

export const removeAvatarAction = withAuth(async (session): Promise<RemoveAvatarResult> => {
  try {
    await usersRepository.update(session.user.id, { avatarUrl: null });

    log.info('Avatar removed', {
      userId: session.user.id,
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

'use server';

import 'server-only';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { expertsRepository, usersRepository } from '@balo/db';
import { getSession } from '@/lib/auth/session';
import { log } from '@/lib/logging';

interface ApproveExpertResult {
  success: boolean;
  error?: string;
}

export async function approveExpertAction(
  expertProfileId: string,
  userId: string
): Promise<ApproveExpertResult> {
  if (process.env.NODE_ENV === 'production') {
    return { success: false, error: 'Not available in production.' };
  }

  // Auth: require an authenticated admin/super_admin
  const session = await getSession();
  if (!session?.user?.id) {
    return { success: false, error: 'Unauthorized' };
  }
  if (session.user.platformRole !== 'admin' && session.user.platformRole !== 'super_admin') {
    return { success: false, error: 'Forbidden: admin access required.' };
  }

  // Validate inputs
  const profileParsed = z.string().uuid().safeParse(expertProfileId);
  const userParsed = z.string().uuid().safeParse(userId);
  if (!profileParsed.success || !userParsed.success) {
    return { success: false, error: 'Invalid ID format.' };
  }

  try {
    // 1. Approve the expert profile (status: submitted -> approved, sets approvedAt)
    await expertsRepository.approveApplication(profileParsed.data);

    // 2. Switch user's activeMode to 'expert'
    await usersRepository.update(userParsed.data, { activeMode: 'expert' });

    log.info('Expert application approved via admin-dev', {
      expertProfileId: profileParsed.data,
      userId: userParsed.data,
    });

    revalidatePath('/admin-dev');
    return { success: true };
  } catch (error) {
    log.error('Failed to approve expert application', {
      expertProfileId,
      userId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to approve expert.',
    };
  }
}

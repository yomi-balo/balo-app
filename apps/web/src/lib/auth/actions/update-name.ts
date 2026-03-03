'use server';

import 'server-only';

import { z } from 'zod';
import { usersRepository } from '@balo/db';
import { getSession } from '@/lib/auth/session';
import { type AuthResult } from '@/lib/auth/errors';
import { withAuth } from '@/lib/auth/with-auth';
import { log } from '@/lib/logging';

const nameSchema = z.object({
  firstName: z
    .string()
    .trim()
    .min(1, 'First name is required')
    .max(50, 'First name is too long')
    .regex(/^[^<>]*$/, 'Name contains invalid characters'),
  lastName: z
    .string()
    .trim()
    .min(1, 'Last name is required')
    .max(50, 'Last name is too long')
    .regex(/^[^<>]*$/, 'Name contains invalid characters'),
});

export const updateNameAction = withAuth(
  async (session, input: { firstName: string; lastName: string }): Promise<AuthResult> => {
    const parsed = nameSchema.safeParse(input);
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
    }

    try {
      await usersRepository.update(session.user.id, {
        firstName: parsed.data.firstName,
        lastName: parsed.data.lastName,
      });

      // Re-fetch session to update cookie with new name
      const freshSession = await getSession();
      if (freshSession.user) {
        freshSession.user.firstName = parsed.data.firstName;
        freshSession.user.lastName = parsed.data.lastName;
        await freshSession.save();
      }

      log.info('User name updated during onboarding', {
        userId: session.user.id,
      });

      return { success: true };
    } catch (error) {
      log.error('Failed to update user name', {
        userId: session.user.id,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      return { success: false, error: 'Something went wrong. Please try again.' };
    }
  }
);

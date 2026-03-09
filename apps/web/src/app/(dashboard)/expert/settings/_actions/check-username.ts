'use server';
import 'server-only';

import { withAuth } from '@/lib/auth/with-auth';
import { expertsRepository } from '@balo/db';
import { log } from '@/lib/logging';
import { USERNAME_REGEX, RESERVED_USERNAMES, USERNAME_MIN, USERNAME_MAX } from './username-rules';

export interface CheckUsernameResult {
  available: boolean;
  error?: string;
}

export const checkUsernameAction = withAuth(
  async (session, input: { username: string }): Promise<CheckUsernameResult> => {
    if (session.user.activeMode !== 'expert' || !session.user.expertProfileId) {
      return { available: false, error: 'Expert profile required' };
    }

    const { username } = input;

    // Validate length
    if (username.length < USERNAME_MIN) {
      return { available: false, error: `Username must be at least ${USERNAME_MIN} characters` };
    }
    if (username.length > USERNAME_MAX) {
      return { available: false, error: `Username must be ${USERNAME_MAX} characters or fewer` };
    }

    // Validate format
    if (!USERNAME_REGEX.test(username)) {
      return {
        available: false,
        error: 'Username must be lowercase letters, numbers, and hyphens only',
      };
    }

    // Check reserved list
    if (RESERVED_USERNAMES.has(username)) {
      return { available: false, error: 'This username is reserved' };
    }

    // Check availability in database
    try {
      const isAvailable = await expertsRepository.checkUsernameAvailability(
        username,
        session.user.expertProfileId
      );

      return { available: isAvailable };
    } catch (error) {
      log.error('Failed to check username availability', {
        userId: session.user.id,
        expertProfileId: session.user.expertProfileId,
        username,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });

      return { available: false, error: 'Unable to check username. Please try again.' };
    }
  }
);

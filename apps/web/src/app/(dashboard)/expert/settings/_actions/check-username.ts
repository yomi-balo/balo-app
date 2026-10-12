'use server';
import 'server-only';

import { withAuth } from '@/lib/auth/with-auth';
import { resolveApprovedExpert, APPROVED_EXPERT_REQUIRED_ERROR } from '@/lib/auth/approved-expert';
import { expertsRepository } from '@balo/db';
import { log } from '@/lib/logging';
import { USERNAME_REGEX, RESERVED_USERNAMES, USERNAME_MIN, USERNAME_MAX } from './username-rules';

export interface CheckUsernameResult {
  available: boolean;
  error?: string;
}

export const checkUsernameAction = withAuth(
  async (session, input: { username: string }): Promise<CheckUsernameResult> => {
    let expertProfileId: string;
    try {
      const gate = await resolveApprovedExpert(session.user);
      if (!gate.ok) {
        return { available: false, error: APPROVED_EXPERT_REQUIRED_ERROR };
      }
      expertProfileId = gate.expertProfileId;
    } catch (error) {
      log.error('Failed to verify approved expert for username check', {
        userId: session.user.id,
        expertProfileId: session.user.expertProfileId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });

      return { available: false, error: 'Failed to check username. Please try again.' };
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
        expertProfileId
      );

      return { available: isAvailable };
    } catch (error) {
      log.error('Failed to check username availability', {
        userId: session.user.id,
        expertProfileId,
        username,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });

      return { available: false, error: 'Unable to check username. Please try again.' };
    }
  }
);

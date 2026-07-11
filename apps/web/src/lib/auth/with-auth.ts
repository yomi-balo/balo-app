import 'server-only';

import { getSession, type SessionData, type SessionUser } from './session';

export interface AuthenticatedSession extends SessionData {
  user: SessionUser;
}

type AuthenticatedAction<TArgs extends unknown[], TReturn> = (
  session: AuthenticatedSession,
  ...args: TArgs
) => Promise<TReturn>;

export interface WithAuthOptions {
  /** Opt out of the onboarding gate — ONLY for onboarding-flow actions. */
  allowUnonboarded?: boolean;
}

/**
 * Wraps a Server Action to require authentication.
 * Validates that a session exists and has a user before calling the action.
 *
 * Fail-closed onboarding gate: an un-onboarded session
 * (`onboardingCompleted !== true`) cannot execute the action unless the caller
 * opts out via `{ allowUnonboarded: true }` (onboarding-flow actions only).
 *
 * Usage:
 *   export const myAction = withAuth(async (session, input: MyInput) => {
 *     // session.user is guaranteed here, and onboarding is complete
 *   });
 */
export function withAuth<TArgs extends unknown[], TReturn>(
  action: AuthenticatedAction<TArgs, TReturn>,
  options?: WithAuthOptions
): (...args: TArgs) => Promise<TReturn> {
  return async (...args: TArgs): Promise<TReturn> => {
    const session = await getSession();
    if (!session?.user?.id) {
      throw new Error('Unauthorized');
    }
    if (options?.allowUnonboarded !== true && session.user.onboardingCompleted !== true) {
      throw new Error('Onboarding not completed');
    }
    return action(session as AuthenticatedSession, ...args);
  };
}

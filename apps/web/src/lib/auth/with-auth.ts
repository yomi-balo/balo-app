import 'server-only';

import { getSession, type SessionData, type SessionUser } from './session';

export interface AuthenticatedSession extends SessionData {
  user: SessionUser;
}

type AuthenticatedAction<TArgs extends unknown[], TReturn> = (
  session: AuthenticatedSession,
  ...args: TArgs
) => Promise<TReturn>;

/**
 * Wraps a Server Action to require authentication.
 * Validates that a session exists and has a user before calling the action.
 *
 * Usage:
 *   export const myAction = withAuth(async (session, input: MyInput) => {
 *     // session.user is guaranteed
 *   });
 */
export function withAuth<TArgs extends unknown[], TReturn>(
  action: AuthenticatedAction<TArgs, TReturn>
): (...args: TArgs) => Promise<TReturn> {
  return async (...args: TArgs): Promise<TReturn> => {
    const session = await getSession();
    if (!session?.user?.id) {
      throw new Error('Unauthorized');
    }
    return action(session as AuthenticatedSession, ...args);
  };
}

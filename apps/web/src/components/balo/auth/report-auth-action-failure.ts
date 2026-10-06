import * as Sentry from '@sentry/nextjs';

export const AUTH_ACTION_FAILED = 'Something went wrong. Please try again.';

/**
 * An auth Server Action that REJECTS — a module that throws on load, a dropped connection, a
 * stale deployment — never returns an `AuthResult`, so the step's `result.success` branches
 * never run. Without a `catch` the button resets and the modal shows nothing at all. Report the
 * error (the web logger is server-only; Sentry is the client sink) and hand back the message
 * the step renders in its `formError` slot.
 */
export function reportAuthActionFailure(error: unknown, action: string): string {
  Sentry.captureException(error, { tags: { auth_action: action } });
  return AUTH_ACTION_FAILED;
}

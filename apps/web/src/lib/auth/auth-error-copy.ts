/**
 * The ONE spelling of every auth failure the user is shown. `/login` renders these from its
 * `?error=` query parameter; the booking dialog's session-expiry panel re-authenticates in
 * place and hands {@link SESSION_EXPIRED_MESSAGE} straight to the modal.
 *
 * ⚠ EXTRACTED SO THERE IS NO SECOND SPELLING. A dialog that writes its own "your session has
 * expired" drifts from this one the moment either is reworded, and the two are shown in the
 * same flow.
 */

/** Shown when a live credential died and the user must re-authenticate to continue. */
export const SESSION_EXPIRED_MESSAGE = 'Your session has expired. Please sign in again.';

const ERROR_MESSAGES: Record<string, string> = {
  auth_failed: 'Authentication failed. Please try again.',
  missing_code: 'Authentication was incomplete. Please try again.',
  session_expired: SESSION_EXPIRED_MESSAGE,
  access_denied: 'Access was denied by the authentication provider.',
  account_suspended: 'Your account has been suspended. Please contact support.',
  account_deleted: 'Your account is no longer active. Please contact support.',
  // BAL-360: a live account already owns this email under a different identity and
  // the incoming profile was unverified — non-leaky copy (never reveal the method).
  account_exists:
    'An account with this email already exists. Please sign in with your original method.',
};

const VALID_ERROR_CODES = new Set(Object.keys(ERROR_MESSAGES));

/**
 * Resolve the user-facing auth error copy for a `?error=` query value. A known
 * code maps to its message; any other non-empty code falls back to the generic
 * failure copy; an absent code surfaces no error.
 */
export function resolveErrorMessage(errorCode: string | null): string | undefined {
  if (errorCode && VALID_ERROR_CODES.has(errorCode)) {
    return ERROR_MESSAGES[errorCode];
  }
  if (errorCode) {
    return ERROR_MESSAGES.auth_failed;
  }
  return undefined;
}

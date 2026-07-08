/**
 * BAL-350 — coarse auth-method signal carried on the session for onboarding
 * analytics. PURE and client-safe (NO `server-only`): the OAuth callback imports
 * `mapWorkosAuthMethod` as a value, while the client wizard / company step import
 * `AuthMethodSignal` as a type only.
 */

export type AuthMethodSignal = 'email' | 'oauth_google' | 'oauth_microsoft';

/**
 * Map a WorkOS `authenticationMethod` to Balo's coarse auth-method signal.
 * Returns `undefined` for non-OAuth / unknown methods (SSO, Password, Passkey,
 * MagicAuth, …) — never mislabel. Analytics treats an unset value as not-set and
 * handles it gracefully, so `undefined` is safe to thread everywhere.
 */
export function mapWorkosAuthMethod(workosMethod?: string): AuthMethodSignal | undefined {
  switch (workosMethod) {
    case 'GoogleOAuth':
      return 'oauth_google';
    case 'MicrosoftOAuth':
      return 'oauth_microsoft';
    default:
      return undefined;
  }
}

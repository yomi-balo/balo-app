/**
 * BAL-350 — coarse auth-method signal carried on the session for onboarding
 * analytics. PURE and client-safe (NO `server-only`): the OAuth callback imports
 * `mapWorkosAuthMethod` as a value, while the client wizard / company step import
 * `AuthMethodSignal` as a type only.
 *
 * `AuthMethodSignal` is defined once in `@balo/analytics` (the analytics vocabulary
 * owns the `auth_method` dimension) and re-exported here so existing
 * `@/lib/auth/auth-method` importers are unaffected — the union has a single
 * source of truth shared with the event maps.
 */

import type { AuthMethodSignal } from '@balo/analytics/events';

export type { AuthMethodSignal };

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

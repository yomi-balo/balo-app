/**
 * Result shapes for the phone-verification Server Actions (`./actions.ts`). Kept out of the
 * `'use server'` module, which may only export async functions.
 */

/**
 * Why a send or verify did not succeed. The `apps/api` literals pass through unchanged; the
 * web-side codes are:
 *   - `session_expired` — the api refused the Bearer as a dead credential (not a refusal of the
 *     request itself). Nothing was attempted server-side, so a retry is safe.
 *   - `impersonation_refused` — a staff member is impersonating this account. Its own code, and it
 *     must never read as `session_expired`: an impersonated session carries no access token by
 *     design, so the credential check always fails, and the "sign in again" that code offers would
 *     sign the STAFF MEMBER in and end the impersonation. No retry can change it.
 *   - `account_refused` — BAL-568: the account is suspended or deleted; the client must sign out.
 *   - `request_failed`  — transport failure, or a literal this client does not recognise.
 */
export type PhoneOtpFailureCode =
  | 'session_expired'
  | 'impersonation_refused'
  | 'account_refused'
  | 'request_failed'
  | 'invalid_phone'
  | 'landline_not_supported'
  | 'rate_limited'
  | 'brevo_rejected'
  | 'wrong_code'
  | 'final_attempt'
  | 'locked_out'
  | 'code_expired';

export type SendPhoneOtpResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: PhoneOtpFailureCode; readonly cooldownSeconds?: number };

export type VerifyPhoneOtpResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: PhoneOtpFailureCode; readonly attemptsRemaining?: number };

export type {
  ClientSmsConsentEventSurface as ClientSmsConsentSurface,
  ClientSmsConsentMethod,
  ClientSmsOptInSurface,
} from '@balo/analytics/events';

/**
 * The signed-in user's client SMS consent (BAL-655), as the opt-in card and account settings read
 * it. `opted_in` needs consent AND a verified number; a verified number alone is `not_opted_in`
 * with `verifiedPhone` set, which is what offers the one-click consent. `unavailable` covers an
 * impersonated session and a failed read: the surface renders nothing.
 */
export type ClientSmsConsentState =
  | { readonly status: 'opted_in'; readonly phone: string }
  | { readonly status: 'not_opted_in'; readonly verifiedPhone: string | null }
  | { readonly status: 'unavailable' };

export type ClientSmsConsentResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: 'phone_not_verified' | 'impersonation_refused' | 'request_failed';
    };

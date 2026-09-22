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

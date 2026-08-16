import type * as Ably from 'ably';

/**
 * BAL-437 — the CLIENT half of Ably token auth, extracted from
 * `components/balo/conversation/use-conversation-realtime.ts`.
 *
 * ⚠⚠ **NO `server-only` MARKER, DELIBERATELY.** This module is imported by `'use client'`
 * hooks; adding the marker would break `next build` for every one of them. The only import
 * above is `import type`, so nothing at all reaches a bundle from here except the two tiny
 * functions below.
 *
 * ⚠ EXTRACTED BECAUSE THE SECOND CONSUMER LANDED. The in-call hook needs the identical
 * node-callback plumbing plus the identical error narrowing (~45 lines) — the single largest
 * duplication block in BAL-437, and one where a copy would drift on the ONE thing that must
 * not drift (see {@link fetchRealtimeToken}).
 */

/**
 * What a token fetcher must return. Structurally identical to every `create*RealtimeTokenAction`
 * result on the platform, declared HERE rather than in one of them so no hook depends on a
 * route's action module (BAL-421).
 */
export type RealtimeTokenResult =
  | { success: true; tokenRequest: Ably.TokenRequest }
  | { success: false; disabled?: true; error?: string };

/** The node-callback Ably hands to `authCallback` implementations. */
export type AblyAuthResultCallback = Parameters<NonNullable<Ably.ClientOptions['authCallback']>>[1];

/**
 * Best-effort error → string for the auth callback: `Error` and Ably's `ErrorInfo` both carry a
 * string `.message` (structural narrowing, no `any`); anything else gets a fixed label instead
 * of '[object Object]'.
 */
export function authErrorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return error.message;
  }
  return 'Realtime token request failed';
}

/**
 * Fetch a token through a Server Action and report the result on Ably's contract.
 *
 * ⚠⚠ **NODE-CALLBACK STYLE, NOT A PROMISE-RETURNING `authCallback`.** An async `authCallback`
 * that returns a promise SILENTLY FAILS — no error, no connection, no clue. That is precisely
 * why this stays a `void`-returning function and why it is shared rather than copied: a second
 * copy is one `async` keyword away from an invisible outage on one surface only.
 */
export function fetchRealtimeToken(
  fetchToken: () => Promise<RealtimeTokenResult>,
  callback: AblyAuthResultCallback
): void {
  fetchToken()
    .then((result) => {
      if (result.success) {
        callback(null, result.tokenRequest);
      } else {
        callback(result.error ?? 'Realtime disabled', null);
      }
    })
    .catch((error: unknown) => {
      callback(authErrorMessage(error), null);
    });
}

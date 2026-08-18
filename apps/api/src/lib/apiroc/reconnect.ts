import type { ApirocError } from './errors.js';

export type CredentialVerdict =
  | { readonly kind: 'reconnect_required'; readonly marker: string }
  | { readonly kind: 'platform_auth_failure' }
  | { readonly kind: 'transient' }
  | { readonly kind: 'other' };

/**
 * ⚠ EXPERT-CREDENTIAL MARKERS ONLY — matched case-insensitively against `wireMessage`.
 * apiroc skill, credential-expiry table [live]:
 *   pre-flip  401 {"error":"InvalidRefreshToken","message":"Token has been expired or revoked."}
 *   post-flip 403 {"error":"Error","message":"End user account credential expired"}
 *   getCreds  403 {"error":"Error","message":"Invalid refresh token"}
 */
const EXPERT_CREDENTIAL_MARKERS = [
  'expired or revoked',
  'credential expired',
  'invalid refresh token',
] as const;

function wireMessageMatchesExpertMarker(wireMessage: string | undefined): boolean {
  if (wireMessage === undefined) return false;
  const lower = wireMessage.toLowerCase();
  return EXPERT_CREDENTIAL_MARKERS.some((marker) => lower.includes(marker));
}

/**
 * ⚠⚠ THE DISCRIMINATOR, AND WHY IT IS A POSITIVE MATCH (BAL-396 §10.4).
 *
 * A revoked EXPERT credential and a bad PLATFORM API key both arrive as HTTP 401 →
 * `AuthenticationError` → `ApirocError { kind: 'unauthorized' }`. They are distinguishable
 * ONLY by the message the SDK discards and `lib/apiroc/errors.ts` preserves (`wireMessage`).
 * A bad platform key's message was never captured, so this matches the EXPERT arm POSITIVELY
 * and treats everything else — including an ABSENT `wireMessage` — as platform. Matching the
 * platform arm negatively would blame the expert for every unrecognised 401.
 *
 * ⚠ ABSENT `wireMessage` ⇒ PLATFORM, NEVER EXPERT. The capture can be lost (the interceptor
 * degrades to `interceptorInstalled: false` on an SDK shape change). The asymmetry decides
 * it: a wrong "integration down" alert wakes an engineer; a wrong "reconnect required" emails
 * every expert instructions they cannot act on, and no un-send exists.
 *
 * ⚠ `wireErrorRaw` IS NOT READ. `errors.ts` — "UNKNOWN and UNPARSED — log-only evidence.
 * Never compare this to a literal." That includes the tempting `error: "InvalidRefreshToken"`.
 *
 * Rules, exhaustively:
 * | `err.kind`                                      | `wireMessage`        | Verdict               |
 * |--------------------------------------------------|-----------------------|------------------------|
 * | `unauthorized` (401)                              | contains a marker     | `reconnect_required`  |
 * | `unauthorized` (401)                              | no marker, or absent  | `platform_auth_failure`|
 * | `forbidden` (403)                                 | contains a marker     | `reconnect_required`  |
 * | `forbidden` (403)                                 | no marker, or absent  | `other` (log loudly; touch nothing) |
 * | `rate_limited` / `server_error` / `network`       | —                     | `transient`            |
 * | `validation` / `not_found` / `unknown`            | —                     | `other`                |
 */
export function classifyCredentialFailure(err: ApirocError): CredentialVerdict {
  if (err.kind === 'unauthorized') {
    if (wireMessageMatchesExpertMarker(err.wireMessage)) {
      return { kind: 'reconnect_required', marker: err.wireMessage as string };
    }
    return { kind: 'platform_auth_failure' };
  }

  if (err.kind === 'forbidden') {
    if (wireMessageMatchesExpertMarker(err.wireMessage)) {
      return { kind: 'reconnect_required', marker: err.wireMessage as string };
    }
    return { kind: 'other' };
  }

  if (err.kind === 'rate_limited' || err.kind === 'server_error' || err.kind === 'network') {
    return { kind: 'transient' };
  }

  // 'validation' | 'not_found' | 'unknown'
  return { kind: 'other' };
}

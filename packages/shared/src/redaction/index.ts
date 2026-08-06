/**
 * Secret-in-URL redaction (BAL-386, extended by BAL-390). Some public routes carry a
 * high-entropy secret in the URL path itself — the email-bound magic-link token behind
 * `/shared/proposals/{token}`, and the review-invite token behind
 * `/review/{token}`. Platform-wide instrumentation that captures the URL
 * verbatim (Edge middleware request logging → Axiom; PostHog client pageview
 * autocapture → third party) would otherwise defeat the "raw token is never logged"
 * invariant.
 *
 * {@link redactSensitivePath} is the single, pure, dependency-free implementation
 * shared by BOTH sinks. It is client- and Edge-safe (no Node/browser globals, no
 * `server-only`), so the web middleware and the analytics client import the SAME
 * function. Linear-time (a plain substring scan — deliberately no regex, so there is
 * no super-linear/ReDoS surface on attacker-controlled URLs).
 */

/**
 * Path prefixes whose FOLLOWING segment is a secret and must never be logged.
 *
 * ⚠ PAIRED with `PUBLIC_PREFIXES` in `apps/web/src/lib/auth/route-config.ts`: a
 * token-in-URL route is by definition reachable without a session, so every entry
 * here is also a public prefix there. Adding one registry without the other is the
 * defect. `route-config.test.ts` asserts the containment.
 */
export const SENSITIVE_PATH_PREFIXES: readonly string[] = [
  // BAL-386 — the email-bound magic-link proposal view.
  '/shared/proposals/',
  // BAL-390 — the star-rating landing, `/review/{token}?r={1..5}`. Only the token
  // SEGMENT is replaced, so the `?r=3` prefill survives redaction — which is what
  // keeps the emailed-star funnel legible without ever logging the token.
  '/review/',
];

const REDACTED = '[redacted]';

/**
 * Redact the secret segment that follows a known sensitive prefix, anywhere within
 * `value`. Accepts a bare pathname (`/shared/proposals/abc`) OR a full URL
 * (`https://host/shared/proposals/abc?x=1`) OR a referrer — the prefix is located by
 * substring so all three work. Only the single segment after the prefix is replaced;
 * any trailing path (`/more`), query (`?x`), or fragment (`#y`) is preserved.
 *
 *   `/shared/proposals/abc123`        → `/shared/proposals/[redacted]`
 *   `/shared/proposals/abc123?x=1`    → `/shared/proposals/[redacted]?x=1`
 *   `/shared/proposals/` (no token)   → unchanged
 *   `/dashboard`                      → unchanged
 */
export function redactSensitivePath(value: string): string {
  for (const prefix of SENSITIVE_PATH_PREFIXES) {
    const prefixIndex = value.indexOf(prefix);
    if (prefixIndex === -1) continue;

    const tokenStart = prefixIndex + prefix.length;
    // The secret runs until the next path/query/fragment delimiter, or the end.
    let tokenEnd = value.length;
    for (let i = tokenStart; i < value.length; i += 1) {
      const ch = value[i];
      if (ch === '/' || ch === '?' || ch === '#') {
        tokenEnd = i;
        break;
      }
    }
    // Prefix present but no actual token segment (e.g. a bare `/shared/proposals/`).
    if (tokenEnd === tokenStart) return value;
    return value.slice(0, tokenStart) + REDACTED + value.slice(tokenEnd);
  }
  return value;
}

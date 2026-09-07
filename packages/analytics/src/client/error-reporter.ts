/**
 * BAL-529 §A — the browser-side analytics error reporter seam.
 *
 * `packages/analytics` has no browser-safe logger of its own: `@balo/shared/logging` is
 * Pino + Node-only transports, and `console.*` is banned in application code (CLAUDE.md).
 * The repo's established client-side equivalent is `Sentry.captureException` — but
 * `@sentry/nextjs` is a Next.js-coupled dependency this framework-agnostic package (also
 * consumed by the Fastify `apps/api`) must not carry, and it would drag the Sentry SDK into
 * this package's own **node-environment** vitest project for a purely browser-side concern.
 *
 * So the host app INJECTS a reporter instead. `apps/web`'s `PostHogProvider` installs one
 * backed by `Sentry.captureException` before `initAnalytics()` runs. With no reporter
 * installed (e.g. `apps/api`, or a test that never wires one), failures are silently
 * swallowed — deliberately: analytics must never strand the caller's state transition.
 */
export type AnalyticsErrorReporter = (
  error: unknown,
  context: { readonly method: 'init' | 'identify' | 'track' | 'page' | 'reset' }
) => void;

let reporter: AnalyticsErrorReporter | null = null;

/** Install the host app's browser-safe reporter. `null` uninstalls (tests). */
export function setAnalyticsErrorReporter(next: AnalyticsErrorReporter | null): void {
  reporter = next;
}

/**
 * ⚠⚠ THIS FUNCTION MUST NEVER THROW. The whole point of BAL-529 §A is that an analytics
 * failure cannot strand the caller's state transition; a reporter that throws would move the
 * problem one frame outward rather than fixing it. So the reporter call is itself guarded.
 */
export function reportAnalyticsError(
  error: unknown,
  method: 'init' | 'identify' | 'track' | 'page' | 'reset'
): void {
  const current = reporter;
  if (current === null) return;
  try {
    current(error, { method });
  } catch {
    // The reporter itself failed. There is nothing left to report it TO.
  }
}

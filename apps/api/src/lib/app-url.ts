/**
 * The user-facing base URL of the web app, resolved SERVER-SIDE from `APP_URL` — the same
 * variable every other user-facing link in apps/api already trusts (notification email
 * templates, the calendar OAuth callback).
 *
 * ⚠ THE ONLY SOURCE OF A `return_url` FOR STRIPE. Never accept a browser-supplied one: a
 * client-controlled value would let a caller choose where Stripe bounces the user after 3DS —
 * an open redirect carrying the platform's own domain as the referrer. Callers pass the path
 * they want; the origin is never theirs to choose.
 */
export function resolveAppUrl(path = ''): string {
  const base = process.env.APP_URL ?? 'http://localhost:3000';
  const trimmed = base.endsWith('/') ? base.slice(0, -1) : base;
  return `${trimmed}${path}`;
}

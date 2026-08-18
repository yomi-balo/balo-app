/**
 * BAL-396 fix round 2, Finding 1 — the SINGLE shared source for the OAuth-connect CSRF-binding
 * cookie's name(s) and its `Domain` derivation.
 *
 * `apps/web` (`_lib/calendar-connect-cookie.ts`) SETS this cookie right after
 * `POST /api/calendar/connect` returns, before handing `authUrl` to the browser. `apps/api`
 * (`services/calendar/connect-state.ts`, `routes/calendar/auth.ts`) READS and CLEARS it at the
 * `GET /auth/apiroc/callback` — the CSRF binding proving the browser completing the callback is
 * the one that started the flow. Both sides import from HERE instead of re-deriving, closing
 * three defects the first fix round introduced by hand-duplicating this logic:
 *
 *   (a) apps/web's derivation hard-depended on `process.env.APP_URL` alone. `apps/web/.env.example`
 *       has historically shipped only `NEXT_PUBLIC_APP_URL` (see
 *       `apps/web/src/lib/meetings/join-link.ts`'s `meetingJoinLinkUrl`, which reads the SAME
 *       two-variable fallback for exactly this reason) — an env set that way made `cookieDomain()`
 *       return `undefined` unconditionally, the cookie went out host-only on `balo.expert`,
 *       `api.balo.expert` never received it, and EVERY calendar connect failed closed with
 *       `state_csrf_mismatch`. Fixed here by reading `APP_URL` first (apps/api's only variable,
 *       and every cross-app link in the platform already prefers it) and falling back to
 *       `NEXT_PUBLIC_APP_URL` — a no-op on apps/api, which has no such variable.
 *   (b) The two hand-written derivations disagreed on `localhost`: apps/web emitted a
 *       `Domain=localhost` attribute (from `new URL(...).hostname` unconditionally), apps/api
 *       suppressed it (`hostname !== 'localhost'`). A cookie's `Domain` (present vs. absent) is
 *       part of its IDENTITY under RFC 6265, so with `APP_URL=http://localhost:3000` (the natural
 *       dev value) apps/api's "clear" `Set-Cookie` targeted a DIFFERENT cookie than the one
 *       apps/web had set — removing nothing, leaving the nonce alive for its full 10-minute
 *       `Max-Age`. Fixed by excluding `localhost` HERE, once, so both sides agree by construction.
 *   (c) The cookie-name literal was duplicated by hand across three files, on the FALSE premise
 *       (both docblocks asserted it) that "apps/api does not share a package with apps/web" — it
 *       does: `@balo/shared` is a `workspace:*` dependency of both (`apps/web/package.json`,
 *       `apps/api/package.json`), and apps/web already imports it in production
 *       (`middleware.ts`). No test cross-checked the two literals, so a one-sided rename would
 *       have shipped green through CI and silently disabled the CSRF binding.
 *
 * Also carries the BAL-396 fix round 2, Finding 5 fix: the cookie is scoped PER PROVIDER
 * (`balo_calendar_connect_nonce_google` / `..._microsoft`), not one shared slot, so starting a
 * Google connect and then a Microsoft connect before either completes no longer clobbers the
 * first attempt's nonce.
 */

export type CalendarConnectProvider = 'google' | 'microsoft';

/** The full, closed set of providers a connect-nonce cookie can be scoped to. */
export const CALENDAR_CONNECT_PROVIDERS: readonly CalendarConnectProvider[] = [
  'google',
  'microsoft',
];

const CONNECT_NONCE_COOKIE_PREFIX = 'balo_calendar_connect_nonce';

/** The `Set-Cookie` / `Cookie` name for `provider`'s in-flight connect nonce. */
export function calendarConnectNonceCookieName(provider: CalendarConnectProvider): string {
  return `${CONNECT_NONCE_COOKIE_PREFIX}_${provider}`;
}

/**
 * The registrable hostname to scope the cookie's `Domain` attribute to, so apps/api (a
 * different subdomain in every deployed environment — `api.balo.expert` vs. `balo.expert`) can
 * read a cookie apps/web set. `Domain` is part of a cookie's identity: a `Domain` that does not
 * suffix-match the responding origin makes the browser reject the `Set-Cookie` outright, so this
 * is read from an env var alone (never a hardcoded fallback) and `undefined` is returned —
 * meaning "host-only cookie" — whenever no usable value is configured.
 *
 * Reads `APP_URL` first (apps/api's ONLY variable for this, and the one every other
 * cross-app link in the platform already prefers), falling back to `NEXT_PUBLIC_APP_URL` (the
 * variable `apps/web/.env.example` has historically shipped alone — see this file's docblock,
 * defect (a)). `NEXT_PUBLIC_APP_URL` is never read on apps/api; it is simply never set there, so
 * this reduces to "read `APP_URL`" on that side.
 *
 * `localhost` is EXCLUDED on both sides by construction (defect (b)) — in local dev, both apps
 * get a host-only cookie for their own origin, which the browser already shares across ports
 * (ports are not part of a cookie's scope).
 */
export function calendarConnectCookieDomain(): string | undefined {
  const appUrl = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) return undefined;
  try {
    const hostname = new URL(appUrl).hostname;
    return hostname === 'localhost' ? undefined : hostname;
  } catch {
    return undefined;
  }
}

import 'server-only';

import { cookies } from 'next/headers';
import {
  calendarConnectCookieDomain,
  calendarConnectNonceCookieName,
  type CalendarConnectProvider,
} from '@balo/shared/calendar';

/**
 * BAL-396 fix round, Finding 1 (round 2: cookie name + `Domain` moved to
 * `@balo/shared/calendar`) — the OAuth-connect CSRF binding cookie.
 *
 * `POST /api/calendar/connect` (apps/api) mints a signed `state` carrying a fresh `nonce` and
 * hands it straight back to us. Binding that nonce to a short-lived, HttpOnly cookie set here
 * (the layer that owns the browser's request/response cycle — apps/api never sees the browser
 * until the OAuth callback) proves the browser completing the callback is the one that started
 * the flow: an attacker who mints a connect URL for their OWN profile and hands it to a victim
 * never holds the victim's cookie, so the callback rejects it instead of binding the victim's
 * calendar to the attacker's expert profile.
 *
 * The cookie NAME and `Domain` derivation used to be hand-duplicated here and in
 * `apps/api/src/services/calendar/connect-state.ts`, on the false premise that apps/web and
 * apps/api "do not share a package" — `@balo/shared` is a `workspace:*` dependency of both, and
 * apps/web already imports it elsewhere (`middleware.ts`). See
 * `packages/shared/src/calendar/connect-cookie.ts`'s docblock for the three defects that
 * hand-duplication caused. Also scoped PER PROVIDER now (Finding 5) — see that same docblock.
 */

/** Matches `connect-state.ts`'s `STATE_TTL_MS` (10 minutes) — the cookie must outlive the
 *  state it binds, never outlast it by more than a beat. */
const CONNECT_NONCE_COOKIE_MAX_AGE_SECONDS = 10 * 60;

/** Sets the CSRF-binding cookie for a freshly-minted connect `nonce`, scoped to `provider` so
 *  starting a connect for one provider and then the other before either completes cannot
 *  clobber the first attempt's nonce. Call this — and only this — right after
 *  `POST /api/calendar/connect` returns, before handing `authUrl` back to the client for the
 *  browser to navigate to. */
export async function setCalendarConnectNonceCookie(
  nonce: string,
  provider: CalendarConnectProvider
): Promise<void> {
  const domain = calendarConnectCookieDomain();
  const cookieStore = await cookies();
  cookieStore.set(calendarConnectNonceCookieName(provider), nonce, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: CONNECT_NONCE_COOKIE_MAX_AGE_SECONDS,
    path: '/',
    ...(domain ? { domain } : {}),
  });
}

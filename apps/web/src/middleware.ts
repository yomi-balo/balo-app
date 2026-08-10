import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import type { SessionData } from '@/lib/auth/session';
import {
  getMiddlewareSession,
  refreshSessionIfNeeded,
  clearMiddlewareSession,
} from '@/lib/auth/middleware-session';
import {
  isPublicRoute,
  isAdminRoute,
  isApiRoute,
  isOnboardingRoute,
  isValidReturnTo,
  ONBOARDING_PATH,
} from '@/lib/auth/route-config';
import { COOKIE_NAME } from '@/lib/auth/session-config';
import { redactSensitivePath } from '@balo/shared/redaction';

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;
  const requestId = crypto.randomUUID();

  // A secret-bearing path (e.g. the `/shared/proposals/{token}` magic link) must never
  // be logged verbatim — redact the token segment before it reaches Axiom (BAL-386).
  const safePath = redactSensitivePath(pathname);

  // Structured JSON log compatible with Axiom ingestion.
  // Pino is not available in Edge Runtime, so we use console.log with JSON.
  console.log(
    JSON.stringify({
      level: 'info',
      msg: 'Request',
      requestId,
      method: request.method,
      path: safePath,
      timestamp: new Date().toISOString(),
    })
  );

  const addRequestId = (res: NextResponse): NextResponse => {
    res.headers.set('x-request-id', requestId);
    return res;
  };

  const publicRoute = isPublicRoute(pathname);
  const hasSessionCookie = request.cookies.has(COOKIE_NAME);

  // ── Anonymous visitor on a public route → fast path, no session decode ──
  // Preserves the zero-iron-session-work path for logged-out marketing/SEO traffic.
  if (publicRoute && !hasSessionCookie) {
    return addRequestId(NextResponse.next());
  }

  // Everything else needs the session decoded:
  //  - protected routes (always), and
  //  - public routes WITH a session cookie (so the fail-closed onboarding gate
  //    runs on public routes too — an authenticated un-onboarded user cannot slip
  //    through to /experts, /pricing, /, …).
  try {
    const result = await handleSessionedRoute(request, pathname, publicRoute);
    return addRequestId(result);
  } catch (error) {
    console.log(
      JSON.stringify({
        level: 'error',
        msg: 'Middleware session error',
        requestId,
        path: safePath,
        error: error instanceof Error ? error.message : 'Unknown',
        timestamp: new Date().toISOString(),
      })
    );
    // A decode failure on a public route must NOT trap the user — serve it anonymously.
    if (publicRoute) return addRequestId(NextResponse.next());
    return addRequestId(await redirectToLogin(request, pathname));
  }
}

// ── Sessioned route handling ─────────────────────────────────────

async function handleSessionedRoute(
  request: NextRequest,
  pathname: string,
  publicRoute: boolean
): Promise<NextResponse> {
  const { session, response } = await getMiddlewareSession(request);

  if (!session?.user?.id) {
    // Cookie present but no valid session (stale/expired). Public → view anonymously;
    // protected → login (which clears the dead cookie).
    if (publicRoute) return NextResponse.next();
    return redirectToLogin(request, pathname);
  }

  const refreshedResponse = await refreshSessionIfNeeded(request, session);
  const activeResponse = refreshedResponse ?? response;

  const guardRedirect = checkRouteGuards(session.user, pathname, request.url, activeResponse);
  return guardRedirect ?? activeResponse;
}

function checkRouteGuards(
  user: NonNullable<SessionData['user']>,
  pathname: string,
  baseUrl: string,
  activeResponse: NextResponse
): NextResponse | null {
  if (isAdminRoute(pathname)) {
    const role = user.platformRole ?? 'user';
    if (role !== 'admin' && role !== 'super_admin') {
      return redirectWithCookies(new URL('/dashboard', baseUrl), activeResponse);
    }
  }

  // API routes never HTTP-redirect (would break XHR/RSC fetches); route-level auth
  // enforces authorization. This also keeps /api/auth/* (session-sync, callback, and
  // the sign-out Server Action target) reachable during onboarding.
  if (isApiRoute(pathname)) {
    return null;
  }

  // ── FAIL-CLOSED onboarding gate — redirect UNLESS onboardingCompleted === true.
  // Runs for every non-API route incl. public marketing/marketplace routes, so an
  // authenticated un-onboarded user can reach ONLY onboarding routes (+ sign-out,
  // which POSTs to /onboarding as a Server Action). undefined/null now redirect.
  if (user.onboardingCompleted !== true && !isOnboardingRoute(pathname)) {
    return redirectToOnboarding(pathname, baseUrl, activeResponse);
  }

  // Completed-user bounce off the bare wizard root (keyed on the exact path — a
  // completed user who opens /onboarding/join-result still sees the terminal screen).
  if (user.onboardingCompleted === true && pathname === ONBOARDING_PATH) {
    return redirectWithCookies(new URL('/dashboard', baseUrl), activeResponse);
  }

  return null;
}

// ── Helpers ─────────────────────────────────────────────────────

/** Transfer Set-Cookie headers from a source response to a redirect response. */
function redirectWithCookies(url: URL, source: NextResponse): NextResponse {
  const redirect = NextResponse.redirect(url);
  for (const cookie of source.headers.getSetCookie()) {
    redirect.headers.append('set-cookie', cookie);
  }
  return redirect;
}

/**
 * BAL-361: redirect an un-onboarded authenticated user to the wizard, tagging the
 * origin so the landing can emit analytics (Edge can't run posthog-node). The `from`
 * value is an analytics string only — it is never used for navigation.
 *
 * ⚠ REDACTED BEFORE IT IS STASHED, AND THAT IS NOT BELT-AND-BRACES. The gate above is
 * fail-closed for EVERY non-API route, including the public token-in-URL landings
 * (`/join/{token}`, `/review/{token}`, `/shared/proposals/{token}`). An authenticated
 * but un-onboarded visitor who opens one of those would otherwise have the raw secret
 * copied into this query value, from where it reaches (1) the `Location:` header and so
 * every edge/CDN access log, (2) the browser address bar on `/onboarding`, which is NOT
 * covered by the `referrer: 'no-referrer'` that only the landing's own layout sets, and
 * (3) PostHog — `onboarding-wizard.tsx` reads `?from=` back and passes it as a CUSTOM
 * property to `track()`, and `sanitizeAnalyticsEvent` only rewrites `$current_url` /
 * `$pathname` / `$referrer`, never custom properties.
 *
 * Redaction costs nothing precisely because the value is analytics-only: the wizard
 * buckets on the PREFIX, and `/join/[redacted]` buckets identically to `/join/{token}`.
 * (`redactSensitivePath` also matches the percent-encoded form, so the encoding
 * `URLSearchParams` applies below cannot reintroduce the leak.)
 */
function redirectToOnboarding(
  fromPathname: string,
  baseUrl: string,
  source: NextResponse
): NextResponse {
  const url = new URL(ONBOARDING_PATH, baseUrl);
  url.searchParams.set('forced', '1');
  url.searchParams.set('from', redactSensitivePath(fromPathname));
  return redirectWithCookies(url, source);
}

/**
 * ⚠ `returnTo` IS REDACTED FOR THE SAME REASON `from` IS, one function up.
 *
 * This is UNREACHABLE TODAY and the redaction is still correct. All three token-in-URL
 * landings are registered in `PUBLIC_PREFIXES`, so `middleware` returns before this function
 * on any of them — meaning the only thing standing between a raw guest token and the
 * `Location:` header is a route-registry entry in a DIFFERENT file, guarded by one
 * containment test (`route-config.test.ts`). That is a thin guarantee for a live credential:
 * de-register `/join/` as public, or add a fourth sensitive prefix and forget the public
 * entry, and this line starts copying the token into the login URL, the CDN access log and
 * the browser address bar — with nothing failing to say so.
 *
 * Redaction costs nothing here because `returnTo` only has to survive `isValidReturnTo` and
 * name a destination; and a redacted `/join/[redacted]` is not a valid destination anyway,
 * which is the honest outcome — a guest link cannot be resumed through a login round-trip,
 * so the correct behaviour is to send them to `/login` plainly rather than to leak the token
 * in the attempt.
 */
async function redirectToLogin(request: NextRequest, pathname: string): Promise<NextResponse> {
  const loginUrl = new URL('/login', request.url);
  const returnTo = redactSensitivePath(pathname + request.nextUrl.search);
  if (isValidReturnTo(returnTo)) {
    loginUrl.searchParams.set('returnTo', returnTo);
  }

  // Only clear session if a cookie actually exists (avoid unnecessary iron-session work
  // on every anonymous page hit)
  const hasCookie = request.cookies.has(COOKIE_NAME);
  if (!hasCookie) {
    return NextResponse.redirect(loginUrl);
  }

  try {
    const clearedResponse = await clearMiddlewareSession(request);
    const redirectResponse = NextResponse.redirect(loginUrl);
    for (const cookie of clearedResponse.headers.getSetCookie()) {
      redirectResponse.headers.append('set-cookie', cookie);
    }
    return redirectResponse;
  } catch {
    return NextResponse.redirect(loginUrl);
  }
}

export const config = {
  matcher: [
    // Match all routes except static files
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};

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
  isValidReturnTo,
  ONBOARDING_PATH,
} from '@/lib/auth/route-config';
import { COOKIE_NAME } from '@/lib/auth/session-config';

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;
  const requestId = crypto.randomUUID();

  // Structured JSON log compatible with Axiom ingestion.
  // Pino is not available in Edge Runtime, so we use console.log with JSON.
  console.log(
    JSON.stringify({
      level: 'info',
      msg: 'Request',
      requestId,
      method: request.method,
      path: pathname,
      timestamp: new Date().toISOString(),
    })
  );

  const addRequestId = (res: NextResponse): NextResponse => {
    res.headers.set('x-request-id', requestId);
    return res;
  };

  // ── Public routes — pass through ──────────────────────────────
  if (isPublicRoute(pathname)) {
    return addRequestId(NextResponse.next());
  }

  // ── Protected routes — read session ───────────────────────────
  try {
    const result = await handleProtectedRoute(request, pathname);
    return addRequestId(result);
  } catch (error) {
    console.log(
      JSON.stringify({
        level: 'error',
        msg: 'Middleware session error',
        requestId,
        path: pathname,
        error: error instanceof Error ? error.message : 'Unknown',
        timestamp: new Date().toISOString(),
      })
    );
    return addRequestId(await redirectToLogin(request, pathname));
  }
}

// ── Protected route handling ─────────────────────────────────────

async function handleProtectedRoute(request: NextRequest, pathname: string): Promise<NextResponse> {
  const { session, response } = await getMiddlewareSession(request);

  if (!session?.user?.id) {
    return redirectToLogin(request, pathname);
  }

  const refreshedResponse = await refreshSessionIfNeeded(request, session);
  const activeResponse = refreshedResponse ?? response;

  const guardRedirect = checkRouteGuards(session.user, pathname, request.url, activeResponse);
  if (guardRedirect) {
    return guardRedirect;
  }

  return activeResponse;
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

  if (isApiRoute(pathname)) {
    return null;
  }

  if (user.onboardingCompleted === false && pathname !== ONBOARDING_PATH) {
    return redirectWithCookies(new URL(ONBOARDING_PATH, baseUrl), activeResponse);
  }

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

async function redirectToLogin(request: NextRequest, pathname: string): Promise<NextResponse> {
  const loginUrl = new URL('/login', request.url);
  const returnTo = pathname + request.nextUrl.search;
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

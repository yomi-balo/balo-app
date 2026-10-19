/**
 * Session helpers for Next.js middleware (Edge Runtime).
 *
 * Why a separate file from session.ts?
 *   - session.ts imports 'server-only' (fails in Edge Runtime)
 *   - session.ts uses cookies() from next/headers (unavailable in middleware)
 *   - Middleware reads and writes the request/response cookies directly — see
 *     {@link responseForSessionWrites} for how a refresh reaches both the browser and the
 *     request being handled
 */

import { getIronSession, type IronSession } from 'iron-session';
import { WorkOS } from '@workos-inc/node';
import { NextRequest, NextResponse } from 'next/server';
import type { SessionData } from './session';
import { sessionConfig, impersonatedSessionConfig } from './session-config';
import { isAccessTokenExpired } from './access-token';

/** Buffer before actual JWT expiry to trigger proactive refresh (seconds) */
const REFRESH_BUFFER_SECONDS = 60;

// ── WorkOS singleton (Edge-safe, separate from config.ts) ─────

let _workos: WorkOS;
function getWorkOS(): WorkOS {
  if (!_workos) {
    const apiKey = process.env.WORKOS_API_KEY;
    if (!apiKey) throw new Error('WORKOS_API_KEY is not set');
    _workos = new WorkOS(apiKey);
  }
  return _workos;
}

/** One `set` call iron-session's cookie-store form makes on `save()` or `destroy()`. */
type CookieWrite = Parameters<NextResponse['cookies']['set']>;

/**
 * The middleware response for a rewritten session cookie — a refreshed seal, or a destroyed one
 * when WorkOS has ended the session: the new value forwarded to THIS request, and one
 * `Set-Cookie` for the browser.
 *
 * ⚠⚠ THE REQUEST HALF IS THE POINT. The request that triggered the refresh goes on to the page
 * render, a Server Action or a Route Handler, and each reads the session through `cookies()`.
 * Forwarding it with its `cookie` header rewritten (`NextResponse.next({ request: { headers } })`)
 * makes that read return the live token. Neither obvious alternative works:
 *   - `getIronSession(request, response, …)` saves with a raw `set-cookie` header, which reaches
 *     only the browser. This request still reads the EXPIRED token and every `apps/api` call it
 *     makes 401s.
 *   - `response.cookies.set` does reach this request (via `x-middleware-set-cookie`), but Next then
 *     counts the cookie as CHANGED BY a Server Action the refresh lands on: the action responds
 *     `x-action-revalidated`, re-renders the whole route, and the client purges its router cache.
 *     The in-call page polls with Server Actions, so it would take that mid-call.
 *
 * ⚠ THE OVERRIDE CARRIES EVERY REQUEST HEADER. Next drops any downstream request header missing
 * from `x-middleware-override-headers`, so the forwarded headers start as a full copy.
 */
function responseForSessionWrites(
  request: NextRequest,
  writes: readonly CookieWrite[]
): NextResponse {
  const forwarded = new NextRequest(request.url, { headers: new Headers(request.headers) });
  // Serialises the browser cookie with Next's attribute handling; its own
  // `x-middleware-set-cookie` is discarded with it.
  const serializer = NextResponse.next();
  for (const write of writes) {
    const [nameOrCookie, value] = write;
    if (typeof nameOrCookie === 'string') {
      forwarded.cookies.set(nameOrCookie, value ?? '');
    } else {
      forwarded.cookies.set(nameOrCookie.name, nameOrCookie.value);
    }
    serializer.cookies.set(...write);
  }

  const response = NextResponse.next({ request: { headers: forwarded.headers } });
  for (const cookie of serializer.headers.getSetCookie()) {
    response.headers.append('set-cookie', cookie);
  }
  return response;
}

// ── Public API ────────────────────────────────────────────────

export interface MiddlewareSessionResult {
  session: IronSession<SessionData>;
  response: NextResponse;
}

/**
 * Read the iron-session from the request.
 * Returns both the session and a NextResponse (iron-session needs both).
 */
export async function getMiddlewareSession(request: NextRequest): Promise<MiddlewareSessionResult> {
  const response = NextResponse.next();
  const session = await getIronSession<SessionData>(request, response, sessionConfig);
  return { session, response };
}

/**
 * What {@link refreshSessionIfNeeded} did to the session:
 *   - `unchanged` — no refresh was needed, or it failed transiently; proceed on the existing cookie.
 *   - `refreshed` — `response` carries the new seal to this request and the browser.
 *   - `ended` — WorkOS has ended the session, so it can never refresh again. `response` carries
 *     the destroyed cookie to this request and the browser; the caller treats the visitor as
 *     signed out.
 */
export type SessionRefreshOutcome =
  | { readonly status: 'unchanged' }
  | { readonly status: 'refreshed'; readonly response: NextResponse }
  | { readonly status: 'ended'; readonly response: NextResponse };

const UNCHANGED: SessionRefreshOutcome = { status: 'unchanged' };

/**
 * WorkOS's answer to a refresh once the session itself is over — past its inactivity timeout or
 * maximum length, or revoked: `invalid_grant` with this description.
 *
 * ⚠ MATCHED ON THE DESCRIPTION, NOT ON `invalid_grant` ALONE. `invalid_grant` is also the generic
 * answer for an unusable refresh token, and two concurrent requests refreshing the same rotated
 * token is an ordinary race (two tabs polling, a page plus its Server Actions). Signing the user
 * out on that would be a spurious logout. If WorkOS rewords the description this stops matching
 * and the outcome falls back to `unchanged` — the cookie lingers until it expires, never a false
 * sign-out.
 *
 * Duck-typed on the two fields the SDK's `OauthException` carries, so the check does not depend
 * on the SDK's class identity.
 */
function isSessionEndedError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { error: code, errorDescription } = error as Record<string, unknown>;
  return (
    code === 'invalid_grant' &&
    typeof errorDescription === 'string' &&
    /session has already ended/i.test(errorDescription)
  );
}

/** Destroy the session cookie for this request and the browser. */
async function endedSessionOutcome(request: NextRequest): Promise<SessionRefreshOutcome> {
  const writes: CookieWrite[] = [];
  const endedSession = await getIronSession<SessionData>(
    {
      get: (name: string) => request.cookies.get(name),
      set: (...args: CookieWrite): void => {
        writes.push(args);
      },
    },
    sessionConfig
  );
  endedSession.destroy();
  return { status: 'ended', response: responseForSessionWrites(request, writes) };
}

/**
 * Attempt to refresh the session tokens if the access token is expired
 * or about to expire (within REFRESH_BUFFER_SECONDS).
 *
 * A transient refresh failure is `unchanged`: the caller proceeds normally, and token-level auth
 * is enforced by Server Actions and `apps/api` independently. A session WorkOS has ended is
 * `ended` — left in place, the long-lived cookie would keep the user looking signed in while
 * every `apps/api` call 401s.
 */
export async function refreshSessionIfNeeded(
  request: NextRequest,
  session: IronSession<SessionData>
): Promise<SessionRefreshOutcome> {
  // BAL-553 fix round 1, S3 — THIS EARLY RETURN IS LOAD-BEARING FOR THE 30-MINUTE TTL, NOT JUST
  // A TOKEN CHECK. `startImpersonationAction` deletes BOTH `accessToken`/`refreshToken` from an
  // impersonated session precisely so this function can never reach the `.save()` below for one
  // — that save re-seals with the default 90-day `sessionConfig`, which would silently promote an
  // impersonated session past its 30-minute deadline with `isImpersonating` still intact. That
  // coupling holds today, but it is undocumented and the `workos-auth` skill's own sketch
  // *carries* the tokens on an impersonated session — a future ticket following the skill would
  // silently reopen this. The `impersonatorUserId` re-arm below is the DEFENSIVE backstop, not
  // the primary guarantee: do not remove either half.
  if (!session.accessToken || !session.refreshToken) {
    return UNCHANGED;
  }

  if (!isAccessTokenExpired(session.accessToken, REFRESH_BUFFER_SECONDS)) {
    return UNCHANGED;
  }

  try {
    const result = await getWorkOS().userManagement.authenticateWithRefreshToken({
      clientId: process.env.WORKOS_CLIENT_ID!,
      refreshToken: session.refreshToken,
    });

    // iron-session's cookie-store form: `save()` hands the sealed cookie to `writes` instead of
    // writing a header, so it can be forwarded to this request as well as the browser.
    const writes: CookieWrite[] = [];
    const updatedSession = await getIronSession<SessionData>(
      {
        get: (name: string) => request.cookies.get(name),
        set: (...args: CookieWrite): void => {
          writes.push(args);
        },
      },
      sessionConfig
    );
    updatedSession.user = session.user;
    updatedSession.accessToken = result.accessToken;
    updatedSession.refreshToken = result.refreshToken;

    // BAL-553 fix round 1, S3 — defensive re-arm BEFORE save(), independent of the early return
    // above. Reads `impersonatorUserId` (never the literal `isImpersonating` — this file is
    // Edge-safe and must not import `@/lib/auth/impersonation`, which pulls in the Node-only
    // structured logger). `impersonatorUserId` is set ONLY alongside `isImpersonating` by
    // `markSessionAsImpersonated`, so it is an equally reliable signal here.
    if (updatedSession.user?.impersonatorUserId !== undefined) {
      const remaining = ((updatedSession.user.impersonationExpiresAt ?? 0) - Date.now()) / 1000;
      updatedSession.updateConfig(impersonatedSessionConfig(remaining));
    }

    await updatedSession.save();

    return { status: 'refreshed', response: responseForSessionWrites(request, writes) };
  } catch (error) {
    const ended = isSessionEndedError(error);
    console.log(
      JSON.stringify({
        level: ended ? 'info' : 'warn',
        msg: ended ? 'WorkOS session ended — signing out' : 'Token refresh failed',
        error: error instanceof Error ? error.message : 'Unknown',
        timestamp: new Date().toISOString(),
      })
    );
    return ended ? endedSessionOutcome(request) : UNCHANGED;
  }
}

/**
 * Clear the session cookie by destroying the iron-session.
 * Returns a NextResponse with the cleared cookie.
 */
export async function clearMiddlewareSession(request: NextRequest): Promise<NextResponse> {
  const response = NextResponse.next();
  const session = await getIronSession<SessionData>(request, response, sessionConfig);
  session.destroy();
  return response;
}

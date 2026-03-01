/**
 * Session helpers for Next.js middleware (Edge Runtime).
 *
 * Why a separate file from session.ts?
 *   - session.ts imports 'server-only' (fails in Edge Runtime)
 *   - session.ts uses cookies() from next/headers (unavailable in middleware)
 *   - Middleware must use request/response cookies via getIronSession(req, res, config)
 */

import { getIronSession, type IronSession } from 'iron-session';
import { WorkOS } from '@workos-inc/node';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import type { SessionData } from './session';
import { sessionConfig } from './session-config';

/** Buffer before actual JWT expiry to trigger proactive refresh (seconds) */
const REFRESH_BUFFER_SECONDS = 60;

// ── WorkOS singleton (Edge-safe, separate from config.ts) ─────

let _workos: WorkOS;
function getWorkOS(): WorkOS {
  if (!_workos) {
    _workos = new WorkOS(process.env.WORKOS_API_KEY!);
  }
  return _workos;
}

// ── Token expiry check ────────────────────────────────────────

/**
 * Decode a JWT payload WITHOUT signature verification.
 * Only used to read the `exp` claim for refresh timing.
 * Uses base64url → base64 conversion for Edge compatibility.
 */
function getTokenExpiry(token: string): number | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    // JWT uses base64url encoding; atob() expects standard base64
    const base64 = parts[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(base64)) as { exp?: number };
    return payload.exp ?? null;
  } catch {
    return null;
  }
}

function isTokenExpired(accessToken: string): boolean {
  const exp = getTokenExpiry(accessToken);
  if (exp === null) return true; // Unreadable → treat as expired
  const nowSeconds = Math.floor(Date.now() / 1000);
  return exp - nowSeconds < REFRESH_BUFFER_SECONDS;
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
 * Attempt to refresh the session tokens if the access token is expired
 * or about to expire (within REFRESH_BUFFER_SECONDS).
 *
 * Returns a NextResponse with the updated session cookie if refresh
 * was needed and succeeded.
 * Returns null if no refresh was needed or if refresh failed.
 *
 * On failure, the caller should proceed normally — token-level auth
 * is handled by Server Actions independently. Middleware is UX convenience.
 */
export async function refreshSessionIfNeeded(
  request: NextRequest,
  session: IronSession<SessionData>
): Promise<NextResponse | null> {
  if (!session.accessToken || !session.refreshToken) {
    return null;
  }

  if (!isTokenExpired(session.accessToken)) {
    return null;
  }

  try {
    const result = await getWorkOS().userManagement.authenticateWithRefreshToken({
      clientId: process.env.WORKOS_CLIENT_ID!,
      refreshToken: session.refreshToken,
    });

    // Build a new response with the updated session cookie
    const response = NextResponse.next();
    const updatedSession = await getIronSession<SessionData>(request, response, sessionConfig);
    updatedSession.user = session.user;
    updatedSession.accessToken = result.accessToken;
    updatedSession.refreshToken = result.refreshToken;
    await updatedSession.save();

    return response;
  } catch (error) {
    console.log(
      JSON.stringify({
        level: 'warn',
        msg: 'Token refresh failed',
        error: error instanceof Error ? error.message : 'Unknown',
        timestamp: new Date().toISOString(),
      })
    );
    return null;
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

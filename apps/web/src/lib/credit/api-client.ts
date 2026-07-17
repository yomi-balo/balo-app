import 'server-only';

import { loggedFetch } from '@/lib/logging/fetch-wrapper';
import { log } from '@/lib/logging';
import { getSession } from '@/lib/auth/session';

/**
 * BAL-378 (ADR-1040 Lane 2) — the internal web→api client for the credit-session
 * routes.
 *
 * Mirrors the mechanics of {@link file://../notifications/publish.ts} (the internal
 * `loggedFetch` hop with `getApiUrl()` fallback) but with TWO deliberate differences:
 *  1. The credit-session routes are WorkOS-authed (`requireAuth` → `request.userId`),
 *     NOT `x-internal-api-key`. So this client forwards the viewer's WorkOS
 *     access token as `Authorization: Bearer …`, resolved SERVER-SIDE from the
 *     iron-session — the browser never supplies it and no company / wallet id is
 *     ever trusted from the client.
 *  2. These calls need the RESPONSE (they are user-initiated mutations that toast
 *     their outcome), so they are awaited inline, not deferred to `after()`.
 */

/** The authed principal for a credit-session api call (resolved from the iron-session). */
interface SessionApiAuth {
  userId: string;
  accessToken: string;
}

/** A typed result of a credit-session api call — success carries the parsed body. */
export type ApiCallResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; code?: string; error: string };

function getApiUrl(): string {
  const url = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL;
  if (url === undefined || url.length === 0) {
    log.warn('API_URL not configured — falling back to localhost:3002');
    return 'http://localhost:3002';
  }
  return url;
}

/**
 * Resolve the viewer's authenticated principal from the iron-session. Fails closed
 * (`null`) for a missing user, a missing access token, or an un-onboarded session —
 * the api re-verifies the token, so this is a first, cheap gate.
 */
async function resolveSessionApiAuth(): Promise<SessionApiAuth | null> {
  const session = await getSession();
  const userId = session.user?.id;
  const accessToken = session.accessToken;
  if (userId === undefined || accessToken === undefined || accessToken.length === 0) {
    return null;
  }
  if (session.user?.onboardingCompleted !== true) {
    return null;
  }
  return { userId, accessToken };
}

/** Parse a response body as JSON, tolerating an empty body (→ `{}`). */
function safeParse(text: string): Record<string, unknown> {
  if (text.length === 0) {
    return {};
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function readString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Call a credit-session api route with the viewer's Bearer token. Never throws — a
 * transport error, a non-2xx, or an unauthenticated session all resolve to a typed
 * `{ ok: false }` the action layer maps to a friendly, non-leaking message.
 */
export async function callSessionApi<T>(
  path: string,
  method: 'GET' | 'POST',
  body?: unknown
): Promise<ApiCallResult<T>> {
  const auth = await resolveSessionApiAuth();
  if (auth === null) {
    return { ok: false, status: 401, error: 'Please sign in and try again.' };
  }

  try {
    const response = await loggedFetch(`${getApiUrl()}${path}`, {
      service: 'balo-api',
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${auth.accessToken}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    const parsed = safeParse(await response.text());

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        code: readString(parsed, 'code'),
        error: readString(parsed, 'error') ?? readString(parsed, 'code') ?? 'Request failed.',
      };
    }

    return { ok: true, status: response.status, data: parsed as T };
  } catch (error) {
    log.error('Credit-session api call failed', {
      path,
      method,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { ok: false, status: 0, error: 'Something went wrong. Please try again.' };
  }
}

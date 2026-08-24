import 'server-only';

import { loggedFetch } from '@/lib/logging/fetch-wrapper';
import { log } from '@/lib/logging';
import { getSession } from '@/lib/auth/session';

/**
 * Fix round 1 item 9 — THE ONE FETCH+AUTH+ERROR-MAPPING SHAPE, extracted from
 * `lib/booking/booking-api-client.ts` and `lib/meetings/reschedule-proposal-api-client.ts`,
 * which had re-declared it byte-for-byte (`getApiUrl`, `safeParse`, `readString`, `readInstant`,
 * `readRetryAfter`, and the whole `postJson`/`callBookingApi` body) — the exact SonarCloud
 * new-code duplication shape a prior docblock called "deliberate" while doing precisely what
 * CPD penalises. Every `apps/web` → `apps/api` server-only hop with a single `requireAuth`-gated
 * route and a WorkOS-Bearer-resolved-server-side auth posture goes through this module now; each
 * caller keeps only its own `parse*Response` functions and route paths.
 *
 * ⚠ NOTHING HERE THROWS. Every transport error and every non-2xx resolves to a typed failure.
 * ⚠ NOTHING HERE INTERPRETS AN ERROR BODY BEYOND ITS `error` LITERAL.
 */

/** ⚠ 3002, NOT 3001 — CLAUDE.md's port table is stale; the API dev server listens on 3002. */
export function getApiUrl(): string {
  const url = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL;
  if (url === undefined || url.length === 0) {
    log.warn('API_URL not configured — falling back to localhost:3002');
    return 'http://localhost:3002';
  }
  return url;
}

export type BaloApiResult<T> =
  | { readonly ok: true; readonly data: T }
  | {
      readonly ok: false;
      /** ⚠ `0` MEANS TRANSPORT, not "server said no". */
      readonly status: number;
      /** The api's FIXED literal, or `request_failed`. Never a message, never vendor prose. */
      readonly code: string;
      /** Seconds, from a `429`'s `Retry-After`. Absent unless the server sent a usable one. */
      readonly retryAfterSeconds?: number;
    };

/** Parse a body as JSON, tolerating an empty one. Never throws. */
export function safeParse(text: string): Record<string, unknown> {
  if (text.length === 0) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function readString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' ? value : undefined;
}

/** An ISO instant the caller can safely do date arithmetic on, or `undefined`. */
export function readInstant(body: Record<string, unknown>, key: string): string | undefined {
  const value = readString(body, key);
  if (value === undefined || !Number.isFinite(Date.parse(value))) return undefined;
  return value;
}

/** A `Retry-After` in seconds, or `undefined`. Never negative, never `NaN`, never absurd. */
export function readRetryAfter(response: Response): number | undefined {
  const raw = response.headers.get('Retry-After');
  if (raw === null) return undefined;
  const seconds = Number.parseInt(raw, 10);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return Math.min(seconds, 300);
}

/**
 * One call to a `requireAuth`-gated `apps/api` route, with the viewer's Bearer resolved
 * server-side. `parse` turns a 2xx body into the caller's typed shape, or returns `null` on a
 * malformed one (mapped to a transport failure — the api never sends a 200 the client cannot
 * read, so this is a defensive backstop). Pass the identity function (`(parsed) => parsed as T`)
 * for a caller that does its own narrowing downstream, the `postBookMeeting`/`postInviteGuests`
 * posture.
 *
 * ⚠ FAILS CLOSED on a missing user or a missing access token. The api re-verifies the token
 * regardless, so this is a first, cheap gate rather than the boundary.
 */
export async function postBaloApiJson<T>(
  path: string,
  body: unknown,
  parse: (parsed: Record<string, unknown>) => T | null,
  logLabel: string
): Promise<BaloApiResult<T>> {
  const session = await getSession();
  const accessToken = session.accessToken;
  if (session.user?.id === undefined || accessToken === undefined || accessToken.length === 0) {
    return { ok: false, status: 401, code: 'unauthenticated' };
  }

  try {
    const response = await loggedFetch(`${getApiUrl()}${path}`, {
      service: 'balo-api',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
    });

    const parsedBody = safeParse(await response.text());

    if (!response.ok) {
      // ⚠ ONLY READ ON A `429`. Any other status's `Retry-After` is not advice about OUR window.
      const retryAfterSeconds = response.status === 429 ? readRetryAfter(response) : undefined;
      return {
        ok: false,
        status: response.status,
        code: readString(parsedBody, 'error') ?? 'request_failed',
        // ⚠ THE KEY IS OMITTED, NOT SET TO `undefined` — a present-but-undefined optional
        // survives an `in` check and violates the declared type under
        // `exactOptionalPropertyTypes`.
        ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
      };
    }

    const data = parse(parsedBody);
    if (data === null) {
      log.error(`${logLabel} api returned a malformed 200 body`, { path });
      return { ok: false, status: 0, code: 'request_failed' };
    }
    return { ok: true, data };
  } catch (error) {
    // ⚠ NO TOKEN, NO EMAIL, NO DESCRIPTION HTML IN THIS LOG.
    log.error(`${logLabel} api call failed`, {
      path,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { ok: false, status: 0, code: 'request_failed' };
  }
}

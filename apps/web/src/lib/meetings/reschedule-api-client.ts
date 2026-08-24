import 'server-only';

import { loggedFetch } from '@/lib/logging/fetch-wrapper';
import { log } from '@/lib/logging';
import { getSession } from '@/lib/auth/session';

/**
 * BAL-409 — the SERVER-ONLY web→api client for `POST /meetings/:meetingId/reschedule`.
 *
 * MODELLED ON `lib/booking/booking-api-client.ts`'s `callBookingApi`, copied line for line in
 * shape rather than imported — the two hops are authenticated identically (a single
 * `requireAuth`-gated route, the viewer's WorkOS Bearer resolved server-side) but the booking
 * client's exports are booking-specific (`BookMeetingInput`, guest invites) and a generic
 * shared client would be a wider surface than this one route needs.
 *
 * ⚠ NOTHING HERE THROWS. Every transport error and every non-2xx resolves to a typed failure
 * the Server Action maps to a `RescheduleFailureCode`.
 *
 * ⚠ NOTHING HERE INTERPRETS AN ERROR BODY BEYOND ITS `error` LITERAL.
 */

/** ⚠ 3002, NOT 3001 — same stale-port note as `booking-api-client.ts`. */
function getApiUrl(): string {
  const url = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL;
  if (url === undefined || url.length === 0) {
    log.warn('API_URL not configured — falling back to localhost:3002');
    return 'http://localhost:3002';
  }
  return url;
}

export type RescheduleApiResult<T> =
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
function safeParse(text: string): Record<string, unknown> {
  if (text.length === 0) return {};
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

/** An ISO instant the caller can safely do date arithmetic on, or `undefined`. */
function readInstant(body: Record<string, unknown>, key: string): string | undefined {
  const value = readString(body, key);
  if (value === undefined || !Number.isFinite(Date.parse(value))) return undefined;
  return value;
}

/** A `Retry-After` in seconds, or `undefined`. Never negative, never `NaN`, never absurd. */
function readRetryAfter(response: Response): number | undefined {
  const raw = response.headers.get('Retry-After');
  if (raw === null) return undefined;
  const seconds = Number.parseInt(raw, 10);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return Math.min(seconds, 300);
}

export interface RescheduleMeetingResponse {
  meetingId: string;
  /** The COMMITTED window — the server's values, never the client's submitted slot. */
  scheduledStart: string;
  scheduledEnd: string;
  previousScheduledStart: string;
  previousScheduledEnd: string;
  /** `false` ⇒ the no-op guard fired (the requested window equalled the current one). */
  changed: boolean;
}

export interface RescheduleMeetingInput {
  scheduledStart: string;
  scheduledEnd: string;
}

/**
 * `POST /meetings/:meetingId/reschedule` — the viewer's Bearer resolved server-side.
 *
 * ⚠ FAILS CLOSED on a missing user or a missing access token. The api re-verifies the token
 * regardless, so this is a first, cheap gate rather than the boundary.
 */
export async function postRescheduleMeeting(
  meetingId: string,
  input: RescheduleMeetingInput
): Promise<RescheduleApiResult<RescheduleMeetingResponse>> {
  const session = await getSession();
  const accessToken = session.accessToken;
  if (session.user?.id === undefined || accessToken === undefined || accessToken.length === 0) {
    return { ok: false, status: 401, code: 'unauthenticated' };
  }

  try {
    const response = await loggedFetch(`${getApiUrl()}/meetings/${meetingId}/reschedule`, {
      service: 'balo-api',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(input),
    });

    const parsed = safeParse(await response.text());

    if (!response.ok) {
      const retryAfterSeconds = response.status === 429 ? readRetryAfter(response) : undefined;
      return {
        ok: false,
        status: response.status,
        code: readString(parsed, 'error') ?? 'request_failed',
        // ⚠ THE KEY IS OMITTED, NOT SET TO `undefined` — a present-but-undefined optional
        // survives an `in` check and violates the declared type under
        // `exactOptionalPropertyTypes`.
        ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
      };
    }

    const responseMeetingId = readString(parsed, 'meetingId');
    const scheduledStart = readInstant(parsed, 'scheduledStart');
    const scheduledEnd = readInstant(parsed, 'scheduledEnd');
    const previousScheduledStart = readInstant(parsed, 'previousScheduledStart');
    const previousScheduledEnd = readInstant(parsed, 'previousScheduledEnd');
    const changed = parsed['changed'];
    if (
      responseMeetingId === undefined ||
      scheduledStart === undefined ||
      scheduledEnd === undefined ||
      previousScheduledStart === undefined ||
      previousScheduledEnd === undefined ||
      typeof changed !== 'boolean'
    ) {
      log.error('Reschedule api returned a malformed 200 body', { meetingId });
      return { ok: false, status: 0, code: 'request_failed' };
    }

    return {
      ok: true,
      data: {
        meetingId: responseMeetingId,
        scheduledStart,
        scheduledEnd,
        previousScheduledStart,
        previousScheduledEnd,
        changed,
      },
    };
  } catch (error) {
    // ⚠ NO TOKEN, NO EMAIL, NO DESCRIPTION HTML IN THIS LOG.
    log.error('Reschedule api call failed', {
      meetingId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { ok: false, status: 0, code: 'request_failed' };
  }
}

import 'server-only';

import { loggedFetch } from '@/lib/logging/fetch-wrapper';
import { log } from '@/lib/logging';
import { getSession } from '@/lib/auth/session';

/**
 * BAL-400 — the SERVER-ONLY web→api client for the booking flow's two `apps/api` hops:
 * `POST /meetings` (book + provision) and `POST /meetings/:meetingId/guests` (invite).
 *
 * MODELLED ON `lib/meetings/join-api-client.ts`'s member hop (itself modelled on
 * `lib/credit/api-client.ts`'s `callSessionApi`) — the same WorkOS-Bearer-resolved-server-side
 * shape `lib/meetings/guests-api-client.ts` also uses for its four routes. Both this module's
 * routes are `requireAuth`-gated (never public), so there is exactly ONE auth posture here,
 * unlike `join-api-client.ts`'s two.
 *
 * ⚠ NOTHING HERE THROWS. Every transport error and every non-2xx resolves to a typed failure
 * the Server Action maps to a `BookingFailureCode`. An exception escaping a Server Action
 * becomes a Next error boundary, which is the wrong shape for "that slot just got taken".
 *
 * ⚠ AND NOTHING HERE INTERPRETS AN ERROR BODY BEYOND ITS `error` LITERAL — the api returns
 * fixed literals precisely so a caller cannot start branching on prose.
 *
 * ⚠⚠ `joinUrl` AND `dailyRoomName` ARE DELIBERATELY NOT ON `BookMeetingResponse`. The api's
 * `201` body carries both, and `joinUrl` there is the RAW DAILY URL — it must never cross to
 * the browser (BAL-421 precedent; `meetings.join_url` never crosses this boundary). Dropping
 * the fields here, at the transport layer, means nothing DOWNSTREAM of this module ever holds
 * them, rather than relying on every caller to remember not to forward them. The client-facing
 * link is always `/join/m/{meetingId}`, built by the caller from `meetingId` alone.
 *
 * ⚠⚠ AND `scheduledStart`/`scheduledEnd` ARE DELIBERATELY **KEPT** — the narrowing above is
 * about the raw Daily URL and nothing else (S2). They had been dropped too, which forced every
 * downstream consumer back onto the client's own submitted slot; on Decision 7's replay path
 * the two diverge, and the toast, Step 3 and both confirmation emails then reported a time the
 * meeting is not at. The window is the server's answer and is not sensitive. Do not "tidy" it
 * out of this interface.
 */

/**
 * ⚠ 3002, NOT 3001. CLAUDE.md's port table is stale; the API dev server listens on 3002. The
 * same helper shape as `lib/credit/api-client.ts`, `lib/meetings/join-api-client.ts` and
 * `lib/meetings/guests-api-client.ts`, so none of the four can disagree.
 */
function getApiUrl(): string {
  const url = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL;
  if (url === undefined || url.length === 0) {
    log.warn('API_URL not configured — falling back to localhost:3002');
    return 'http://localhost:3002';
  }
  return url;
}

export type BookingApiResult<T> =
  | { readonly ok: true; readonly data: T }
  | {
      readonly ok: false;
      /** ⚠ `0` MEANS **TRANSPORT**, not "server said no". See the module docblock. */
      readonly status: number;
      /** The api's FIXED literal, or `request_failed`. Never a message, never vendor prose. */
      readonly code: string;
      /** Seconds, from a `429`'s `Retry-After`. ⚠ Absent unless the server sent a usable one. */
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

/** A `Retry-After` in seconds, or `undefined`. ⚠ Never negative, never `NaN`, never absurd. */
function readRetryAfter(response: Response): number | undefined {
  const raw = response.headers.get('Retry-After');
  if (raw === null) return undefined;
  const seconds = Number.parseInt(raw, 10);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return Math.min(seconds, 300);
}

/**
 * One call to a booking route, with the viewer's Bearer resolved server-side.
 *
 * ⚠ FAILS CLOSED on a missing user or a missing access token. The api re-verifies the token
 * regardless, so this is a first, cheap gate rather than the boundary.
 */
async function callBookingApi<T>(
  path: string,
  method: 'POST',
  body: unknown
): Promise<BookingApiResult<T>> {
  const session = await getSession();
  const accessToken = session.accessToken;
  if (session.user?.id === undefined || accessToken === undefined || accessToken.length === 0) {
    return { ok: false, status: 401, code: 'unauthenticated' };
  }

  try {
    const response = await loggedFetch(`${getApiUrl()}${path}`, {
      service: 'balo-api',
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
    });

    const parsed = safeParse(await response.text());

    if (!response.ok) {
      // ⚠ ONLY READ ON A `429`. Any other status's `Retry-After` is not advice about OUR
      // window.
      const retryAfterSeconds = response.status === 429 ? readRetryAfter(response) : undefined;
      return {
        ok: false,
        status: response.status,
        code: readString(parsed, 'error') ?? 'request_failed',
        // ⚠ THE KEY IS **OMITTED**, NOT SET TO `undefined` — a present-but-undefined optional
        // survives an `in` check and violates the declared type under
        // `exactOptionalPropertyTypes`.
        ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
      };
    }
    return { ok: true, data: parsed as T };
  } catch (error) {
    // ⚠ NO TOKEN, NO GUEST EMAIL, NO DESCRIPTION HTML IN THIS LOG — the path already
    // identifies the operation.
    log.error('Booking api call failed', {
      path,
      method,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { ok: false, status: 0, code: 'request_failed' };
  }
}

/** `POST /meetings`'s `201` body, NARROWED — see the module docblock for what is dropped. */
export interface BookMeetingResponse {
  meetingId: string;
  /**
   * ⚠⚠ THE AUTHORITATIVE WINDOW, AND THE ONLY ONE ANY CALLER MAY RENDER OR NOTIFY ON (S2).
   * `meetings.scheduled_start`/`_end`, ISO-8601. It is NOT always the window that was
   * submitted: on Decision 7's idempotent replay the server returns the meeting that already
   * exists. Echoing the request's own slot back — which is what the caller did before — makes
   * the toast, Step 3 and BOTH confirmation emails report a time the meeting is not at.
   */
  scheduledStart: string;
  scheduledEnd: string;
  /** `false` ⇒ the Daily room did not come up; the booked state must not show a live join link. */
  provisioned: boolean;
}

export interface BookMeetingInput {
  contextType: 'case';
  contextId: string;
  scheduledStart: string;
  scheduledEnd: string;
  /** 64-lowercase-hex — Decision 1/7. */
  bookingIdempotencyKey: string;
}

/**
 * `POST /meetings` — book + provision the consultation. Idempotent on `bookingIdempotencyKey`
 * (Decision 7): a retry with the same key against the SAME `contextId` replays the existing
 * meeting rather than creating a second Daily room; against a DIFFERENT `contextId` it 409s
 * `idempotency_key_conflict`.
 */
export async function postBookMeeting(
  input: BookMeetingInput
): Promise<BookingApiResult<BookMeetingResponse>> {
  const result = await callBookingApi<Record<string, unknown>>('/meetings', 'POST', input);
  if (!result.ok) {
    return result;
  }
  const meetingId = readString(result.data, 'meetingId');
  const scheduledStart = readInstant(result.data, 'scheduledStart');
  const scheduledEnd = readInstant(result.data, 'scheduledEnd');
  const provisioned = result.data['provisioned'];
  if (
    meetingId === undefined ||
    scheduledStart === undefined ||
    scheduledEnd === undefined ||
    typeof provisioned !== 'boolean'
  ) {
    // A malformed 2xx body — treat as a transport-shaped failure rather than crash the action.
    // ⚠ THE WINDOW IS REQUIRED, not optional-with-a-fallback: falling back to the submitted
    // slot would silently reinstate S2 (client input re-presented as a server fact).
    log.error('Booking api returned a malformed 201 body', {
      hasMeetingId: meetingId !== undefined,
      hasWindow: scheduledStart !== undefined && scheduledEnd !== undefined,
    });
    return { ok: false, status: 0, code: 'request_failed' };
  }
  return { ok: true, data: { meetingId, scheduledStart, scheduledEnd, provisioned } };
}

export interface InviteGuestInput {
  email: string;
  name?: string;
}

export interface InviteGuestsResponse {
  invitedCount: number;
}

/**
 * `POST /meetings/:meetingId/guests` — invite guests at booking confirm. ⚠ Max 8 per call
 * (`guests.schema.ts`); the caller is responsible for staying under that.
 *
 * ⚠ NO TOKEN AND NO JOIN LINK EVER COMES BACK — the notification engine emails it
 * (`guests.ts`). The booked state must not attempt to render a guest link.
 *
 * A `409 guest_already_invited` is treated as SUCCESS by the caller (the booking Server
 * Action), not here — this function reports the raw transport/HTTP outcome only, and doesn't
 * know that a retry-safe reading applies. See `book-consultation.ts`.
 */
export async function postInviteGuests(
  meetingId: string,
  guests: readonly InviteGuestInput[]
): Promise<BookingApiResult<InviteGuestsResponse>> {
  const result = await callBookingApi<Record<string, unknown>>(
    `/meetings/${meetingId}/guests`,
    'POST',
    { entryPoint: 'booking_confirm', guests }
  );
  if (!result.ok) {
    return result;
  }
  const invitedGuests = result.data['guests'];
  const invitedCount = Array.isArray(invitedGuests) ? invitedGuests.length : 0;
  return { ok: true, data: { invitedCount } };
}

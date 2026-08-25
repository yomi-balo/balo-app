import 'server-only';

import { log } from '@/lib/logging';
import {
  postBaloApiJson,
  readInstant,
  readString,
  type BaloApiResult,
} from '@/lib/api/balo-api-client';
// BAL-283 — PURE, no `@balo/db` (the client-bundle footgun this module's own docblock warns
// about elsewhere). `MeetingBookingContextType` is the single definition `apps/api`'s Zod
// boundary and tenancy gate also read.
import type { MeetingBookingContextType } from '@balo/shared/meetings';

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

/** Re-exported under this module's own name — see `lib/api/balo-api-client.ts` (fix round 1
 *  item 9) for the shared shape. Nothing here narrows it further. */
export type BookingApiResult<T> = BaloApiResult<T>;

/**
 * One call to a booking route, with the viewer's Bearer resolved server-side. Thin wrapper over
 * the shared `postBaloApiJson` — this module keeps only its own response shapes and route
 * paths; the identity `parse` matches this file's own posture of narrowing AFTER the call
 * (`postBookMeeting`/`postInviteGuests` do their own field-by-field validation below), not
 * inside a `parse` callback the way `reschedule-proposal-api-client.ts` does.
 */
async function callBookingApi<T>(path: string, body: unknown): Promise<BookingApiResult<T>> {
  return postBaloApiJson<T>(path, body, (parsed) => parsed as T, 'Booking');
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
  // BAL-283 widened this from the literal `'case'` — `book-consultation.ts` (BAL-400) still
  // only ever passes `'case'`; `book-intro-call.ts` (BAL-283) passes `'request_interaction'`.
  contextType: MeetingBookingContextType;
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
  const result = await callBookingApi<Record<string, unknown>>('/meetings', input);
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
  const result = await callBookingApi<Record<string, unknown>>(`/meetings/${meetingId}/guests`, {
    entryPoint: 'booking_confirm',
    guests,
  });
  if (!result.ok) {
    return result;
  }
  const invitedGuests = result.data['guests'];
  const invitedCount = Array.isArray(invitedGuests) ? invitedGuests.length : 0;
  return { ok: true, data: { invitedCount } };
}

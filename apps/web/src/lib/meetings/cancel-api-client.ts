import 'server-only';

import {
  postBaloApiJson,
  readInstant,
  readString,
  type BaloApiResult,
} from '@/lib/api/balo-api-client';

/**
 * BAL-410 — the SERVER-ONLY web→api client for `POST /meetings/:meetingId/cancel`.
 *
 * The fetch/auth/error-mapping shape is `postBaloApiJson` in `lib/api/balo-api-client.ts`,
 * shared with `lib/meetings/reschedule-api-client.ts` and `lib/booking/booking-api-client.ts` —
 * it already handles the base URL, the iron-session Bearer forwarding with a fail-closed 401,
 * `loggedFetch` with `service: 'balo-api'`, and the `{ ok, status, code }` error shape including
 * `Retry-After` on 429. This module keeps only its own response parser and route path.
 *
 * ⚠ NOTHING HERE THROWS. Every transport error and every non-2xx resolves to a typed failure the
 * Server Action maps to a `CancelFailureCode`.
 *
 * ⚠ NOTHING HERE INTERPRETS AN ERROR BODY BEYOND ITS `error` LITERAL.
 *
 * ⚠ THE REQUEST BODY IS `{}` AND MUST STAY `{}`. The api's schema is `z.object({}).strict()`, so
 * a "helpful" extra field is a 400, not a silently-stripped no-op. `reason` and `initiatedBy` are
 * SERVER decisions — see `apps/api/src/routes/meetings/cancel.schema.ts`.
 */

export type CancelApiResult<T> = BaloApiResult<T>;

export interface CancelMeetingResponse {
  meetingId: string;
  status: 'cancelled';
  /** ISO — the window that was RELEASED. The dialog quotes it; it is never the client's input. */
  scheduledStart: string;
  /**
   * The `meeting.cancelled` audit row id — unique per WRITE. The web action does not publish
   * today (the api does), but it is BAL-476's correlation handle and belongs on the wire.
   */
  cancelAuditId: string;
  /**
   * WHICH AXIS authorized the cancel. ⚠ AUTHORITATIVE FOR ANALYTICS — the client must NOT
   * re-derive it from the lens, or the funnel and the audit row can disagree.
   */
  initiatedBy: 'client' | 'expert' | 'admin';
  /**
   * Whether a credit hold was released for this session. `false` is the overwhelmingly common
   * case (nobody joined early).
   *
   * ⚠⚠ `null` MEANS "NOT DISCLOSED ON THIS ARM", NEVER "no hold was released" (security LOW-1).
   * The hold is the CLIENT's money, so the api returns the flag on the CLIENT arm only — the
   * same rule the in-app expert template already applies ("the expert has no business being told
   * about its state"). Anything the wire sends on the expert or admin arm is DISCARDED here
   * rather than trusted, so the concealment holds on this side too.
   */
  holdReleased: boolean | null;
}

/** Narrow the wire's `initiatedBy` without trusting it blindly. `null` ⇒ malformed body. */
function readInitiatedBy(value: unknown): CancelMeetingResponse['initiatedBy'] | null {
  return value === 'client' || value === 'expert' || value === 'admin' ? value : null;
}

function parseCancelResponse(parsed: Record<string, unknown>): CancelMeetingResponse | null {
  const responseMeetingId = readString(parsed, 'meetingId');
  const scheduledStart = readInstant(parsed, 'scheduledStart');
  const cancelAuditId = readString(parsed, 'cancelAuditId');
  const initiatedBy = readInitiatedBy(parsed['initiatedBy']);
  // ⚠ ARM-AWARE, AND THE DISCARD IS THE POINT. On the CLIENT arm the flag is required and must
  // be a boolean; on the expert and admin arms it is `null` UNCONDITIONALLY — a value arriving
  // there is dropped rather than surfaced, so the concealment cannot be undone by the wire.
  const rawHoldReleased = parsed['holdReleased'];
  const holdReleased =
    initiatedBy === 'client' && typeof rawHoldReleased === 'boolean' ? rawHoldReleased : null;

  if (
    responseMeetingId === undefined ||
    scheduledStart === undefined ||
    cancelAuditId === undefined ||
    initiatedBy === null ||
    (initiatedBy === 'client' && holdReleased === null)
  ) {
    return null;
  }

  return {
    meetingId: responseMeetingId,
    // The route answers a fixed literal; restating it keeps the type honest without trusting
    // an arbitrary string from the wire.
    status: 'cancelled',
    scheduledStart,
    cancelAuditId,
    initiatedBy,
    holdReleased,
  };
}

/**
 * `POST /meetings/:meetingId/cancel` — the viewer's Bearer resolved server-side.
 *
 * ⚠ FAILS CLOSED on a missing user or a missing access token. The api re-verifies the token and
 * re-derives every authorization axis regardless, so this is a first, cheap gate rather than the
 * boundary.
 */
export async function postCancelMeeting(
  meetingId: string
): Promise<CancelApiResult<CancelMeetingResponse>> {
  return postBaloApiJson(`/meetings/${meetingId}/cancel`, {}, parseCancelResponse, 'Cancel');
}

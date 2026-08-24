import 'server-only';

import {
  postBaloApiJson,
  readInstant,
  readString,
  type BaloApiResult,
} from '@/lib/api/balo-api-client';

/**
 * BAL-409 — the SERVER-ONLY web→api client for `POST /meetings/:meetingId/reschedule`.
 *
 * Fix round 2 item 1 — the fetch/auth/error-mapping shape itself is no longer copied here; it is
 * `postBaloApiJson` in `lib/api/balo-api-client.ts`, shared with `lib/booking/booking-api-client.ts`
 * and `lib/meetings/reschedule-proposal-api-client.ts`. This module keeps only its own
 * `parseRescheduleResponse` and route path.
 *
 * ⚠ NOTHING HERE THROWS. Every transport error and every non-2xx resolves to a typed failure
 * the Server Action maps to a `RescheduleFailureCode`.
 *
 * ⚠ NOTHING HERE INTERPRETS AN ERROR BODY BEYOND ITS `error` LITERAL.
 */

export type RescheduleApiResult<T> = BaloApiResult<T>;

export interface RescheduleMeetingResponse {
  meetingId: string;
  /** The COMMITTED window — the server's values, never the client's submitted slot. */
  scheduledStart: string;
  scheduledEnd: string;
  previousScheduledStart: string;
  previousScheduledEnd: string;
  /** `false` ⇒ the no-op guard fired (the requested window equalled the current one). */
  changed: boolean;
  /**
   * The `meeting.rescheduled` audit row id — the caller's `booking.rescheduled` dedup key.
   * Unique per MOVE; a window-derived key is unique only per DESTINATION and so collides on a
   * move BACK to a previously-used window, silently dropping the notification.
   * Absent on a `changed: false` no-op, which writes no audit row and publishes nothing.
   */
  rescheduleAuditId?: string;
}

export interface RescheduleMeetingInput {
  scheduledStart: string;
  scheduledEnd: string;
}

function parseRescheduleResponse(
  parsed: Record<string, unknown>
): RescheduleMeetingResponse | null {
  const responseMeetingId = readString(parsed, 'meetingId');
  const scheduledStart = readInstant(parsed, 'scheduledStart');
  const scheduledEnd = readInstant(parsed, 'scheduledEnd');
  const previousScheduledStart = readInstant(parsed, 'previousScheduledStart');
  const previousScheduledEnd = readInstant(parsed, 'previousScheduledEnd');
  const changed = parsed['changed'];
  // Optional by contract: present on a real move, absent on a `changed: false` no-op. Not
  // part of the malformed-body check — a missing id on a no-op is correct, not a fault.
  const rescheduleAuditId = readString(parsed, 'rescheduleAuditId');
  if (
    responseMeetingId === undefined ||
    scheduledStart === undefined ||
    scheduledEnd === undefined ||
    previousScheduledStart === undefined ||
    previousScheduledEnd === undefined ||
    typeof changed !== 'boolean'
  ) {
    return null;
  }

  return {
    meetingId: responseMeetingId,
    scheduledStart,
    scheduledEnd,
    previousScheduledStart,
    previousScheduledEnd,
    changed,
    ...(rescheduleAuditId === undefined ? {} : { rescheduleAuditId }),
  };
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
  return postBaloApiJson(
    `/meetings/${meetingId}/reschedule`,
    input,
    parseRescheduleResponse,
    'Reschedule'
  );
}

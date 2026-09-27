/**
 * The ONE definition of "which connection receives bookings" (BAL-576). Shared by the
 * consultation-event projection and GET `/api/calendar/connection`, so both apply one rule.
 *
 * ⚠ THE INPUT ORDER IS THE RULE. Callers must pass the array exactly as
 * `calendarRepository.listConnectionsByExpertProfileId` returns it (`OLDEST_LIVE_FIRST`), never
 * re-sorted or filtered — `pickBookingWriteTarget` picks the FIRST writable row, not the "best"
 * one. Known callers: `projectBookingToExpertCalendar` (the projection) and the GET
 * `/api/calendar/connection` route handler.
 */
import type { CalendarConnection, CalendarCredentialStatus } from '@balo/db';

const READABLE_STATUS: CalendarCredentialStatus = 'ACTIVE';

/** A connection that is `ACTIVE` and has a chosen target calendar. */
export type WritableCalendarConnection = CalendarConnection & { targetCalendarId: string };

/**
 * A connection bookings may be written to: `ACTIVE` and it has a chosen target calendar.
 * The repository deliberately does not filter status (mirrors `vendor-busy.ts`'s
 * `isUnreadable` guard) — this is the caller's obligation.
 *
 * ⚠ THERE IS NO PROVIDER CHECK AT THIS WRITE PATH AND THERE NEVER WAS. Do not add one, and do
 * not "restore" one: this is exactly two conditions.
 */
export function isWritableConnection(
  connection: CalendarConnection
): connection is WritableCalendarConnection {
  return connection.credentialStatus === READABLE_STATUS && connection.targetCalendarId !== null;
}

/**
 * Pick the connection to write the consultation event to, when the expert has more than one
 * live provider connected. `calendarRepository.listConnectionsByExpertProfileId` already
 * orders `OLDEST_LIVE_FIRST` (`createdAt` then `id`), so the first writable row IS the
 * oldest-live-first pick — deterministic, though which calendar "should" win when an expert
 * has both a Google and a Microsoft connection is settled nowhere in the repo or the ADRs
 * (BAL-578 owns that product call). The partial unique on `(meeting_id, party)`
 * structurally guarantees exactly one live entry per party regardless of which connection is
 * chosen.
 */
export function pickBookingWriteTarget(
  connections: readonly CalendarConnection[]
): WritableCalendarConnection | undefined {
  return connections.find(isWritableConnection);
}

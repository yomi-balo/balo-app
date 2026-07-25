/**
 * Wire-contract types for the weekly schedule editor (BAL-234).
 *
 * These MUST match the Fastify `/api/experts/:expertProfileId/schedule` contract
 * byte-for-byte — the API implements the same shapes. Server actions and the editor
 * both speak this contract.
 */

/** Booking rules that feed Balo's availability resolver. */
export interface BookingSettings {
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  minimumNoticeMinutes: number;
  windowDays: number;
}

/** A single recurring wall-clock range on one weekday. */
export interface ScheduleRule {
  /** JS day-of-week: 0=Sun … 6=Sat. */
  dayOfWeek: number;
  /** Wall-clock start, 'HH:mm' on a 15-minute boundary. */
  startTime: string;
  /** Wall-clock end, 'HH:mm' on a 15-minute boundary, strictly after startTime. */
  endTime: string;
}

/** Full schedule payload returned by GET and echoed by POST. */
export interface ScheduleData {
  /** IANA timezone the rules are authored in. */
  timezone: string;
  bookingSettings: BookingSettings;
  rules: ScheduleRule[];
}

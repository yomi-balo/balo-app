/**
 * A single time-off block (holiday / leave) as surfaced to the Schedule tab.
 * Dates are plain `'YYYY-MM-DD'` strings in the expert's own timezone —
 * all timezone expansion happens server-side in the availability resolver.
 * Structurally identical to the Fastify route's `OverrideDto` (allow-listed —
 * never carries created/updated/deletedAt).
 */
export interface AvailabilityOverrideDto {
  id: string;
  startDate: string;
  endDate: string;
  label: string | null;
}

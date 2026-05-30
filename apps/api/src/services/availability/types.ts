/**
 * Type definitions for the BAL-243 availability resolver.
 *
 * The resolver is pure and provider-agnostic — these interfaces are the only
 * contract between it and the rest of the system. `time` columns from Drizzle
 * are strings (Postgres `time` → JS string like `'09:00:00'`); the resolver
 * concatenates them with a per-date string and feeds the result to
 * `fromZonedTime` for DST-correct UTC conversion.
 */

export interface ResolverRule {
  /** 0 = Sunday, 6 = Saturday — matches JS `Date#getDay`. */
  dayOfWeek: number;
  /** Local wall-clock time in the expert's timezone (`'HH:mm'` or `'HH:mm:ss'`). */
  startTime: string;
  /** Local wall-clock time in the expert's timezone (`'HH:mm'` or `'HH:mm:ss'`). */
  endTime: string;
}

export interface ResolverConsultation {
  /** UTC instant. Caller filters to `status = 'confirmed'`. */
  startAt: Date;
  /** UTC instant. */
  endAt: Date;
}

export interface BusyBlock {
  /** UTC instant. Vendor source intentionally not modelled. */
  startAt: Date;
  /** UTC instant. */
  endAt: Date;
}

export interface ResolverInput {
  rules: ResolverRule[];
  /** Only `confirmed` consultations — the repository filter is the boundary. */
  baloConsultations: ResolverConsultation[];
  /** Vendor free/busy windows; `[]` is valid until BAL-194/195 wires Cronofy. */
  busyBlocks: BusyBlock[];
  /** IANA timezone name from `expert_profiles.timezone`. */
  timezone: string;
  /** UTC instant; injected for testability. */
  now: Date;
  /** Number of days to look ahead from `now`. */
  horizonDays: number;
  /** Discard sub-windows shorter than this many minutes. */
  minMinutes: number;
}

export interface ResolverResult {
  earliestAvailableAt: Date | null;
}

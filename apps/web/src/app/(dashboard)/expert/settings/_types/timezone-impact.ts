/**
 * Wire contract for `GET /api/experts/timezone-impact`. MUST match the Fastify route's 200
 * body byte-for-byte — the same discipline `_types/availability-conflict.ts` states for its
 * own contract.
 *
 * ⚠ CARRIES NO MONEY AND NO IDS BEYOND THE EXPERT'S OWN CONSULTATION ROW. No rate, no margin,
 * no Balo fee, no meetingId. The route asserts the caller's session owns the expert profile
 * before it returns `clientCompanyName`.
 */
export interface TimezoneImpactDetailDto {
  consultationId: string;
  /** ISO-8601 UTC instant. */
  startAt: string;
  /** ISO-8601 UTC instant. */
  endAt: string;
  /** `null` when the session's contexts name no resolvable company. */
  clientCompanyName: string | null;
}

export interface TimezoneImpactReportDto {
  /** The proposed zone the saved weekly hours were re-read in. */
  timezone: string;
  /** Exact — never approximated by the `affected` list length. */
  affectedCount: number;
  /** `true` when `affectedCount` exceeds the rows in `affected`. */
  truncated: boolean;
  affected: TimezoneImpactDetailDto[];
  /** The next upcoming time-off block, as `YYYY-MM-DD` dates; `null` when none is booked. */
  nextTimeOff: { startDate: string; endDate: string } | null;
}

export interface TimezoneImpactCheckInput {
  /** The IANA zone the saved hours would be re-read in. */
  timezone: string;
}

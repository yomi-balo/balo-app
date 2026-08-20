/**
 * Wire contract for `GET /api/experts/availability-overrides/conflicts` (BAL-416). MUST
 * match the Fastify route's response byte-for-byte — the same discipline `_types/schedule.ts`
 * states for its own contract.
 *
 * ⚠ CARRIES NO MONEY AND NO IDS BEYOND THE EXPERT'S OWN CONSULTATION ROW. No rate, no
 * margin, no Balo fee, no companyId, no engagementId, no meetingId (plan D6 — the payload is
 * minimised regardless; the internal route ALSO asserts the caller's session owns this
 * expert profile before returning `clientCompanyName` — BAL-416 fix round 1, S1).
 */
export interface AvailabilityConflictDto {
  consultationId: string;
  /** ISO-8601 UTC instant. */
  startAt: string;
  /** ISO-8601 UTC instant. */
  endAt: string;
  /** `null` when the session's contexts name no resolvable company. */
  clientCompanyName: string | null;
}

export interface AvailabilityConflictReportDto {
  /** Exact — never approximated by the `conflicts` list length. */
  conflictCount: number;
  /** Inclusive day count of the proposed block (single day = 1). */
  durationDays: number;
  /** The EXPERT'S schedule timezone — the zone the block is expanded in. */
  timezone: string;
  /** `true` when `conflictCount` exceeds the rows in `conflicts`. */
  truncated: boolean;
  conflicts: AvailabilityConflictDto[];
}

/**
 * The request shape for a conflict check — the SINGLE definition, consumed directly by both
 * the popover's `onCheckConflicts` prop and the Server Action's own input. These began as two
 * structurally-identical `{ startDate: string; endDate: string }` interfaces in two files;
 * they were collapsed here rather than aliased, so there is exactly one name to import.
 * Type-only, so importing it into the `'use client'` popover and the `'use server'` action is
 * erased at compile time — no runtime client/server boundary is crossed.
 */
export interface AvailabilityConflictCheckInput {
  /** `YYYY-MM-DD`. */
  startDate: string;
  /** `YYYY-MM-DD`, inclusive. */
  endDate: string;
}

import { and, eq, gt, isNull, lt } from 'drizzle-orm';
import { db } from '../client';
import { consultations, type Consultation } from '../schema';

/**
 * `consultationsRepository` — READ-ONLY (BAL-428).
 *
 * ⚠ BAL-498 amendment: this repository still exposes only the one method the BAL-243
 * availability resolver needs — that sentence is now scoped to THIS repository, not to the
 * table. The BAL-498 expert calendar reads the SAME `consultations` table, but through
 * `meetingsRepository.listCalendarForExpert` (`repositories/meetings.ts`), not through a
 * method added here. This repository stays read-only and un-widened; the calendar read
 * lives in `meetingsRepository` because its result rows are meetings, not consultations —
 * see that method's own docblock for the full placement argument.
 *
 * ⚠ `create()` WAS DELETED HERE, DELIBERATELY. `consultations` is now a READ MODEL of the
 * meeting lifecycle with a NOT NULL `meeting_id`, and it has exactly ONE writer:
 * `_shared/consultation-projection.ts`, driven from `meetingsRepository` and
 * `meetingContextsRepository` inside their transactions. A second write path is exactly how
 * the two tables drifted apart in the first place — a consultation with no meeting, or a
 * meeting blocking nobody's calendar. Bookings go through `meetingsRepository.create`;
 * cancellations through `meetingsRepository.cancel`. Do not re-add a writer here.
 */
export const consultationsRepository = {
  /**
   * Confirmed (non-cancelled, non-soft-deleted) consultations that overlap
   * the half-open range `[rangeStart, rangeEnd)`. The resolver subtracts
   * these from open windows to compute earliest availability.
   *
   * Overlap definition: `startAt < rangeEnd AND endAt > rangeStart`. Strict
   * inequalities — a consultation that ends exactly at `rangeStart` does NOT
   * overlap (the slot is free at that instant).
   *
   * Served by the `consultations_expert_status_range_idx` composite index.
   */
  async listConfirmedInRange(
    expertProfileId: string,
    rangeStart: Date,
    rangeEnd: Date
  ): Promise<Consultation[]> {
    return db.query.consultations.findMany({
      where: and(
        eq(consultations.expertProfileId, expertProfileId),
        eq(consultations.status, 'confirmed'),
        isNull(consultations.deletedAt),
        lt(consultations.startAt, rangeEnd),
        gt(consultations.endAt, rangeStart)
      ),
    });
  },
};

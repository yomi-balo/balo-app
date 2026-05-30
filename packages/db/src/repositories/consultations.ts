import { and, eq, gt, isNull, lt } from 'drizzle-orm';
import { db } from '../client';
import { consultations, type Consultation, type NewConsultation } from '../schema';

/**
 * Consultation stub repository — minimum surface needed by the BAL-243
 * availability resolver and the BAL-239 dev seeder.
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

  /** Test + dev-seed helper (BAL-239). Not exposed to the consultations feature surface. */
  async create(data: NewConsultation): Promise<Consultation> {
    const [row] = await db.insert(consultations).values(data).returning();
    return row!;
  },
};

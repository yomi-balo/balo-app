import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../client';
import { availabilityOverrides, type AvailabilityOverride } from '../schema';

export interface CreateAvailabilityOverrideInput {
  expertProfileId: string;
  startDate: string; // 'YYYY-MM-DD'
  endDate: string; // 'YYYY-MM-DD'  (>= startDate; enforced at route + DB CHECK)
  label?: string | null;
}

/**
 * Data access for `availability_overrides` (full-day time-off blocks) — BAL-235.
 *
 * The whole availability domain is admin-client-only behind WorkOS /
 * `requireInternalAuth`; there is no RLS on this table (mirrors the sibling
 * `availability_rules`). Ownership scoping is enforced in `softDelete` (repo
 * layer) and again at the route (`expertProfileId` derives from the trusted
 * server-action session, never a client-supplied id).
 */
export const availabilityOverridesRepository = {
  /**
   * Non-deleted blocks whose range has not fully elapsed (endDate >= today, UTC
   * CURRENT_DATE), ordered by startDate asc. Serves BOTH the settings "Time off"
   * list AND the resolver load — far-future rows are harmless to the resolver
   * (they get clipped out of the horizon window during interval subtraction).
   */
  async listUpcoming(expertProfileId: string): Promise<AvailabilityOverride[]> {
    return db.query.availabilityOverrides.findMany({
      where: and(
        eq(availabilityOverrides.expertProfileId, expertProfileId),
        isNull(availabilityOverrides.deletedAt),
        sql`${availabilityOverrides.endDate} >= CURRENT_DATE`
      ),
      orderBy: [asc(availabilityOverrides.startDate)],
    });
  },

  async create(input: CreateAvailabilityOverrideInput): Promise<AvailabilityOverride> {
    const [row] = await db
      .insert(availabilityOverrides)
      .values({
        expertProfileId: input.expertProfileId,
        startDate: input.startDate,
        endDate: input.endDate,
        label: input.label ?? null,
      })
      .returning();
    if (!row) throw new Error('Failed to create availability override');
    return row;
  },

  /**
   * Ownership-scoped soft delete (IDOR-safe at the repo layer): only deletes
   * when both id AND expertProfileId match and the row is not already deleted.
   * Returns false when nothing matched (wrong owner / not found / already gone).
   */
  async softDelete(id: string, expertProfileId: string): Promise<boolean> {
    const rows = await db
      .update(availabilityOverrides)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(availabilityOverrides.id, id),
          eq(availabilityOverrides.expertProfileId, expertProfileId),
          isNull(availabilityOverrides.deletedAt)
        )
      )
      .returning({ id: availabilityOverrides.id });
    return rows.length > 0;
  },
};

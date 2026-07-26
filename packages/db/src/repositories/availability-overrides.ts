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
   * Non-deleted blocks whose range has not fully elapsed, ordered by startDate
   * asc. Serves BOTH the settings "Time off" list AND the resolver load —
   * far-future rows are harmless to the resolver (they get clipped out of the
   * horizon window during interval subtraction).
   *
   * The filter is `endDate >= CURRENT_DATE - INTERVAL '1 day'`, deliberately one
   * day WIDER than the naive `endDate >= CURRENT_DATE`. `CURRENT_DATE` resolves
   * in the DB session timezone (UTC), but a block's real active interval is
   * `[startDate 00:00, endDate+1 00:00)` in the EXPERT's OWN timezone. For an
   * expert west of UTC (negative offset, e.g. Honolulu UTC-10), a block whose
   * `endDate` is "today in their tz" can already read as yesterday to UTC
   * `CURRENT_DATE` while still being active for hours — the naive predicate
   * would silently drop it from BOTH this settings list AND the resolver load,
   * un-blocking the expert's own leave and leaving them bookable during it. The
   * one-day fudge absorbs that ±1 tz skew. Over-inclusion is free: a
   * fully-elapsed interval subtracts to nothing in the resolver, and at worst one
   * just-elapsed row lingers briefly on the card — far better than un-blocking
   * leave. The literal `INTERVAL '1 day'` interpolates no user input.
   */
  async listUpcoming(expertProfileId: string): Promise<AvailabilityOverride[]> {
    return db.query.availabilityOverrides.findMany({
      where: and(
        eq(availabilityOverrides.expertProfileId, expertProfileId),
        isNull(availabilityOverrides.deletedAt),
        sql`${availabilityOverrides.endDate} >= CURRENT_DATE - INTERVAL '1 day'`
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

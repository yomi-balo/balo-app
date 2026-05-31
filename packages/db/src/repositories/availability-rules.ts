import { and, asc, eq, isNull } from 'drizzle-orm';
import { db } from '../client';
import { availabilityRules, type AvailabilityRule } from '../schema';

/**
 * Read-only repository for `availability_rules` in BAL-243.
 * Mutations (create/update/delete from the schedule editor) land with BAL-195.
 */
export const availabilityRulesRepository = {
  /**
   * All non-deleted weekly recurring rules for an expert, ordered by dayOfWeek
   * then startTime so the resolver can expand them deterministically.
   */
  async listByExpertProfileId(expertProfileId: string): Promise<AvailabilityRule[]> {
    return db.query.availabilityRules.findMany({
      where: and(
        eq(availabilityRules.expertProfileId, expertProfileId),
        isNull(availabilityRules.deletedAt)
      ),
      orderBy: [asc(availabilityRules.dayOfWeek), asc(availabilityRules.startTime)],
    });
  },
};

import { sql, type SQL } from 'drizzle-orm';
import { expertProfiles } from '../../schema';

/**
 * Confirmed, non-soft-deleted consultation count for an expert profile, as a
 * correlated scalar subquery. Index-backed by `consultations_expert_status_range_idx`.
 *
 * Shared by the search list (tiebreaker) and the public profile read (hero stat)
 * so the two surfaces can never diverge on what "consultation count" means.
 * `${expertProfiles.id}` correlates to the outer `expert_profiles` row in BOTH
 * `select().from(expertProfiles)` (search) and a relational `findFirst` on
 * `expertProfiles` (public read). Cancelled and soft-deleted rows are excluded.
 */
export const consultationCountExpression: SQL = sql`COALESCE((
  SELECT count(*) FROM consultations c
  WHERE c.expert_profile_id = ${expertProfiles.id}
    AND c.status = 'confirmed' AND c.deleted_at IS NULL
), 0)`;

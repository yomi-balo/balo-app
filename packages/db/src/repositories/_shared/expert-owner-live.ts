import { sql, type SQL } from 'drizzle-orm';
import { expertProfiles } from '../../schema';

/**
 * "The user who owns this expert profile is live", as a correlated `EXISTS` over `users`.
 *
 * ⚠ THE CANONICAL DEFINITION OF "LIVE" IS `userRowIsLive` in `@balo/shared/authz`
 * (`deleted_at IS NULL AND status = 'active'`). This is its SQL twin, for the reads that must
 * filter in the query rather than test a fetched row. `expert-owner-live.integration.test.ts`
 * pins the two together over every `users.status` × `deleted_at` combination, so a change to
 * either side fails there. The `'active'` literal is inlined because an enum literal at query
 * time is always safe and a bound parameter would only obscure the twin.
 *
 * `expert_profiles` has no `deleted_at`, so an expert's soft delete and suspension both live on
 * the owning `users` row, and every public expert read and every expert-targeting filter uses
 * this one fragment: the public profile, the public slot route's visibility read, and search
 * (results, the zero-results recount and facet totals).
 *
 * ⚠ IT IS A RAW `sql` EXISTS, NOT `exists(db.select()…)`. The relational query builder
 * aliases the top-level table as `"expertProfiles"`; a Column embedded in a raw `sql` template
 * renders WITH whatever alias is in scope, whereas a nested `db.select()` compiles as an
 * independent query and emits the bare `"expert_profiles"`, which is not in the relational
 * query's FROM (Postgres 42P01). `consultationCountExpression` correlates the same way. The
 * inner alias `live_owner` is distinct from the `users u` join the search query carries.
 */
export const expertOwnerIsLive: SQL = sql`EXISTS (
  SELECT 1 FROM users live_owner
  WHERE live_owner.id = ${expertProfiles.userId}
    AND live_owner.deleted_at IS NULL
    AND live_owner.status = 'active'
)`;

import { eq, isNotNull, sql, type SQL } from 'drizzle-orm';
import { expertProfiles } from '../../schema';
import { expertOwnerIsLive } from './expert-owner-live';

/**
 * "This expert profile has a public page": searchable AND approved AND a live owner
 * (`expertOwnerIsLive`). It is the one definition of the visibility rule behind
 * `/experts/[username]` and the public slot route, so a link to a profile and the page it
 * opens cannot disagree.
 *
 * Read by `findPublicProfileByUsername` and `findPublicVisibility` as a WHERE term, and by
 * `findDisplayProfileById`, `findPublicUsernamesByProfileIds`, the cases index and the admin
 * lookup's expert arm (`platform-lookup.ts`, its Open link) as the gate on the username they
 * project, so a "View profile", "Book again" or "Open" href is non-null only when the page
 * resolves. `buildWhereConditions` / `facetEligibilityConditions` in
 * `expert-search.ts` still spell the three terms out as separate array entries, which their
 * unit tests count; they are the same rule.
 *
 * It does NOT require `username IS NOT NULL`: the slot route addresses a profile by id. A
 * caller that builds a `/experts/{username}` href projects the username, which is null anyway
 * when unclaimed.
 *
 * ⚠ RENDERED AS `(a and b and c)`, THE SAME SHAPE `and(...)` EMITS, and every Column reference
 * sits inside a raw `sql` template, so it takes whatever alias is in scope. That makes it safe
 * in the relational query builder (which aliases the table as `"expertProfiles"`) and in a core
 * `select` that joins the real `expert_profiles` table. It is NOT safe against
 * `alias(expertProfiles, …)`: the columns are bound to the base table and render as
 * `"expert_profiles".…`, which an aliased FROM does not contain (Postgres 42P01).
 * `expert_profiles` has no `deleted_at`; the owner's soft delete and suspension live on `users`
 * and are covered by `expertOwnerIsLive`.
 */
export const expertProfileIsPublic: SQL = sql`(${eq(expertProfiles.searchable, true)} and ${isNotNull(expertProfiles.approvedAt)} and ${expertOwnerIsLive})`;

/**
 * `expert_profiles.username` when the profile has a public page, otherwise NULL — the value a
 * `/experts/{username}` href is built from. Same alias rules as {@link expertProfileIsPublic}.
 */
export const publicProfileUsernameSql: SQL<string | null> = sql<
  string | null
>`case when ${expertProfileIsPublic} then ${expertProfiles.username} end`;

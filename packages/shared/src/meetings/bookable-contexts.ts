/**
 * BAL-129 — THE BOOKABLE CONTEXT LABELS: the subset of `meeting_context_type` a BOOKING may
 * name, and the only one.
 *
 * ⚠ IT LIVES HERE, NOT IN A ROUTE DIRECTORY, AND THAT IS THE POINT. This list is consumed by
 * three layers that must not disagree — `apps/api`'s Zod boundary
 * (`routes/meetings/schema.ts`), the tenancy gate that resolves each label to an owning party
 * (`services/meetings/authorize-meeting-booking.ts`), and `@balo/analytics`'s
 * `MeetingBookingContextType` (which USED to restate the union by hand). A service importing
 * from a route directory is a layering inversion, and a hand-copied union in a third package
 * is a drift waiting to happen; one `as const` tuple in `@balo/shared/meetings` closes both.
 *
 * ⚠ TWO OF THE SEVEN `meeting_context_type` LABELS ARE ABSENT, each for its own reason:
 *   · `admin` — scoped out by BAL-129. An internal Balo meeting projects no consultation row
 *     and occupies nobody's calendar, so there is no booking to authorize.
 *   · `retainer_checkin` — scoped out by BAL-129. (Its engagement kind, `retainer`, is
 *     therefore unreachable through the booking gate; see `BookableEngagementType`.)
 *
 * `request_interaction` was scoped out by BAL-129's D3 and assigned to BAL-283. BAL-283
 * ADMITS IT (Ruling 1, owner-ratified): a client↔candidate intro call DOES block the
 * candidate's calendar, and the consultation projection now has a rule for the label
 * (`request_expert_relationships.expert_profile_id`, see `_shared/consultation-projection.ts`).
 *
 * ⚠ THE CONSEQUENCE BELOW SURVIVES BAL-283, BUT ITS REASON CHANGES (plan §2.4 — do not "flip
 * it to live", that would be a false statement in the opposite direction). `admin` and
 * `retainer_checkin` are still refused at the Zod boundary here, so
 * `MeetingContextNotProjectableError` remains UNREACHABLE from `POST /meetings` — NOT because
 * this tuple refuses `request_interaction` (it no longer does), but because EVERY label this
 * tuple now admits has an explicit projection rule in `_shared/consultation-projection.ts`. It
 * nevertheless STAYS MAPPED in that route's error table — `409 context_not_bookable` — as
 * DEFENCE against an eighth `meeting_context_type` label admitted here later without a
 * matching projection arm, so that case cannot reach the client as an unexplained 500.
 *
 * ⚠ `MeetingContextRequiredError` IS THE OPPOSITE CASE, AND AN EARLIER VERSION OF THIS BLOCK
 * GOT IT WRONG BY LUMPING THE TWO TOGETHER. It is NOT in `bookingErrorResponse`'s table and
 * that is deliberate: it fires only when a caller passes ZERO contexts, and the route passes
 * exactly one it constructed itself, so it is unreachable by CONSTRUCTION rather than by this
 * tuple. Mapping it would be dead code SonarCloud counts as uncovered changed lines, and if it
 * ever DOES fire the route's own construction is broken — a Sentry-captured 500 is the correct
 * signal. See the fourth note in `apps/api/src/routes/meetings/index.ts`'s header.
 *
 * PURE and dependency-free, for the same reason the rest of this subpath is: `apps/api`,
 * `@balo/analytics` and an eventual `apps/web` booking surface must all reach ONE definition
 * without value-importing `@balo/db` (the client-bundle footgun).
 */
export const BOOKABLE_CONTEXT_TYPES = [
  'case',
  'project_kickoff',
  'package_session',
  'project_discovery',
  'request_interaction',
] as const;

/**
 * The five labels a booking may name. DERIVED from the tuple above — never restated, so a
 * sixth label cannot be admitted to one layer and not another.
 */
export type MeetingBookingContextType = (typeof BOOKABLE_CONTEXT_TYPES)[number];

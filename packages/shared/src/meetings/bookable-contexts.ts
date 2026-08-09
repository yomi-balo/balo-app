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
 * ⚠ THREE OF THE SEVEN `meeting_context_type` LABELS ARE ABSENT, each for its own reason:
 *   · `admin` — scoped out by BAL-129. An internal Balo meeting projects no consultation row
 *     and occupies nobody's calendar, so there is no booking to authorize.
 *   · `retainer_checkin` — scoped out by BAL-129. (Its engagement kind, `retainer`, is
 *     therefore unreachable through the booking gate; see `BookableEngagementType`.)
 *   · `request_interaction` — scoped out by D3 and assigned to **BAL-283**. Whether a
 *     client↔candidate call should block the candidate's calendar is an unmade PRODUCT
 *     ruling, and the projection module has no rule for the label (it throws
 *     `MeetingContextNotProjectableError`).
 *
 * The consequence is structural and worth naming: excluding them here makes
 * `MeetingContextNotProjectableError` UNREACHABLE from `POST /meetings` (only
 * `request_interaction` raises it, and this tuple refuses that label at the Zod boundary). It
 * nevertheless STAYS MAPPED in that route's error table — `409 context_not_bookable` — as
 * DEFENCE rather than as a live branch, so a fifth label admitted here later cannot reach the
 * client as an unexplained 500.
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
] as const;

/**
 * The four labels a booking may name. DERIVED from the tuple above — never restated, so a
 * fifth label cannot be admitted to one layer and not another.
 */
export type MeetingBookingContextType = (typeof BOOKABLE_CONTEXT_TYPES)[number];

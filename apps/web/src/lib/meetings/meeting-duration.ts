/**
 * meeting-duration — how long a meeting actually ran, in whole minutes.
 *
 * ⚠⚠ HOISTED, NOT COPIED (BAL-389). This function was module-private in
 * `meetings/[meetingId]/_lib/load-recap.ts`; the end-of-call screen's duration glance needs the
 * identical derivation, and a second five-line copy of it in a sibling route is exactly the
 * shape SonarCloud's >3% new-code duplication gate exists to catch (memory
 * `reference_sonar_duplication_not_caught_locally`). The body is UNCHANGED from the original,
 * including the `Math.max(0, …)` floor.
 *
 * ⚠ TYPED ON A STRUCTURAL SHAPE, NOT ON `@balo/db`'s `Meeting`. A full `Meeting` row satisfies
 * it, but this module never value-imports `@balo/db` — whose barrel re-exports `postgres` and
 * breaks `next build` on an unresolvable `tls` the moment anything client-side reaches it
 * (memory `reference_balo_db_client_bundle_footgun`). It is also why this is a plain, pure,
 * dependency-free module with no `server-only` marker: it has no I/O and no clock.
 *
 * ⚠ NOT HOISTED TO `@balo/shared`. That would need a new barrel export in a package with no
 * typecheck script (memory `reference_db_shared_no_typecheck_lint_scripts`), and BOTH consumers
 * live in `apps/web`.
 */

/**
 * Whole minutes between the two stamps; `null` when either is missing (never a bare zero).
 *
 * ⚠ `null` IS THE COMMON CASE TODAY, AND CALLERS MUST TREAT IT AS ONE. `meetings.started_at` /
 * `ended_at` are stamped by BAL-134's lifecycle transitions, which are BACKLOG — so every real
 * meeting row returns `null` here right now. A caller that substitutes the scheduled length, or
 * renders placeholder copy, is stating something the platform does not know.
 */
export function durationMinutesOf(
  meeting: Readonly<{ startedAt: Date | null; endedAt: Date | null }>
): number | null {
  const { startedAt, endedAt } = meeting;
  if (startedAt === null || endedAt === null) return null;
  return Math.max(0, Math.round((endedAt.getTime() - startedAt.getTime()) / 60_000));
}

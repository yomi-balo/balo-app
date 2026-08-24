import 'server-only';

/**
 * BAL-409 — the MEMBER join route, `/join/m/{meetingId}`. NEVER `meetings.join_url` (the raw
 * Daily URL — see `booking-api-client.ts`'s module docblock).
 *
 * ⚠⚠ LIVES IN `lib/`, NOT `app/`, DELIBERATELY. `invariants/join-link-never-writes.test.ts`
 * greps the ENTIRE app router (everything under `src/app`, minus the `/join` route tree
 * itself) for the literal substring `/join/`, because Next PREFETCHES a `<Link>` on
 * viewport/hover — which would stamp an access on a guest link nobody opened. That scan has
 * no exemption for `_actions/` files elsewhere in `app/` (only the `/join` route tree itself
 * is excluded), so inlining this template literal directly inside an `app/**\/_actions/*.ts`
 * Server Action trips it. Hoisting the ONE construction site here — the same directory
 * `apps/web/src/lib/booking/actions/book-consultation.ts` already builds its own
 * `joinPath: \`/join/m/${meetingId}\`` in — keeps every caller a plain function call with no
 * `/join/` substring of its own.
 *
 * ⚠ N10 — `book-consultation.ts` NO LONGER BUILDS ITS OWN COPY. That inline template literal
 * was a second, independently maintained definition of the same path; it now calls
 * `memberJoinPath()` like every other caller, so there is exactly one place this shape is
 * spelled out.
 */
export function memberJoinPath(meetingId: string): string {
  return `/join/m/${meetingId}`;
}

/**
 * BAL-493 §13.3 / N1 — is this pathname the marketing home (`/`)?
 *
 * ⚠⚠ THE ONE DEFINITION OF "IS THE MARKETING HOME", SHARED BY TWO CONSUMERS. Before this file
 * existed, `marketing-header.tsx` computed `pathname === '/'` inline for its transparent-over-
 * hero glass state (D3 §9.3), and `app-footer.tsx` independently needed the exact same check
 * for its duplicate-`contentinfo` fix (§13.3) — two definitions of the same predicate is
 * precisely the drift this repo's invariant scans exist to prevent. Both now import this.
 *
 * ⚠ A NAMED, UNIT-TESTED PREDICATE RATHER THAN AN INLINE MAGIC STRING in a shared component —
 * the same pattern `isMeetingCallPath` (`lib/meetings/is-meeting-call-path.ts`) already
 * established for `AppFooter`'s in-call suppression.
 *
 * ⚠ NO REGEX. A query/hash strip via `split` is linear and carries no S5852 exposure.
 */
export function isMarketingHomePath(pathname: string): boolean {
  const withoutHash = pathname.split('#')[0] ?? '';
  const withoutQuery = withoutHash.split('?')[0] ?? '';
  return withoutQuery === '/';
}

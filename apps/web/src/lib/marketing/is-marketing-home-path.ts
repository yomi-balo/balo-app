import { ANON_HOME_PATH } from '@/lib/auth/route-config';

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
 * ⚠ BAL-504 — ALSO MATCHES `ANON_HOME_PATH` (`/anon`). The anonymous home is a
 * genuinely separate route (`(marketing-anon)/anon/page.tsx`), rewritten in transparently from
 * `/` by middleware. Both `MarketingHeader` and `AppFooter` are CLIENT components: a static
 * prerender of `/anon` renders with the real route pathname (`/anon`), while a hydrated browser
 * reads the URL bar, which middleware kept at `/`. Without this widening the two disagree on
 * `overHero`/`isMarketingHome`, which is a hydration mismatch, not just a cosmetic flash.
 *
 * ⚠ NO REGEX. A query/hash strip via `split` is linear and carries no S5852 exposure.
 */
export function isMarketingHomePath(pathname: string): boolean {
  const withoutHash = pathname.split('#')[0] ?? '';
  const withoutQuery = withoutHash.split('?')[0] ?? '';
  return withoutQuery === '/' || withoutQuery === ANON_HOME_PATH;
}

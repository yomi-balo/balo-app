/**
 * utc-date — the SINGLE definition of the two UTC display-date formatters.
 *
 * ⚠⚠ EXTRACTED, NOT INVENTED (BAL-388). `formatLongUtc` had been re-inlined THREE times:
 * `engagement-lifecycle-shared.ts`, `_lib/load-recap.ts` and `_actions/resolve-case.ts` — and
 * two of those spellings feed a NOTIFICATION PAYLOAD, where a drifted format is a drifted
 * email. Three identical spellings of a date formatter is exactly the drift the
 * single-source-of-truth rule exists to stop, and the shape SonarCloud new-code duplication
 * gate catches. `engagement-lifecycle-shared.ts` now RE-EXPORTS these, so its three existing
 * importers are untouched.
 *
 * ⚠⚠ RE-EXPORTED FROM `@balo/shared/timezone` (`packages/shared/src/timezone/utc-date.ts`),
 * the ONE definition both apps share, so the api's case-inactivity sweep formats `closedDate`
 * identically without importing `apps/web`. Every existing importer here (and
 * `engagement-lifecycle-shared.ts`'s three, one level further out) resolves unchanged.
 *
 * Deterministic under `TZ=UTC` and identical on server and client (the timeZone option is
 * explicit), so either may format a stored instant without a hydration mismatch.
 */
export { formatShortUtc, formatLongUtc } from '@balo/shared/timezone';

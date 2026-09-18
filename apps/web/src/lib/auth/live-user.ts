import 'server-only';

import { cache } from 'react';
import { usersRepository } from '@balo/db';

/** The row `usersRepository.findForSessionSync` returns — `null` when the id matches nothing. */
export type LiveUserRow = Awaited<ReturnType<typeof usersRepository.findForSessionSync>>;

/**
 * BAL-568 (ruling 2026-09-18) — **THE ONE LIVE-ROW READ FOR THIS REQUEST.**
 *
 * `React.cache()`'d, so the liveness gate, `checkSessionDrift` and
 * `actorHoldsPlatformCapability` share a SINGLE round trip. Without that the 22 platform-gated
 * staff actions would pay two reads each, and every dashboard render would pay two as well.
 *
 * ⚠ WHY `findForSessionSync` RATHER THAN A NARROW `{status, deletedAt}` READER — the choice is
 * deliberate and was made on the cost, not the columns:
 *   1. It is THE QUERY THE APP ALREADY RUNS on every dashboard render and in every platform-gated
 *      staff action. Reusing it is what lets all three share ONE cache entry. A narrower reader
 *      would be a DIFFERENT query that can share neither cache — so a staff action would pay two
 *      round trips, which is exactly what the "must not read twice" ruling forbids.
 *   2. It is a PRIMARY-KEY lookup with one `LEFT JOIN expert_profiles` on an indexed FK. The
 *      extra eight columns are not the cost; a second round trip is.
 *   3. Its projection is already EXPLICIT (never a relational `with:`), so no PII widening
 *      occurs — `workosId` / `email` / `phone` are not in it.
 *   4. Every existing test that mocks `usersRepository.findForSessionSync` keeps working
 *      unchanged, because this calls straight through to the mocked repository.
 *
 * ⚠⚠ THE "READ ONCE" PROPERTY IS A MECHANISM, NOT A CONVENTION. `React.cache()` is half of it;
 * the other half is `invariants/live-row-single-reader.test.ts`, which asserts that every
 * per-request consumer calls `readLiveUserRow(` and that NONE of them calls
 * `usersRepository.findForSessionSync(` directly. (`React.cache()` is a no-op outside a React
 * request scope — vitest included — so the dedupe is not unit-testable at runtime; the source
 * invariant is the honest pin. `session-sync.ts` already relied on `cache()` the same way.)
 *
 * ⚠⚠ MUST NOT IMPORT `./session`. `session.ts` imports the liveness gate, which imports this
 * module; adding the reverse edge would make a cycle at the most load-bearing seam in the app.
 * Nothing here needs the session: the caller has already resolved a user id.
 */
export const readLiveUserRow = cache(
  async (userId: string): Promise<LiveUserRow> => usersRepository.findForSessionSync(userId)
);

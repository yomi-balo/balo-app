import 'server-only';

import { cache } from 'react';
import { usersRepository } from '@balo/db';

/** The row `usersRepository.findForSessionSync` returns — `null` when the id matches nothing. */
export type LiveUserRow = Awaited<ReturnType<typeof usersRepository.findForSessionSync>>;

/**
 * BAL-568 — **THE ONE FUNCTION THAT READS THE LIVE `users` ROW.** One reader, not one read.
 *
 * ⚠⚠ WHAT `React.cache()` ACTUALLY BUYS HERE, AND WHAT IT DOES NOT (corrected 2026-09-19 after
 * human review of PR #325 — AN EARLIER VERSION OF THIS DOCBLOCK OVERCLAIMED, so read this before
 * trusting any "shares a single round trip" phrasing elsewhere):
 *
 *   · `React.cache()` memoizes **only during a server-component render pass.** Confirmed
 *     empirically, not inferred: a `cache()`-wrapped function called twice outside a render
 *     invoked its inner function **twice**.
 *   · So on a **page render** the gate, `checkSessionDrift` and `deriveWorkspacesForUser` really
 *     do share ONE round trip — that part was always true.
 *   · On a **Server Action** (which runs BEFORE Next starts the render) and in a **Route Handler**
 *     (which never runs inside one), the wrapper does nothing: **every seam call is its own
 *     query.**
 *
 * ⚠ THE CONSEQUENCE, RULED ACCEPTABLE (user, 2026-09-19): the 22 platform-gated staff actions pay
 * **TWO** primary-key reads — one for the liveness gate inside `requireOnboardedUser`, one inside
 * `actorHoldsPlatformCapability`. That is a deliberate, accepted cost on a rare path, NOT a defect
 * to fix. Do not restructure this read, do not thread a request-scoped cache through the seams,
 * do not add a caching layer. `live-user.test.ts` pins the two-read behaviour with an explicit
 * `toHaveBeenCalledTimes(2)` so this docblock cannot quietly drift back into overclaiming.
 *
 * ⚠ WHY `findForSessionSync` RATHER THAN A NARROW `{status, deletedAt}` READER — the choice is
 * deliberate and survives the correction above:
 *   1. It is THE QUERY THE APP ALREADY RUNS on every dashboard render and in every platform-gated
 *      staff action, so on the RENDER path (where `cache()` does work) all three consumers share
 *      one entry. A narrower reader would be a different query and could share neither.
 *   2. It is a PRIMARY-KEY lookup with one `LEFT JOIN expert_profiles` on an indexed FK — cheap
 *      enough that the second read on the action path is affordable, which is what makes the
 *      ruling above reasonable.
 *   3. Its projection is already EXPLICIT (never a relational `with:`), so no PII widening
 *      occurs — `workosId` / `email` / `phone` are not in it.
 *   4. Every existing test that mocks `usersRepository.findForSessionSync` keeps working
 *      unchanged, because this calls straight through to the mocked repository.
 *
 * ⚠ THE PROPERTY `invariants/live-row-single-reader.test.ts` HOLDS IS "ONE READER", NOT "ONE
 * READ": every per-request consumer goes through this function, and nothing outside the small
 * allowed set calls `usersRepository.findForSessionSync(` directly. That is a real and useful
 * property — it is what makes the read swappable in one place — but it is not a dedupe.
 *
 * ⚠⚠ MUST NOT IMPORT `./session`. `session.ts` imports the liveness gate, which imports this
 * module; adding the reverse edge would make a cycle at the most load-bearing seam in the app.
 * Nothing here needs the session: the caller has already resolved a user id.
 */
export const readLiveUserRow = cache(
  async (userId: string): Promise<LiveUserRow> => usersRepository.findForSessionSync(userId)
);

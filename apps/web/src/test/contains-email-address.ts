/**
 * BAL-436 — the concealment sweeps' "does this text contain an email address?" scan.
 *
 * ⚠⚠ **THIS FILE IS A RE-EXPORT, AND THAT IS THE POINT.** The implementation lives in
 * `@balo/shared/meetings` (`self-declared-name.ts`) because `apps/api`'s PUBLIC lobby route
 * runs the SAME scan server-side, at the knock, before a self-declared name is ever written.
 * A second copy here would be a second place a future weakening has to be noticed — and the
 * failure mode is silent: the api half would keep letting an address through while these
 * sweeps kept passing. SonarCloud also counts duplicated blocks across files.
 *
 * ⚠ WHY NOT A REGEX (the reason survives the move, restated so it is readable from the side
 * that trips over it): the obvious pattern — `/[\w.-]+@[\w-]+\.[a-z]{2,}/i` — is a quantifier
 * followed by a rejecting suffix, which `regexp/no-super-linear-move` (the local half of
 * SonarCloud's ReDoS rule S5852) flags as quadratic. It fires on TEST files too, and
 * `apps/web`'s lint runs at `--max-warnings 0`.
 *
 * ⚠ THE SCAN IS DELIBERATELY **LOOSE**, i.e. biased toward FALSE ALARMS. It only has to be
 * right in one direction: it must never miss a real address that leaked. A stray match on
 * unusual prose is a test failure somebody reads; a miss is a leak nobody sees.
 *
 * ⚠ THIS FILE IS NOT A TEST and is deliberately not named like one — vitest collects only
 * `*.test.ts` / `*.spec.ts`, so a helper here is imported, never run as a suite.
 */
export { containsEmailAddress } from '@balo/shared/meetings';

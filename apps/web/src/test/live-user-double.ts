import { vi } from 'vitest';

/**
 * BAL-568 — the shared `@/lib/auth/live-user` test double.
 *
 * ⚠⚠ WHY A SHARED MODULE AND NOT 30 COPIES (fix round 1, F14). Every actor-resolution seam
 * (`withAuth` / `requireUser` / `requireOnboardedUser` / `getCurrentUser`) now re-reads the LIVE
 * `users` row before an action runs, so ~30 suites that are not ABOUT that gate still have to
 * satisfy it. The first cut inlined an identical nine-line `vi.mock` block in each of them — which
 * EXTENDED an already-cloned file header, taking `expert/settings/_actions` to **19.53%** measured
 * duplication against SonarCloud's **<3% on new code** gate. That is a CI failure, not a style
 * preference.
 *
 * Usage — one line per suite, and nothing else:
 *
 * ```ts
 * vi.mock('@/lib/auth/live-user', async () => (await import('@/test/live-user-double')).mock);
 * ```
 *
 * ⚠ IT RETURNS A LIVE ACCOUNT, ALWAYS. That is the right default for a suite testing something
 * else, and it is deliberately NOT configurable: a suite that wants to drive suspended /
 * soft-deleted / unreadable behaviour should mock `@balo/db`'s `findForSessionSync` directly and
 * exercise the real gate, the way `lib/auth/session.test.ts`, `lib/auth/with-auth.test.ts` and the
 * `lib/auth/actions/*` suites do. Making this double configurable would invite the gate's own
 * behaviour to be asserted through a stub of itself.
 */
export const mock = {
  readLiveUserRow: vi.fn(async () => ({ status: 'active', deletedAt: null })),
};

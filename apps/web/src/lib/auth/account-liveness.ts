import 'server-only';

import { cache } from 'react';
import {
  classifyAccountRefusal,
  reasonOfRefusal,
  type AccountRefusalCode,
} from '@balo/shared/authz';
import { trackServerAndFlush, AUTH_SERVER_EVENTS } from '@/lib/analytics/server';
import { log } from '@/lib/logging';
import { readLiveUserRow } from './live-user';

/** Which enforcement path caught the refusal — the `session_invalidated` dimension. */
export type AccountRefusalPath = 'page' | 'api' | 'action';

/**
 * The refusal an unreadable row produces. It is NOT an {@link AccountRefusalCode}: a database
 * fault refuses (fail closed on ACCESS) but must never claim the account is suspended (fail open
 * on TEARDOWN). A blip that signed everyone out with "your account has been suspended" would be a
 * mass-logout incident and a lie about their account.
 */
export const ACCOUNT_UNREADABLE = 'account_unreadable';

/**
 * BAL-568 (ruling 2026-09-18) — thrown by {@link assertAccountLive} when the LIVE row refuses.
 *
 * ⚠⚠ IT IS A PLAIN `Error` SUBCLASS, AND IT DELIBERATELY NEVER `redirect()`s. The dominant
 * shipped call-site shape is
 * `try { user = await requireOnboardedUser(); } catch { return { success:false, error: NOT_SIGNED_IN }; }`
 * — measured at ~75 catch sites across ~97 files, and `unstable_rethrow` appears NOWHERE in this
 * codebase. A `redirect()` thrown from inside the gate would be SWALLOWED by every one of those
 * bare catches and rendered as "you are not signed in": a silent failure of the sign-out, the
 * worst outcome. Throwing an ordinary `Error` instead means every one of those sites already
 * produces the correct refusal with ZERO edits, which is the binding constraint on this ticket.
 *
 * The security property does not depend on the redirect: after this ticket every actor-resolution
 * seam re-reads the live row, so the cookie GRANTS NOTHING. Tearing it down is UX tidiness, and it
 * is handled by BAL-197's shipped session-sync route on the next render, with the right message.
 */
export class AccountNotLiveError extends Error {
  readonly code: AccountRefusalCode | typeof ACCOUNT_UNREADABLE;

  constructor(code: AccountRefusalCode | typeof ACCOUNT_UNREADABLE) {
    super(`Account not live: ${code}`);
    this.name = 'AccountNotLiveError';
    this.code = code;
  }
}

/**
 * THE ONE PLACE an account refusal is logged and emitted, for every path. Keeping it here (rather
 * than at each of the call sites) is what makes the `path` dimension trustworthy.
 *
 * ⚠⚠ IT IS `React.cache()`'d ON `(userId, path)`, AND THAT IS A DEFECT FIX, NOT AN OPTIMISATION
 * (fix round 1, F3). `readLiveUserRow` is cached so the READ dedupes, but the emission was not, and
 * the seams call it more than once per request: a suspended visitor on the MARKETING surface — where
 * nothing converges, because there is no `checkSessionDrift` redirect to eject them — emitted two
 * events and two log lines on EVERY page view, indefinitely, each one a *flushing* PostHog call.
 * Keying on `path` as well as `userId` keeps a genuine page-then-action sequence distinguishable
 * while collapsing the repeats within one path.
 *
 * ⚠ `trackServerAndFlush`, NOT `trackServer`: Vercel route handlers and Server Actions are
 * serverless and an unflushed PostHog batch is lost when the function freezes.
 *
 * ⚠ UNDER IMPERSONATION `userId` IS THE **TARGET'S**, NOT THE STAFF MEMBER'S (BAL-553, fix round 1
 * F13). `session.user.id` carries the impersonated customer's id for the whole session, so a
 * refusal raised while a staff member is impersonating is attributed to the CUSTOMER in both the
 * log line and `distinct_id`. The gating behaviour is right — it is the target's account that is
 * being refused — but the attribution surprises anyone reading the event stream, and it is the same
 * trap this repo already records for actor-persisting actions generally.
 */
export const noteAccountRefusal = cache(
  (code: AccountRefusalCode, path: AccountRefusalPath, userId: string): void => {
    const reason = reasonOfRefusal(code);
    log.info('Session invalidated: account not live', { userId, path, reason });
    trackServerAndFlush(AUTH_SERVER_EVENTS.SESSION_INVALIDATED, {
      distinct_id: userId,
      path,
      reason,
    });
  }
);

/**
 * `null` ⇒ the account is live and may act. Otherwise the refusal.
 *
 * ⚠⚠ THE CALLER SUPPLIES THE `path`, AND IT DEFAULTS TO `'action'` ONLY BECAUSE THAT IS THE
 * DOMINANT SEAM. **The plan (§5.2) hard-coded `'action'` here; that was a PLAN DEFECT, not a
 * builder choice — do not "restore" it.** `getCurrentUser()` runs from `app/layout.tsx`,
 * `(marketing)/layout.tsx` and `(dashboard)/layout.tsx`, so with the constant every render-path
 * refusal was reported as an action refusal and R3's `page` arm was emitted by the sync route
 * alone — which defeats the entire point of the dimension (knowing how often a suspended account is
 * stopped OUTSIDE a page load).
 *
 * ⚠ FAIL CLOSED ON A DB FAULT: an unreachable database must not be a way to keep acting while
 * suspended. It returns {@link ACCOUNT_UNREADABLE} rather than a refusal CODE, and emits NO
 * analytics — a database blip is not a session invalidation and must not be counted as one.
 */
export async function accountRefusalFor(
  userId: string,
  path: AccountRefusalPath = 'action'
): Promise<AccountRefusalCode | typeof ACCOUNT_UNREADABLE | null> {
  let row: Awaited<ReturnType<typeof readLiveUserRow>>;
  try {
    row = await readLiveUserRow(userId);
  } catch (error) {
    log.error('Account liveness read failed — refusing', {
      actorUserId: userId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return ACCOUNT_UNREADABLE;
  }

  const refusal = classifyAccountRefusal(row);
  if (refusal !== null) noteAccountRefusal(refusal, path, userId);
  return refusal;
}

/**
 * The Server Action gate. Throws {@link AccountNotLiveError} for a non-live or unreadable row.
 *
 * ⚠ ON THE CHOKEPOINT SEAMS IT SITS ABOVE THE PARSE BY CONSTRUCTION. It is folded into the actor
 * resolution (`requireUser` / `withAuth` / `getCurrentUser`), and every action that resolves its
 * actor through one of those does so as its FIRST statement, before `safeParse` — so those call
 * sites cannot get the ordering wrong, because they were not edited at all.
 *
 * ⚠⚠ THAT GUARANTEE DOES **NOT** EXTEND TO THE BOUNDED `getSession()`-ONLY SET, AND AN EARLIER
 * VERSION OF THIS DOCBLOCK CLAIMED IT DID (fix round 1, F4). Those modules have no chokepoint to
 * fold into, so BAL-568 edited them by hand — and three of them placed the gate BELOW their
 * `safeParse` on the first cut. They are fixed, but the ordering there is a CONVENTION the author
 * must honour, not a property of this function: put the gate immediately after the session's user
 * is established and before any parse, read or write. A docblock that vouches for more than it can
 * deliver is worse than the bug, because the next reader stops checking.
 */
export async function assertAccountLive(userId: string): Promise<void> {
  const refusal = await accountRefusalFor(userId);
  if (refusal !== null) throw new AccountNotLiveError(refusal);
}

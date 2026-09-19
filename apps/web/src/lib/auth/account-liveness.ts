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

/**
 * Which enforcement path caught the refusal — the `session_invalidated` dimension.
 *
 * ⚠ TWO NAMED RESIDUALS. The label is what the SEAM is, not what the CALLER was, and neither seam
 * can tell its callers apart from the inside. Both are log/analytics dimensions only — nothing
 * branches on the value — so each costs accuracy in the event stream and nothing else:
 *
 * | seam                                | labels as | but also serves                      |
 * | ----------------------------------- | --------- | ------------------------------------ |
 * | `getCurrentUser`                    | `page`    | the few Server Actions resolving there |
 * | `requireUser` → `assertAccountLive` | `action`  | server-component RENDERS that call it |
 *
 * The second row's live instance: `getChecklistStatus()` resolves through `requireOnboardedUser`
 * and is awaited by the `(dashboard)` layout on every authenticated render, so a refusal raised
 * during that RENDER is recorded as an `action` refusal.
 *
 * (The `getCurrentUser` row is written up at its own call site in `./session.ts`; the
 * `requireUser` row was added in fix round 3, H4 — known and accepted, now written down.)
 */
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
 * ── ⚠⚠ ONE EMITTER PER PATH. READ THIS BEFORE ADDING A `trackServerAndFlush` ANYWHERE NEAR A
 *    LIVENESS REFUSAL (fix round 2, G3) ────────────────────────────────────────────────────────
 *
 * `auth_session_invalidated` must fire **exactly once per refusal**. Its docblock said so from the
 * start; the code did not honour it, because two layers both emitted for the same refusal:
 *
 *   · an API refusal emitted in `apps/api`'s `requireAuth` AND again in `consumeApiAccountRefusal`;
 *   · a page ejection emitted in `getCurrentUser()` (root layout) AND again in the sync route.
 *
 * The rule now, and the only place it is written down:
 *
 * | path     | THE ONE EMITTER                                                     |
 * | -------- | ------------------------------------------------------------------- |
 * | `api`    | `apps/api`'s `requireAuth` — the refusal originates there            |
 * | `page`   | `app/api/auth/session-sync/route.ts` — the route that ejects         |
 * | `action` | `assertAccountLive`, or a hand-gated action's own `{ emit: true }`       |
 *
 * Everything else is **LOG-ONLY**: it keeps its `log.*` line (which is what you debug with) and
 * emits nothing. That includes `getCurrentUser`, the `switch-workspace` route and every web→api
 * client — each of which hands off to a layer that does emit.
 *
 * ⚠ THIS ALSO CLOSES A REAL EVENT FLOOD. `NotificationBell` polls `/api/notifications` every 30s
 * and KEEPS POLLING after a 401; that route resolves its actor through `getCurrentUser()`. While
 * that seam emitted, a suspended user with one open tab produced a *flushing* PostHog call every
 * 30 seconds for the life of the cookie. Exposure is zero today (only a direct DB edit can suspend
 * anyone) and becomes real the moment an admin suspend screen ships.
 *
 * `emitter-per-path.test.ts` pins the rule structurally so a new emitter cannot be added quietly.
 */

/**
 * Log a refusal, and emit `auth_session_invalidated` — for the callers that OWN a path per the
 * table above. A caller that does not own its path calls {@link logAccountRefusal} instead.
 *
 * ⚠ `trackServerAndFlush`, NOT `trackServer`: Vercel route handlers and Server Actions are
 * serverless and an unflushed PostHog batch is lost when the function freezes.
 *
 * ⚠ IT IS `React.cache()`'d, WHICH HELPS ONLY ON THE RENDER PATH (corrected 2026-09-19). An
 * earlier version claimed this made the emission fire "at most once per request" outright; it does
 * not — `React.cache()` memoizes only inside a server-component render pass, so on a Server Action
 * or a Route Handler it is inert (see `./live-user.ts`). The wrapper is kept because it is free and
 * genuinely collapses repeat renders; **the one-emitter-per-path rule above is what actually
 * guarantees one event per refusal**, and it does so without depending on a render scope.
 *
 * ⚠ UNDER IMPERSONATION `userId` IS THE **TARGET'S**, NOT THE STAFF MEMBER'S (BAL-553, fix round 1
 * F13). `session.user.id` carries the impersonated customer's id for the whole session, so a
 * refusal raised while a staff member is impersonating is attributed to the CUSTOMER in both the
 * log line and `distinct_id`. The gating behaviour is right — it is the target's account that is
 * being refused — but the attribution surprises anyone reading the event stream.
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
 * Log a refusal and emit NOTHING — for a seam that catches a refusal it does not own the path for.
 * The `log.*` line is identical to {@link noteAccountRefusal}'s so debugging is unaffected; only
 * the analytics event is withheld, because a layer downstream will emit it.
 */
export function logAccountRefusal(
  code: AccountRefusalCode,
  path: AccountRefusalPath,
  userId: string
): void {
  log.info('Session invalidated: account not live', {
    userId,
    path,
    reason: reasonOfRefusal(code),
  });
}

/** How a caller of {@link accountRefusalFor} wants the refusal recorded. */
export interface AccountRefusalOptions {
  /**
   * The path to record the refusal under. Required — there is no sensible default, and the plan
   * (§5.2) hard-coding `'action'` here is exactly how every render-path refusal came to be
   * mislabelled as an action refusal (fix round 1, F3). Do not reintroduce a default.
   */
  readonly path: AccountRefusalPath;
  /**
   * `true` ⇒ this caller OWNS the path and emits `auth_session_invalidated`.
   * `false` (the default) ⇒ **log-only**; a downstream layer owns the emission.
   * See the one-emitter-per-path table above before setting this.
   */
  readonly emit?: boolean;
}

/**
 * `null` ⇒ the account is live and may act. Otherwise the refusal.
 *
 * ⚠ FAIL CLOSED ON A DB FAULT: an unreachable database must not be a way to keep acting while
 * suspended. It returns {@link ACCOUNT_UNREADABLE} rather than a refusal CODE, and records NOTHING
 * — a database blip is not a session invalidation and must not be logged or counted as one. The
 * read failure has already been logged at `error` by then.
 */
export async function accountRefusalFor(
  userId: string,
  options: AccountRefusalOptions
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
  if (refusal !== null) {
    const record = options.emit === true ? noteAccountRefusal : logAccountRefusal;
    record(refusal, options.path, userId);
  }
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
  // ⚠ THE ONE EMITTER FOR THE `action` PATH (fix round 2, G3) — see the table above.
  const refusal = await accountRefusalFor(userId, { path: 'action', emit: true });
  if (refusal !== null) throw new AccountNotLiveError(refusal);
}

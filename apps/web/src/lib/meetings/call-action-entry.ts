import type { z } from 'zod';

/**
 * BAL-437 — the ENTRY PREAMBLE shared by the four in-call Server Actions: authenticate, then
 * validate, then hand back a narrowed actor and parsed input.
 *
 * ── ⚠⚠ WHY IT EXISTS: A MEASURED DUPLICATION FINDING, NOT A TIDINESS ONE ────────────────
 *
 * The four actions opened with a byte-identical ~19-line block (a `try`/`catch` around the auth
 * helper returning `'You are not signed in.'`, then a `safeParse` returning `'Invalid request.'`)
 * and closed with a byte-identical ~8-line catch. `jscpd` put the TypeScript half of this
 * change at 5.46% against SonarCloud's 3% new-code duplication gate, and this preamble was the
 * cluster. Extracting it is what brings the number under the gate.
 *
 * ── ⚠⚠ **NOT A `'use server'` MODULE, AND THAT IS LOAD-BEARING** ────────────────────────
 *
 * A `'use server'` file may export ONLY async functions — `export const NOT_SIGNED_IN = '…'`
 * in one fails `next build` (and only once the module is in the client graph), while `tsc`,
 * ESLint and vitest all stay green (`reference_use_server_no_value_exports`). This is a plain,
 * client-safe module (imported by the actions and by the `'use client'` hook), so it may export
 * the literals too.
 *
 * ⚠⚠ BAL-461 — ALSO IMPORTED FROM THE `'use client'` HOOK `use-meeting-realtime.ts`, which reads
 * `CALL_ACTION_THROTTLED_ERROR` off this module to recognise a throttled reaction refusal
 * without re-declaring the literal. That import puts this file in the CLIENT BUNDLE, so it must
 * stay free of `@balo/db`, `@/lib/logging` and `server-only` — any of those would either fail
 * `next build` or leak a server-only module into client code
 * (`reference_balo_db_client_bundle_footgun`, `reference_client_components_cannot_import_web_logger`).
 * `callActionErrorFields` below narrows errors ITSELF rather than importing `errorMessage` from
 * `@/lib/logging`, for exactly this reason.
 *
 * ── ⚠⚠ THE AUTH HELPER IS PASSED AS A **CALLED THUNK**, ON PURPOSE ──────────────────────
 *
 * Callers write `enterCallAction(() => requireUser(), …)`, never `enterCallAction(requireUser, …)`.
 * `onboarding-mutation-gate.test.ts` scans each action's OWN comment-stripped source for a real
 * `requireUser(` call and for the presence of SOME auth helper name; a bare value reference
 * would drop `fetch-meeting-thread.ts` out of its `bareRequireUser` set, failing the
 * "allowlisted files still call bare requireUser()" assertion — i.e. the invariant would go
 * quiet about the one action it is allowlisting. The thunk keeps every action honest at the
 * scanner AND at the type level.
 *
 * ⚠ IT ADDS NOTHING TO THE AUTHORIZATION DECISION. No gate, no tenancy, no capability — those
 * stay in each action, because they differ per action and because a shared "and also authorize"
 * step is how a caller ends up trusting a decision it never read.
 */

/** ⚠ THE TWO SHIPPED LITERALS, verbatim. Every in-call action refuses with these exact strings. */
export const NOT_SIGNED_IN_ERROR = 'You are not signed in.';
export const INVALID_REQUEST_ERROR = 'Invalid request.';

/**
 * BAL-461 — the shared rate limit's refusal literal, shared by every in-call consumer that
 * treats a throttle as a QUIET refusal: `sendMeetingReactionAction`, `fetchMeetingThreadAction`
 * and `createMeetingRealtimeTokenAction`. `postMeetingMessageAction` uses its OWN literal,
 * {@link CHAT_POST_THROTTLED_ERROR}, because chat shows the refusal to the person.
 *
 * ⚠ NEVER SHOWN TO ANYONE. `use-meeting-realtime.ts` — a `'use client'` module — imports this
 * constant directly rather than re-declaring it, matching a throttled reaction to the SAME quiet
 * handling as a tap its own 600ms cooldown would have coalesced (see `sendReaction`). That is
 * also why this literal has to live in a plain module rather than inside a `'use server'` action,
 * which may export only async functions.
 */
export const CALL_ACTION_THROTTLED_ERROR = 'Too many requests. Try again in a moment.';

/**
 * BAL-461 — `postMeetingMessageAction`'s own throttle refusal, shown to the sender exactly like
 * any other post refusal (`toast.error` plus the panel's live-region announce); the draft
 * survives, and analytics records the same `outcome: 'rejected'` a fixable refusal already gets.
 * A fixed one-minute wording rather than a dynamic countdown, matching the bucket's 60s window.
 */
export const CHAT_POST_THROTTLED_ERROR =
  "You're sending messages quickly — give it a minute and try again.";

export type CallActionEntry<U, T> =
  | { readonly ok: true; readonly user: U; readonly data: T }
  /**
   * ⚠ ONE OF `NOT_SIGNED_IN_ERROR` OR `INVALID_REQUEST_ERROR` — the only two refusals
   * `enterCallAction` itself can produce, ready to be spread into the action's own result shape.
   * A throttle refusal (`CALL_ACTION_THROTTLED_ERROR` / `CHAT_POST_THROTTLED_ERROR`) is a
   * DIFFERENT, later step: each action checks it itself, AFTER this call succeeds and BEFORE its
   * own tenancy gate — it is never folded into this type.
   */
  | { readonly ok: false; readonly error: string };

/**
 * Authenticate and validate, in that order.
 *
 * ⚠ AUTH FIRST, VALIDATION SECOND, MATCHING ALL FOUR SHIPPED ACTIONS. It means an
 * unauthenticated caller learns nothing about the schema — and it is also why every action's
 * "no gate call was made" test can assert on the auth refusal alone.
 */
export async function enterCallAction<U, S extends z.ZodType>(
  authenticate: () => Promise<U>,
  schema: S,
  input: unknown
): Promise<CallActionEntry<U, z.infer<S>>> {
  let user: U;
  try {
    user = await authenticate();
  } catch {
    return { ok: false, error: NOT_SIGNED_IN_ERROR };
  }

  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: INVALID_REQUEST_ERROR };
  }

  return { ok: true, user, data: parsed.data as z.infer<S> };
}

/**
 * The two error fields every in-call `catch` block logs, built once.
 *
 * ⚠ IT DOES NOT LOG — it returns fields to SPREAD into the caller's own `log.error`, so each
 * action keeps its own message and its own context keys (`meetingId`, `conversationId`, …).
 * A shared logger call would flatten four distinct operational events into one.
 *
 * ⚠ `errorMessage` IS NOT IMPORTED HERE, deliberately: it lives in `@/lib/logging`, which is
 * bare `pino` + `AsyncLocalStorage` and carries no `server-only` marker. ⚠⚠ THIS FILE CARRIES NO
 * `'use client'` DIRECTIVE ITSELF, so `meeting-call-no-lens-gate.test.ts`'s "no client module
 * imports @/lib/logging" check — which pattern-matches that literal directive — does not scan it
 * directly. The real protection is BAL-461's own fact: `use-meeting-realtime.ts` (a genuine
 * `'use client'` module) imports `CALL_ACTION_THROTTLED_ERROR` from this file, pulling it into
 * the client bundle transitively. A `@/lib/logging` import here would not be CAUGHT by that
 * invariant — it would fail `next build` silently past every local gate. The narrowing below is
 * the same one `errorMessage` performs for these two cases.
 */
export function callActionErrorFields(error: unknown): {
  readonly error: string;
  readonly stack: string | undefined;
} {
  if (error instanceof Error) {
    return { error: error.message, stack: error.stack };
  }
  if (typeof error === 'string') {
    return { error, stack: undefined };
  }
  try {
    return { error: JSON.stringify(error) ?? 'Unknown error', stack: undefined };
  } catch {
    return { error: 'Unknown error', stack: undefined };
  }
}

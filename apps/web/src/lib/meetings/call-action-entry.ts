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
 * ESLint and vitest all stay green (`reference_use_server_no_value_exports`). This is a plain
 * server module, so it may export the literals too.
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

export type CallActionEntry<U, T> =
  | { readonly ok: true; readonly user: U; readonly data: T }
  /** ⚠ ONE OF THE TWO LITERALS ABOVE, ready to be spread into the action's own result shape. */
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
 * bare `pino` + `AsyncLocalStorage` and carries no `server-only` marker, and this module sits
 * in `lib/meetings` — a directory `meeting-call-no-lens-gate.test.ts` scans for exactly that
 * import. The narrowing below is the same one `errorMessage` performs for these two cases.
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

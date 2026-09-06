import 'server-only';

import { log } from '@/lib/logging';

/**
 * True when `error` is a Postgres DEADLOCK DETECTED (SQLSTATE 40P01).
 *
 * BAL-540 fix round. The close / decline cascades lock BOTH open proposal statuses
 * (`draft` and `submitted`) on their way to the relationship row, which bridges the two
 * previously-disjoint proposal worlds that `proposalsRepository.accept` (proposal →
 * relationship → request) and `promoteToSubmit` (relationship → request → proposal) each
 * live in. That completes an AB/BA cycle: the cascade holds a `draft` proposal and waits on
 * the relationship; `promoteToSubmit` holds that relationship and waits on the same draft.
 * Postgres detects it after `deadlock_timeout` (1s by default) and aborts ONE side with
 * 40P01. See the LOCK ORDER block on `projectRequestsRepository.close` for the full
 * analysis and the follow-up ticket that serialises the five writers properly.
 *
 * A deadlock abort is EXPECTED-RARE and SELF-HEALING: the aborted transaction wrote
 * nothing, and the winner has committed by the time the loser's caller sees this, so a
 * retry succeeds. Hence `log.warn` + retryable copy at the call sites, never `log.error`.
 *
 * ⚠ THE CATCH LIVES IN THE SERVER ACTION, OUTSIDE THE TRANSACTION. The repository's
 * `db.transaction` has already rolled back by the time the rejection reaches the action, so
 * the "catching a raw SQLSTATE aborts the surrounding test transaction" hazard (which bites
 * repositories that swallow 23505 INSIDE their own `tx`) does not apply here.
 *
 * Structural narrowing (no `any`, no assertion) — the `in` guard narrows `object` to carry
 * `code`. Byte-identical in shape to this directory's shipped `isUniqueViolation` helpers
 * (`save-proposal-draft.ts`, `confirm-request-file-upload.ts`), which is how postgres-js
 * surfaces a SQLSTATE on the thrown error in this codebase.
 */
export function isDeadlockDetected(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  return 'code' in error && error.code === '40P01';
}

/**
 * pending-MJ. The RETRYABLE copy every BAL-540 close / decline action returns on a 40P01,
 * deliberately distinct from each action's generic failure string: a deadlock abort wrote
 * nothing and the winning transaction has already committed, so trying again really does work.
 * Defined ONCE so the four actions cannot drift apart on the wording.
 */
export const CONCURRENT_RETRY_MESSAGE = 'Something ran at the same moment — please try again.';

/**
 * True when `error` carries a non-empty string `detail`. postgres-js copies the server's
 * `PG_DIAG_MESSAGE_DETAIL` onto the thrown error, and on a 40P01 that field is the ONLY place
 * the useful part lives: "Process 123 waits for ShareLock on transaction 456; blocked by
 * process 789." — i.e. WHICH two writers of the five collided. Same structural narrowing
 * shape as {@link isDeadlockDetected}: an `in` guard plus a `typeof`, no `any`, no assertion.
 */
function deadlockDetail(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  if (!('detail' in error)) return undefined;
  const { detail } = error;
  return typeof detail === 'string' && detail.length > 0 ? detail : undefined;
}

/**
 * The whole 40P01 arm of a close / decline action's `catch`, in one place: detect, `log.warn`
 * (expected-rare and self-healing — never `log.error`), and hand back the retryable failure.
 * Returns `null` when `error` is something else, so the caller falls through to its own arms.
 *
 * ⚠ THE ERROR ITSELF IS LOGGED, not just the caller's context. This is a HANDLED boundary —
 * the rejection is converted into a user-facing string and never re-thrown, so without
 * `error` / `stack` here the original is simply lost (CLAUDE.md's caught-error-boundary rule).
 * `detail` rides along when postgres-js supplied one, because on a deadlock it names the two
 * colliding processes and is the difference between "a deadlock happened" and knowing which
 * pair of the five writers to serialise first.
 *
 * The returned shape is the bare `{ success: false; error }` common to all four action result
 * unions — no `code` is added, so those unions stay exactly as they were.
 */
export function deadlockFailure(
  error: unknown,
  logMessage: string,
  context: Record<string, unknown>
): { success: false; error: string } | null {
  if (!isDeadlockDetected(error)) return null;
  const detail = deadlockDetail(error);
  log.warn(logMessage, {
    ...context,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
    ...(detail === undefined ? {} : { detail }),
  });
  return { success: false, error: CONCURRENT_RETRY_MESSAGE };
}

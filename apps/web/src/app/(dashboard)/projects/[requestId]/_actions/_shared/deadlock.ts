import 'server-only';

import { log } from '@/lib/logging';

/**
 * True when `error` is a Postgres DEADLOCK DETECTED (SQLSTATE 40P01).
 *
 * BAL-540 fix round. The close / decline cascades lock BOTH open proposal statuses
 * (`draft` and `submitted`) on their way to the relationship row, which bridges the two
 * previously-disjoint proposal worlds that `proposalsRepository.accept` (proposal →
 * relationship → request) and `promoteToSubmit` (relationship → request → proposal) each
 * live in. That completed an AB/BA cycle: the cascade holds a `draft` proposal and waits on
 * the relationship; `promoteToSubmit` holds that relationship and waits on the same draft.
 * Postgres detects it after `deadlock_timeout` (1s by default) and aborts ONE side with
 * 40P01. See the LOCK ORDER block on `projectRequestsRepository.close` for the full analysis.
 *
 * ⚠ fix round F5 — THE FOLLOW-UP TICKET HAS LANDED. This docblock used to point at "the
 * follow-up ticket that serialises the five writers properly" as future work; that ticket is
 * BAL-546 (this change), and the serialised set it landed is ELEVEN writers, not five — see
 * `packages/db/src/repositories/_shared/request-lock.ts` for the full named list. The
 * per-request advisory lock now makes the AB/BA cycle described above unreachable for every
 * writer in that set; this mapping is kept as a cheap backstop over the strictly smaller
 * residual left by writers outside it (orchestrator D6), not as the primary defence any more.
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
 * True when `error` is a Postgres LOCK NOT AVAILABLE (SQLSTATE 55P03) — a `lock_timeout` expiry.
 *
 * ⚠⚠ fix round F1. `_shared/request-lock.ts`'s `acquireRequestLock` now issues
 * `SET LOCAL lock_timeout = '3s'` immediately before taking the per-request advisory lock, so a
 * transaction that has queued behind another writer's held lock for longer than that gives up
 * with 55P03 instead of waiting indefinitely — the fix for the MEDIUM availability finding that
 * the un-rate-limited proposal-autosave path (`createDraft`) could otherwise pin a pooled
 * connection for the holder's entire cascade. Same shape as {@link isDeadlockDetected}: like a
 * deadlock abort, a lock-timeout abort wrote nothing and is EXPECTED-RARE and SELF-HEALING — the
 * holder is still running (or has already committed) and a retry queues again, so it is mapped
 * to the identical retryable outcome in {@link deadlockFailure} below.
 */
export function isLockNotAvailable(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  return 'code' in error && error.code === '55P03';
}

/**
 * pending-MJ. The RETRYABLE copy every BAL-540 close / decline action returns on a 40P01 or (fix
 * round F1) a 55P03, deliberately distinct from each action's generic failure string: neither
 * abort wrote anything, and the winning/holding transaction has already committed or will
 * shortly, so trying again really does work. Defined ONCE so the four actions cannot drift apart
 * on the wording.
 */
export const CONCURRENT_RETRY_MESSAGE = 'Something ran at the same moment — please try again.';

/**
 * True when `error` carries a non-empty string `detail`. postgres-js copies the server's
 * `PG_DIAG_MESSAGE_DETAIL` onto the thrown error, and on a 40P01 that field is the ONLY place
 * the useful part lives: "Process 123 waits for ShareLock on transaction 456; blocked by
 * process 789." — i.e. WHICH two of the eleven serialised writers (`_shared/request-lock.ts`)
 * collided. A 55P03 rejection (fix round F1) typically carries no comparable `detail`, so this
 * simply returns `undefined` for it and the caller logs without one. Same structural narrowing
 * shape as {@link isDeadlockDetected}: an `in` guard plus a `typeof`, no `any`, no assertion.
 */
function deadlockDetail(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  if (!('detail' in error)) return undefined;
  const { detail } = error;
  return typeof detail === 'string' && detail.length > 0 ? detail : undefined;
}

/**
 * fix round R8 (SonarCloud S6551, "no-base-to-string") — `String(error)` on a non-`Error`
 * rejection stringified via `Object.prototype.toString` (a bare `'[object Object]'`), silently
 * discarding exactly the `code` field this whole file exists to distinguish. `JSON.stringify`
 * renders the object's own fields instead (`'{"code":"55P03"}'`).
 *
 * `JSON.stringify` cannot render everything, though: it returns the JS value `undefined` (not a
 * string) for `undefined`/a function/a symbol, and THROWS on a circular structure. Rather than
 * fall back to `String(error)` there — reintroducing the exact anti-pattern this function exists
 * to avoid, for no more information than a second `'[object Object]'` — this says plainly that
 * the value couldn't be rendered. Never throws from inside a caught-error boundary either way.
 */
function describeNonErrorRejection(error: unknown): string {
  try {
    const json = JSON.stringify(error);
    if (json !== undefined) return json;
  } catch {
    // Falls through below — e.g. a circular structure JSON.stringify can't walk.
  }
  return '[unserializable error value]';
}

/**
 * The shared tail of {@link deadlockFailure} and {@link lockContentionFailure} (fix round R1/R5)
 * — ONE definition of "log the handled contention error and hand back the retryable failure",
 * so the two entry points cannot drift on shape. `sqlstate` is passed by the caller, which
 * already knows which predicate matched, rather than re-derived here.
 *
 * ⚠ THE ERROR ITSELF IS LOGGED, not just the caller's context. This is a HANDLED boundary —
 * the rejection is converted into a user-facing string and never re-thrown, so without
 * `error` / `stack` here the original is simply lost (CLAUDE.md's caught-error-boundary rule).
 * `detail` rides along when postgres-js supplied one, because on a deadlock it names the two
 * colliding processes and is the difference between "a deadlock happened" and knowing which
 * pair of the eleven writers to serialise first. `sqlstate` rides along too (fix round R5): the
 * four callers of {@link deadlockFailure} used to hardcode "(40P01)" into their log message even
 * though this helper also catches 55P03, mislabelling every real lock timeout as a deadlock in
 * Axiom — the actual SQLSTATE is now a logged field instead, so the message text no longer has
 * to guess which one fired.
 *
 * The returned shape is the bare `{ success: false; error }` common to every action result
 * union this ships into — no `code` is added, so those unions stay exactly as they were.
 */
function logAndBuildRetryFailure(
  error: unknown,
  logMessage: string,
  context: Record<string, unknown>,
  sqlstate: '40P01' | '55P03'
): { success: false; error: string } {
  const detail = deadlockDetail(error);
  log.warn(logMessage, {
    ...context,
    sqlstate,
    error: error instanceof Error ? error.message : describeNonErrorRejection(error),
    stack: error instanceof Error ? error.stack : undefined,
    ...(detail === undefined ? {} : { detail }),
  });
  return { success: false, error: CONCURRENT_RETRY_MESSAGE };
}

/**
 * The whole 40P01 / 55P03 arm of the FOUR original close / decline actions' `catch`, in one
 * place: detect either, `log.warn` (expected-rare and self-healing — never `log.error`), and
 * hand back the retryable failure. Returns `null` when `error` is neither, so the caller falls
 * through to its own arms.
 *
 * ⚠ fix round R1/D6 — STAYS SCOPED TO THESE FOUR CALLERS. The 40P01 arm here predates the
 * per-request advisory lock (BAL-540) and is kept as a cheap backstop over the residual left by
 * writers outside the serialised set (orchestrator D6) — it is deliberately NOT extended to the
 * seven other writers newly reachable by 55P03. Those seven use {@link lockContentionFailure}
 * instead, which maps 55P03 only.
 */
export function deadlockFailure(
  error: unknown,
  logMessage: string,
  context: Record<string, unknown>
): { success: false; error: string } | null {
  if (isDeadlockDetected(error))
    return logAndBuildRetryFailure(error, logMessage, context, '40P01');
  if (isLockNotAvailable(error))
    return logAndBuildRetryFailure(error, logMessage, context, '55P03');
  return null;
}

/**
 * The 55P03-only arm for the SEVEN request-domain action paths that reach the per-request
 * advisory lock (`_shared/request-lock.ts`) but predate — and are NOT — one of the four original
 * BAL-540 close/decline actions (fix round R1).
 *
 * WHY 55P03 ONLY, NOT ALSO 40P01 (unlike {@link deadlockFailure}). SQLSTATE 55P03 is NEW on
 * these seven paths: it did not exist before this ticket added `SET LOCAL lock_timeout` to the
 * advisory-lock gate wait, so before this fix they simply waited, unbounded, with no failure
 * mode to map at all. 40P01, by contrast, was never reachable here and orchestrator D6
 * deliberately did not extend that mapping to writers outside the original four — doing so here
 * would be scope creep with no finding behind it.
 *
 * Same handled-boundary discipline as {@link deadlockFailure}: `log.warn`, never `log.error` —
 * a 55P03 means the transaction wrote nothing (it never got the lock) and a retry queues again.
 */
export function lockContentionFailure(
  error: unknown,
  logMessage: string,
  context: Record<string, unknown>
): { success: false; error: string } | null {
  if (!isLockNotAvailable(error)) return null;
  return logAndBuildRetryFailure(error, logMessage, context, '55P03');
}

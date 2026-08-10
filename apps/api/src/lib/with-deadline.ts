/**
 * `withDeadline` — bound an operation that can hang forever, so a fail-closed catch block is
 * actually REACHABLE.
 *
 * ⚠ WHY THIS EXISTS, PRECISELY. Two routes guard an email-emitting / calendar-blocking write
 * with a Redis fixed-window limiter and a `try/catch` that answers `503` on failure. That
 * catch was DEAD CODE during the exact outage it was written for:
 *
 *   - `getRedis()` sets `maxRetriesPerRequest: null`, which BullMQ REQUIRES (do not change it).
 *   - ioredis only fails pending commands when that option is a NUMBER. Verified in
 *     `ioredis@5.9.3/built/redis/event_handler.js`:
 *         if (typeof maxRetriesPerRequest === 'number') { … self.flushQueue(new MaxRetriesPerRequestError(…)) }
 *     With `null` the branch is skipped entirely.
 *   - `enableOfflineQueue` defaults to `true`, so a command issued while disconnected is
 *     parked in the offline queue instead.
 *
 * Net effect when Redis restarts or goes unreachable: the limiter's promise NEVER SETTLES.
 * The catch never runs, no `503` is ever sent, and every in-flight request hangs holding a
 * Fastify connection until some upstream proxy times it out. The security property survived
 * (nothing is sent, so no unmetered mail went out) but the documented behaviour — "answers
 * 503, never carries on unlimited" — was false, and the availability cost was real.
 *
 * ⚠ A DEADLINE, NOT A CLIENT-LEVEL `commandTimeout`. Setting `commandTimeout` on the shared
 * `getRedis()` singleton would reach every BullMQ producer sharing that connection, and
 * blocking commands are legitimately long-lived. Bounding the CALL SITE keeps the blast
 * radius at the one operation whose caller has a fail-closed answer ready.
 */

/**
 * Thrown when `operation` outlives its deadline. A distinct class so a call site can tell
 * "Redis is unreachable" from "Redis answered an error" if it ever needs to — today both
 * land in the same fail-closed branch, which is the point.
 */
export class DeadlineExceededError extends Error {
  constructor(
    readonly label: string,
    readonly deadlineMs: number
  ) {
    super(`${label} exceeded its ${deadlineMs}ms deadline`);
    this.name = 'DeadlineExceededError';
  }
}

/**
 * Run `operation`, rejecting with {@link DeadlineExceededError} if it has not settled within
 * `deadlineMs`.
 *
 * ⚠ THE ABANDONED PROMISE IS EXPLICITLY HANDLED. When the deadline wins, the underlying
 * operation is still pending and may reject later — with no handler that would surface as an
 * `unhandledRejection`, which on a hardened Node process is a CRASH. Attaching a no-op catch
 * gives it a handler without hiding anything from the race: `Promise.race` subscribed
 * independently and still observes whichever settles first.
 *
 * ⚠ THE TIMER IS ALWAYS CLEARED, and `unref`'d besides, so a pending deadline can neither
 * leak a handle nor hold the event loop open at shutdown.
 *
 * Note this bounds the WAIT, not the work: a command already sent to Redis is not cancelled.
 * That is the correct trade for a fail-closed limiter, where the answer on timeout is
 * "refuse" rather than "retry".
 */
export async function withDeadline<T>(
  operation: () => Promise<T>,
  options: { deadlineMs: number; label: string }
): Promise<T> {
  const { deadlineMs, label } = options;

  const pending = operation();
  // Never lets the race see a different outcome — it only registers a handler so an
  // after-the-fact rejection cannot become an unhandledRejection.
  pending.catch(() => undefined);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new DeadlineExceededError(label, deadlineMs)), deadlineMs);
    timer.unref?.();
  });

  try {
    return await Promise.race([pending, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

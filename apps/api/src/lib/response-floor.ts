/**
 * BAL-442 (RULING 4) — pad a response to a FIXED FLOOR so two branches with very different
 * work cannot be told apart by a stopwatch.
 *
 * ⚠⚠ WHY A FLOOR RATHER THAN A JITTER. A random delay is averaged out by repetition; a fixed
 * floor is not. `claimLobbyPlace`'s `deny(...)` precedent equalises response BODY and STATUS
 * only, never latency — and on the lobby re-entry route a match does a mint + an UPDATE + a
 * BullMQ enqueue while a miss does one SELECT, which is a difference an attacker can measure
 * in a loop.
 *
 * ⚠ THE FLOOR ONLY EQUALISES WHILE IT EXCEEDS THE SLOWEST BRANCH. The match branch is three
 * short queries plus one Redis enqueue; 400ms carries generous headroom. If that stops being
 * true the floor stops equalising SILENTLY — so `join.test.ts` pins both arms against this
 * exact constant rather than against each other, AND {@link withResponseFloor} emits
 * {@link FLOOR_OVERRUN_MESSAGE} on every overrun (fix round R-4). A fake-timer test cannot see
 * production latency; Axiom can.
 *
 * ⚠ IT DELAYS THE RESPONSE, NOT THE WORK. The work is awaited first; the pad is what is left.
 */
import { createLogger } from '@balo/shared/logging';

const log = createLogger('response-floor');

export const LOBBY_REENTRY_RESPONSE_FLOOR_MS = 400;

/**
 * ⚠ EXPORTED SO THE TEST PINS THE VERBATIM LITERAL rather than a `stringContaining` fragment,
 * and so an Axiom query for it cannot drift from what the code emits.
 */
export const FLOOR_OVERRUN_MESSAGE =
  'Response floor overrun — the branches are no longer equalised';

/**
 * Run `work`, then pad the elapsed time up to `floorMs` before resolving.
 *
 * ⚠ `Date.now()` + `setTimeout` are both faked by Vitest's default `vi.useFakeTimers()`
 * (`toFake` includes `Date`), so this is fully deterministic under fake timers — no real sleep
 * in any test.
 *
 * ⚠⚠ THE OVERRUN WARNING (fix round R-4) IS THE ONLY THING THAT MAKES THE SILENT FAILURE
 * ABOVE VISIBLE. When `remaining <= 0` the work already outran the floor, so the pad is zero
 * and the two branches are being distinguished by a stopwatch again — with nothing anywhere
 * reporting it. ⚠⚠ THE LOG CARRIES A **ROUTE LABEL AND TWO DURATIONS, AND NOTHING ELSE** — no
 * email, no token, no meeting id: this primitive is used from an unauthenticated path whose
 * entire purpose is that the caller's input cannot be correlated with anything.
 */
export async function withResponseFloor<T>(
  floorMs: number,
  work: () => Promise<T>,
  /** ⚠ A FIXED ROUTE LABEL, NEVER CALLER INPUT. It is the only identifying field logged. */
  route: string
): Promise<T> {
  const startedAt = Date.now();
  const result = await work();
  const elapsedMs = Date.now() - startedAt;
  const remaining = floorMs - elapsedMs;
  if (remaining > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, remaining));
  } else {
    log.warn({ route, floorMs, elapsedMs }, FLOOR_OVERRUN_MESSAGE);
  }
  return result;
}

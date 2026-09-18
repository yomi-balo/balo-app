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
 * exact constant rather than against each other.
 *
 * ⚠ IT DELAYS THE RESPONSE, NOT THE WORK. The work is awaited first; the pad is what is left.
 */
export const LOBBY_REENTRY_RESPONSE_FLOOR_MS = 400;

/**
 * Run `work`, then pad the elapsed time up to `floorMs` before resolving.
 *
 * ⚠ `Date.now()` + `setTimeout` are both faked by Vitest's default `vi.useFakeTimers()`
 * (`toFake` includes `Date`), so this is fully deterministic under fake timers — no real sleep
 * in any test.
 */
export async function withResponseFloor<T>(floorMs: number, work: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  const result = await work();
  const remaining = floorMs - (Date.now() - startedAt);
  if (remaining > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, remaining));
  }
  return result;
}

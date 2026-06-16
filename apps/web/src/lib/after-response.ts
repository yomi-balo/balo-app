import 'server-only';

import { after } from 'next/server';
import { log } from '@/lib/logging';

/**
 * Run best-effort background work AFTER the response has flushed but BEFORE the
 * serverless function can freeze (Next's `after()`).
 *
 * BAL-279 — one consistent durability story for the two server→server publish
 * hops (the durable notification dispatch and the ephemeral Ably ping). Both were
 * previously fire-and-forget or awaited inconsistently; on Vercel a Server Action
 * can return and the instance freeze before an un-awaited promise settles, so the
 * hop was at-most-once with a high drop rate. `after()` keeps the instance alive
 * until `work` settles, closing that window with zero added response latency.
 *
 * Caveats (why this is the stopgap, not the target): `after()` is best-effort, not
 * crash-durable — a hard kill (OOM / max-duration / eviction) still drops the work,
 * and there is no retry. The target architecture is a transactional outbox drained
 * by a Railway worker (tracked as a follow-up); see BAL-279.
 *
 * Never throws to the caller. `work` is expected to handle its own errors; the
 * guard below is a backstop so a deferred rejection can never become an unhandled
 * rejection. If `after()` is unavailable (called outside a request scope — our
 * callers are all Server Actions / route handlers, so this is purely defensive)
 * the work runs inline, best-effort, rather than being silently dropped.
 */
export function runAfterResponse(label: string, work: () => Promise<void>): void {
  const guarded = async (): Promise<void> => {
    try {
      await work();
    } catch (error) {
      log.error(`Deferred ${label} threw`, {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    }
  };

  try {
    after(guarded);
  } catch (error) {
    log.warn(`after() unavailable — running ${label} inline (best-effort)`, {
      error: error instanceof Error ? error.message : String(error),
    });
    void guarded();
  }
}

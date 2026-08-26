/**
 * BAL-473 — the two request-shaped helpers `routes/daily/webhook.ts` and `routes/mux/webhook.ts`
 * BOTH need, EXTRACTED so the Mux route is not a ~30-line verbatim copy of the Daily one under
 * SonarCloud's >3%-new-code duplication gate. Behaviour is UNCHANGED from what
 * `routes/daily/webhook.ts` did inline before this ticket — `webhook.test.ts` needs no
 * expectation changes.
 */
import type { FastifyReply } from 'fastify';
import type { createLogger } from '@balo/shared/logging';
import { checkRateLimit, RATE_LIMIT_DEADLINE_MS, type RateLimitConfig } from './rate-limiter.js';
import { getRedis } from './redis.js';
import { withDeadline } from './with-deadline.js';

/**
 * BAL-473 FIX ROUND 1 (F1) — run a POST-COMMIT enqueue best-effort. Both webhook routes call
 * BullMQ AFTER their own event has already committed (the marker row, the CAS), so a transient
 * Redis fault here must never become a `500` on a delivery the vendor will otherwise treat as
 * a hard failure and retry. Retrying re-enters `processedAt` short-circuit and does NOTHING —
 * the enqueue this attempt lost is never retried by anybody, and the row it would have advanced
 * sits at its current status forever (no sweep, no reaper).
 *
 * Extracted from `services/meetings/end-meeting.ts`'s `enqueueRecordingStopBestEffort` — the
 * SAME shape, generalised so all six webhook-side enqueues (five `recording-ensure` /
 * `recording-ingest` calls in `routes/daily/webhook.ts`, one `recording-cleanup-source` call in
 * `routes/mux/webhook.ts`) share ONE implementation instead of six copies of the same
 * try/catch, which is also what keeps this under SonarCloud's new-code duplication gate.
 *
 * ⚠ SWALLOWS THE ERROR, DELIBERATELY — the caller has already decided this step must not fail
 * the request; `log.error` is the only signal ops gets, so the context passed in must be enough
 * to find and re-drive the row by hand.
 */
export async function enqueueBestEffort(
  enqueue: () => Promise<void>,
  context: Record<string, unknown>,
  log: ReturnType<typeof createLogger>,
  message: string
): Promise<void> {
  try {
    await enqueue();
  } catch (error) {
    log.error(
      {
        ...context,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      message
    );
  }
}

/** `null` for a body that is not JSON — the caller's Zod boundary then reports the refusal. */
export function decodeJsonBody(rawBody: Buffer): unknown {
  try {
    return JSON.parse(rawBody.toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * Consume one rate-limit token for `ip` against `config`. `true` ⇒ the reply has ALREADY been
 * sent (either `503 rate_limited` or `503 rate_limit_unavailable`) and the caller must return
 * immediately without doing anything else. `false` ⇒ proceed.
 *
 * ⚠ FAILS CLOSED, AND THAT IS SAFE **ONLY BECAUSE BOTH VENDORS RETRY**. A `503` here means
 * "not now, come back" — the delivery is not lost, and the caller's own event-id marker table
 * makes the retry idempotent. Failing OPEN would re-expose the pre-signature hashing cost
 * during precisely the outage an attacker would pick — see `routes/daily/webhook.ts`'s original
 * docblock (BAL-134) for the full argument; this file only extracts the mechanism, not the
 * reasoning, so read it there for "why fail closed at all".
 */
export async function enforceWebhookIpRateLimit(
  config: RateLimitConfig,
  ip: string,
  reply: FastifyReply,
  log: ReturnType<typeof createLogger>
): Promise<boolean> {
  try {
    const result = await withDeadline(() => checkRateLimit(getRedis(), config, ip), {
      deadlineMs: RATE_LIMIT_DEADLINE_MS,
      label: `rate limit ${config.keyPrefix}`,
    });
    if (result.allowed) {
      return false;
    }
    // ⚠ NO `Retry-After` HEADER AND A `503`, NOT A `429` — the vendor's own retry policy
    // governs, and `503` keeps the delivery in its retry queue instead of inviting it to give up.
    log.warn({ ip }, 'Webhook rate-limited — refusing before signature verification');
    reply.code(503).send({ error: 'rate_limited' });
    return true;
  } catch (error) {
    log.error(
      { error: error instanceof Error ? error.message : String(error) },
      'Webhook rate limit unavailable — failing CLOSED (the vendor retries, so no delivery is lost)'
    );
    reply.code(503).send({ error: 'rate_limit_unavailable' });
    return true;
  }
}

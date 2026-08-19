/**
 * BAL-468 §9 — the inbound Apiroc calendar-change webhook.
 *
 * ⚠⚠ THE URL IS ATTACKER-GUESSABLE; THE SIGNATURE IS WHAT AUTHENTICATES. The path names WHICH
 * secret to load, nothing more. Nothing before step 6 (signature verification) may write,
 * enqueue, or track anything (apiroc skill, webhooks-and-events.md A2).
 *
 * ⚠ THE ENQUEUE IS A BARE TRIGGER. No `events.list`, no `syncToken`, no `updatedAfter`, no
 * delta read of any kind — the ping carries no event id, so availability is always
 * recomputed from a windowed free/busy re-read via `vendorBusyProvider.listBusyBlocks`
 * (ADR-1021 amendment 2026-08-15). This route reaches no vendor at all.
 *
 * ⚠ THE BULLMQ LOST-UPDATE WINDOW IS AN EXPLICIT ACCEPT (BAL-468 plan §11), not an oversight.
 * `jobId` coalesces a duplicate only while a job is WAITING; a webhook arriving while a
 * rebuild for that expert is ACTIVE, or in the instant after it read the calendar but before
 * it completed, can be folded into a rebuild that already missed the change. This is accepted
 * because: (1) the 15-minute staleness cron (`jobs/availability-cache.ts`) already backstops
 * it — worst-case staleness is one cron tick, not "until the next calendar change"; (2) the
 * window is narrow (bounded by one `resolveAndCacheAvailability` call) and vendor deliveries
 * themselves coalesce in ~10s batches; (3) the consequence is a stale `earliest_available_at`
 * for ≤15 minutes, never a double-booking — the booking gate re-reads free/busy at accept time
 * and fails closed. Revisit only when the staleness cron is relaxed (a separate, later ticket).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest, FastifyBaseLogger } from 'fastify';
import rawBody from 'fastify-raw-body';
import { Webhook, WebhookVerificationError } from 'svix';
import { z } from 'zod';
import {
  apirocWebhookEventsRepository,
  calendarRepository,
  calendarSubscriptionsRepository,
  db,
  type CalendarSubscription,
} from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import {
  checkRateLimit,
  RATE_LIMIT_DEADLINE_MS,
  type RateLimitConfig,
} from '../../lib/rate-limiter.js';
import { getRedis } from '../../lib/redis.js';
import { withDeadline } from '../../lib/with-deadline.js';
import { decryptCalendarSecret } from '../../lib/calendar-encryption.js';
import { tryEnqueueAvailabilityCacheRebuild } from '../../jobs/availability-cache.js';
import { APIROC_WEBHOOK_ROUTE_PATH } from '../../services/calendar/webhook-url.js';

const log = createLogger('apiroc-webhook-route');

/**
 * The complete verified body [live] — `{ "eventType": "calendar.event.changed", "timestamp":
 * "…" }`. Tolerant (never `.strict()`): the vendor adding a field must not turn every
 * delivery into a 400. There is no account id, no calendar id, no event id, and no
 * subscription id anywhere in the body — identity comes from the path, and only the path.
 */
export const apirocWebhookBodySchema = z.object({
  eventType: z.string().min(1),
  timestamp: z.string().min(1),
});

export function parseApirocWebhookBody(
  value: unknown
): { ok: true; body: z.infer<typeof apirocWebhookBodySchema> } | { ok: false } {
  const parsed = apirocWebhookBodySchema.safeParse(value);
  return parsed.success ? { ok: true, body: parsed.data } : { ok: false };
}

/** Only `calendar.event.changed` has ever been observed. Never switch on this as though the
 *  set were closed — an unknown type is acked (§4) rather than retried forever. */
const KNOWN_EVENT_TYPE = 'calendar.event.changed';

const calendarSubscriptionIdParamSchema = z.object({ calendarSubscriptionId: z.string().uuid() });

/**
 * ⚠ WHAT THIS PROTECTS IS CPU AND A DATABASE ROUND TRIP, NOT DATA. An attacker needs no
 * secret to make this server do an indexed read plus an HMAC over up to Fastify's 1MB body
 * limit. The entire platform's traffic arrives from Svix's small egress set and therefore
 * shares ONE bucket. `503`, never `429`, and no `Retry-After` — the vendor's retry policy is
 * its own, and 503 is the status this route already uses for "our side is not ready".
 */
const APIROC_WEBHOOK_IP_RATE_LIMIT: RateLimitConfig = {
  keyPrefix: 'ratelimit:apiroc-webhook:ip',
  maxRequests: 100_000,
  windowSeconds: 3600,
};

function headerString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

/** Consume one token. `true` ⇒ the reply has ALREADY been sent. Fails CLOSED — safe only
 *  because the sender retries, and the marker table makes the retry idempotent. */
async function enforceWebhookRateLimit(ip: string, reply: FastifyReply): Promise<boolean> {
  try {
    const result = await withDeadline(
      () => checkRateLimit(getRedis(), APIROC_WEBHOOK_IP_RATE_LIMIT, ip),
      {
        deadlineMs: RATE_LIMIT_DEADLINE_MS,
        label: `rate limit ${APIROC_WEBHOOK_IP_RATE_LIMIT.keyPrefix}`,
      }
    );
    if (result.allowed) return false;
    log.warn({ ip }, 'apiroc_webhook_rate_limited');
    reply.code(503).send({ error: 'rate_limited' });
    return true;
  } catch (error: unknown) {
    log.error(
      { error: error instanceof Error ? error.message : String(error) },
      'apiroc_webhook_rate_limit_unavailable'
    );
    reply.code(503).send({ error: 'rate_limit_unavailable' });
    return true;
  }
}

type VerifiedWebhook =
  | { ok: true; calendarSubscriptionId: string; row: CalendarSubscription; eventType: string }
  | { ok: false };

/**
 * Steps 2–7: resolve the path param, load the LIVE subscription row, decrypt its secret, and
 * verify the raw bytes against it. Nothing in here writes, enqueues, or tracks anything — see
 * the module doc's "nothing before step 6" invariant. On any failure the reply has ALREADY been
 * sent and the caller must return immediately.
 */
async function verifyApirocWebhookRequest(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<VerifiedWebhook> {
  // ── Step 2 — the path param must be a well-formed uuid ─────────────────────────────────
  const paramsParsed = calendarSubscriptionIdParamSchema.safeParse(request.params);
  if (!paramsParsed.success) {
    log.warn({ params: request.params }, 'apiroc_webhook_subscription_not_found');
    reply.code(404).send({ error: 'not_found' });
    return { ok: false };
  }
  const { calendarSubscriptionId } = paramsParsed.data;

  // ── Step 3 — the raw body must have been captured as a Buffer ──────────────────────────
  const rawBodyBuffer = request.rawBody;
  if (!Buffer.isBuffer(rawBodyBuffer)) {
    log.warn(
      { calendarSubscriptionId, reason: 'missing_raw_body' },
      'apiroc_webhook_signature_invalid'
    );
    reply.code(400).send({ error: 'invalid signature' });
    return { ok: false };
  }

  // ── Step 4 — the subscription row must resolve to a LIVE row ───────────────────────────
  const row = await calendarSubscriptionsRepository.findLiveById(calendarSubscriptionId);
  if (row === undefined) {
    log.warn({ calendarSubscriptionId }, 'apiroc_webhook_subscription_not_found');
    reply.code(404).send({ error: 'not_found' });
    return { ok: false };
  }

  // ── Step 5 — load the secret. Nothing above this line has proven anything. ──────────────
  let secret: string;
  try {
    secret = decryptCalendarSecret(row.endpointSecret);
  } catch (err: unknown) {
    log.error(
      { calendarSubscriptionId, error: err instanceof Error ? err.message : String(err) },
      'apiroc_webhook_secret_undecryptable'
    );
    reply.code(503).send({ error: 'webhook_not_configured' });
    return { ok: false };
  }

  // ── Step 6 — verify over the RAW BYTES. NOTHING ABOVE THIS LINE HAS WRITTEN, ENQUEUED, ──
  // ── OR TRACKED ANYTHING. A forged POST to a guessed URL fails here with zero side effects.
  // ⚠ `new Webhook(secret)` can itself throw (a malformed stored secret) — kept INSIDE the
  // try so that case answers 400, never an uncaught 500.
  let verifiedBody: unknown;
  try {
    const wh = new Webhook(secret);
    verifiedBody = wh.verify(rawBodyBuffer, {
      'svix-id': headerString(request.headers['svix-id']),
      'svix-timestamp': headerString(request.headers['svix-timestamp']),
      'svix-signature': headerString(request.headers['svix-signature']),
    });
  } catch (err: unknown) {
    // ⚠⚠ CLASSIFY, DO NOT COLLAPSE. `wh.verify` ends with `JSON.parse(payload)`, so a body
    // whose SIGNATURE IS GENUINE but whose bytes are not JSON throws a `SyntaxError` from
    // inside this same try. Reporting that as `apiroc_webhook_signature_invalid` poisons the
    // one signal that says someone is probing forged webhooks: a vendor body change would
    // flood it with false positives, and a real forgery campaign would then be dismissed as
    // "the vendor changed its shape again". The WIRE answer is deliberately identical either
    // way (400, one literal) so no oracle is created — only the log line distinguishes them.
    const reason = err instanceof Error ? err.message : String(err);
    if (!(err instanceof WebhookVerificationError)) {
      log.warn({ calendarSubscriptionId, reason }, 'apiroc_webhook_payload_invalid');
      reply.code(400).send({ error: 'invalid_payload' });
      return { ok: false };
    }
    log.warn({ calendarSubscriptionId, reason }, 'apiroc_webhook_signature_invalid');
    reply.code(400).send({ error: 'invalid signature' });
    return { ok: false };
  }

  // ── Step 7 — a verified body proves ORIGIN, not SHAPE ───────────────────────────────────
  const parsedBody = parseApirocWebhookBody(verifiedBody);
  if (!parsedBody.ok) {
    log.warn(
      { calendarSubscriptionId, reason: 'shape_mismatch' },
      'apiroc_webhook_payload_invalid'
    );
    reply.code(400).send({ error: 'invalid_payload' });
    return { ok: false };
  }

  return { ok: true, calendarSubscriptionId, row, eventType: parsedBody.body.eventType };
}

/**
 * Steps 9–13: replay short-circuit, marker insert, unknown-event ack, availability rebuild
 * enqueue, and liveness stamping. Only reached once `verifyApirocWebhookRequest` returned `ok`.
 */
async function processVerifiedApirocWebhook(
  verified: { calendarSubscriptionId: string; row: CalendarSubscription; eventType: string },
  svixId: string,
  requestLog: FastifyBaseLogger,
  reply: FastifyReply
): Promise<void> {
  const { calendarSubscriptionId, row, eventType } = verified;

  // ── Step 9 — replay short-circuit, branching on `processedAt`, NOT presence ─────────────
  const existingMarker = await apirocWebhookEventsRepository.findBySvixId(svixId);
  if (existingMarker?.processedAt) {
    log.info({ svixId, calendarSubscriptionId }, 'apiroc_webhook_replay');
    reply.code(200).send({ received: true });
    return;
  }

  // ── Step 10 — insert the marker. ───────────────────────────────────────────────────────
  //
  // `undefined` means the id was already recorded: either a concurrent delivery won the unique
  // index, or a PRIOR delivery inserted the marker and then died before committing its effect.
  // We CONTINUE in both cases, and that is deliberate — the second case still owes its effect,
  // and the replay short-circuit above has already returned 200 for anything with
  // `processed_at` set, so a row reaching here is by construction unprocessed.
  //
  // ⚠⚠ THE RESULT IS CAPTURED AND LOGGED RATHER THAN DISCARDED, BECAUSE THIS IS "THE REAL
  // CONCURRENCY GATE" (see `insertReceived`'s repository docblock) AND A GATE NOBODY READS IS
  // NOT A GATE (PR #223 review). Two simultaneous deliveries of one `svix-id` both proceed
  // here. That is HARMLESS TODAY and only today: the sole effect is
  // `tryEnqueueAvailabilityCacheRebuild`, which is idempotent and coalesced on the per-expert
  // `availability-${expertProfileId}` jobId, so the duplicate collapses by construction.
  //
  // ⚠⚠ THE MOMENT THIS HANDLER GROWS A SECOND, NON-IDEMPOTENT EFFECT — a counter, an audit
  // row, a notification, an analytics fire — IT MUST BRANCH HERE AND RETURN 200 ON
  // `undefined`, the way `routes/daily/webhook.ts` does for its presence writes. Do not add
  // that effect and leave this call site unchanged.
  const marker = await apirocWebhookEventsRepository.insertReceived(
    { svixId, calendarSubscriptionId, eventType },
    db
  );
  const wonInsertRace = marker !== undefined;

  // ── Step 8 — unknown eventType: marker + log + 200, no enqueue. Never switch on eventType
  // as though the set were closed.
  if (eventType !== KNOWN_EVENT_TYPE) {
    log.info({ calendarSubscriptionId, eventType }, 'apiroc_webhook_unknown_event_type');
    await apirocWebhookEventsRepository.markProcessed(svixId, db);
    reply.code(200).send({ received: true });
    return;
  }

  // ── Step 11 — resolve expertProfileId via connection_id, ONE hop, deterministic ─────────
  const connection = await calendarRepository.findConnectionById(row.connectionId);
  const expertProfileId = connection?.expertProfileId;
  if (expertProfileId === undefined) {
    // ⚠ ITS OWN MARKER, NOT THE SUCCESS ONE. This fires when a LIVE subscription row points
    // at a connection that is soft-deleted or gone — i.e. a partially-failed
    // `disconnectProvider` where `softDeleteByConnectionId` did not run before
    // `softDeleteConnectionForProvider`. That is precisely the "still accepting verified
    // deliveries for an expert who unhooked their calendar" state, and under the success
    // marker it is indistinguishable from a healthy rebuild in the logs.
    //
    // ⚠ AND IT IS A `404`, NOT A `503`. A soft-deleted connection is PERMANENTLY wrong, not a
    // transient outage: answering 503 tells Svix to retry for ~5 days before disabling the
    // endpoint, spending the vendor's retry budget on a condition no retry can fix.
    log.error(
      { calendarSubscriptionId, connectionId: row.connectionId },
      'apiroc_webhook_connection_missing'
    );
    reply.code(404).send({ error: 'not_found' });
    return;
  }

  const enqueued = await tryEnqueueAvailabilityCacheRebuild(expertProfileId, requestLog);
  if (!enqueued) {
    log.error({ expertProfileId, svixId }, 'apiroc_webhook_enqueue_failed');
    reply.code(503).send({ error: 'enqueue_failed' });
    return;
  }

  // ── Step 12/13 — stamp liveness, mark processed ─────────────────────────────────────────
  await calendarSubscriptionsRepository.stampDelivery(row.id, new Date());
  await apirocWebhookEventsRepository.markProcessed(svixId, db);

  log.info(
    { svixId, calendarSubscriptionId, expertProfileId, eventType, wonInsertRace },
    'apiroc_webhook_processed'
  );
  reply.code(200).send({ received: true });
}

/** The handler only — exported so a test can register it against a bare Fastify if it wants. */
export async function apirocWebhookRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post(APIROC_WEBHOOK_ROUTE_PATH, { config: { rawBody: true } }, async (request, reply) => {
    // ── Step 1 — the per-IP bucket, BEFORE any hashing or DB work ──────────────────────────
    if (await enforceWebhookRateLimit(request.ip, reply)) return;

    const verified = await verifyApirocWebhookRequest(request, reply);
    if (!verified.ok) return;

    const svixId = headerString(request.headers['svix-id']);
    await processVerifiedApirocWebhook(verified, svixId, request.log, reply);
  });
}

/**
 * The scoped wrapper: raw-body capture + the handler. THIS is what `routes/calendar/index.ts`
 * registers.
 *
 * ⚠⚠ NOT STYLISTIC — an encapsulation boundary. `fastify-raw-body` is wrapped in
 * `fastify-plugin`, so it applies to the CONTEXT that registered it; registering it directly
 * inside `calendarRoutes` would change body parsing for `calendarAuthRoutes` and
 * `calendarApiRoutes` too. Exactly the shape `routes/daily/index.ts` + `routes/daily/webhook.ts`
 * already ship.
 */
export async function apirocWebhookPlugin(fastify: FastifyInstance): Promise<void> {
  await fastify.register(rawBody, {
    field: 'rawBody',
    global: false, // a GLOBAL registration corrupts JSON parsing on every other route
    encoding: false, // yields a Buffer — load-bearing, not a detail
    runFirst: true, // capture before any other content-type parser sees it
    routes: [APIROC_WEBHOOK_ROUTE_PATH],
  });

  /**
   * ⚠⚠ THIS PLUGIN OWNS ITS OWN `application/json` PARSING, AND THAT IS A CORRECTNESS FIX,
   * NOT A MICRO-OPTIMISATION.
   *
   * Without it, Fastify's built-in JSON parser runs on the vendor's body BEFORE this route's
   * handler is entered. A body that is not valid JSON therefore never reaches the handler's
   * classification branch: the parser throws, `app.ts`'s catch-all error handler converts it
   * to `500 { error: 'Internal Server Error' }` AND fires `Sentry.captureException` — so a
   * vendor body-format change produces a Sentry event PER DELIVERY ATTEMPT, Svix walks its
   * full backoff (immediately → 5s → … → 10h) and DISABLES THE ENDPOINT after ~5 days. That
   * is precisely the outcome §9.4's `400 invalid_payload` row exists to prevent, and it is
   * the difference between "one expert's change-push is briefly noisy" and "every expert's
   * change-push is dead and nobody noticed".
   *
   * Handing the raw Buffer straight through also removes a double parse: the signature is
   * verified over the raw bytes, and `wh.verify` returns the parsed object we then hand to
   * the zod boundary — Fastify's own parse was never used for anything.
   *
   * ⚠ SAFE BECAUSE IT IS SCOPED. This runs inside `apirocWebhookPlugin`'s encapsulation
   * context, exactly like the `rawBody` registration above, so `calendarAuthRoutes` and
   * `calendarApiRoutes` keep Fastify's normal JSON parsing.
   */
  // ⚠ REMOVE BEFORE ADD — Fastify throws `Content type parser 'application/json' already
  // present.` otherwise. Both calls are encapsulated to this plugin's context, so the parser
  // Fastify installed globally is untouched everywhere else.
  fastify.removeContentTypeParser('application/json');
  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (_request, body, done) => {
      done(null, body);
    }
  );

  await fastify.register(apirocWebhookRoutes);
}

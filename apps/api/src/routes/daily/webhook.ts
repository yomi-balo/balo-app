/**
 * BAL-134 (§5.1) — `POST /webhooks/daily`. The single idempotent Daily webhook endpoint, and
 * leg 1 of D1's presence model.
 *
 * Modelled step for step on `routes/stripe/webhook.ts`, which is the shipped precedent for an
 * idempotent signed webhook in this codebase:
 *
 *   1. `DAILY_WEBHOOK_SECRET` unset → `log.error` + **`503`**. ⚠ NEVER process an unverified
 *      body. A missing secret is an OUTAGE (our configuration), not a bad request.
 *   2. Signature fails → `log.warn` (the REASON as a field, NEVER the body) + **`400`**. A
 *      `400` tells Daily not to retry a body that will never verify.
 *   3. Parse with the Zod boundary. Unknown/unhandled type → record the marker, `200`.
 *   4. Fast replay short-circuit on a fully-processed event id — no transaction, no effect.
 *   5. ONE `db.transaction`: `insertReceived` → apply the effect → `markProcessed`.
 *   6. POST-COMMIT: the status transitions and analytics (never inside the transaction —
 *      enqueuing to BullMQ or PostHog must not be undone by a rollback).
 *   7. `200 { received: true }`.
 *
 * ── ⚠⚠ WHY THE MARKER TABLE EXISTS AT ALL (D2) ──────────────────────────────────────────
 *
 * The presence primitives are ALREADY partly idempotent: `open()` is `ON CONFLICT DO NOTHING`
 * on the one-open-per-identity partial unique, and `close()` is a first-close-wins
 * compare-and-set. That covers a DUPLICATE delivery of a live event. It does **not** cover a
 * **REPLAYED `participant.joined` AFTER THE INTERVAL HAS LEGITIMATELY CLOSED**: the unique
 * index only constrains OPEN intervals, so the replay inserts a SECOND interval anchored at the
 * old `joined_at` with no `left_at` — an open interval in the past, i.e. a silent, unbounded
 * over-bill on a money path. `daily_webhook_events` closes that for every event type at once.
 *
 * ── ⚠ ROOM → MEETING IS A DATABASE LOOKUP, NEVER A PARSE ────────────────────────────────
 *
 * The room name is a pure function of `meetings.id`, but there is NO reverse parser in this
 * repo and this ticket does not add one: `findByDailyRoomName` is authoritative, rides
 * `meeting_daily_room_name_idx`, and — unlike a parser — cannot resolve a name to a meeting
 * that does not exist. An unknown or soft-deleted room records its marker, logs, and acks.
 */
import {
  db,
  dailyWebhookEventsRepository,
  meetingPresenceRepository,
  meetingsRepository,
  type Meeting,
} from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  checkRateLimit,
  RATE_LIMIT_DEADLINE_MS,
  type RateLimitConfig,
} from '../../lib/rate-limiter.js';
import { getRedis } from '../../lib/redis.js';
import { withDeadline } from '../../lib/with-deadline.js';
import {
  parseDailyWebhookEvent,
  type DailyWebhookEvent,
} from '../../services/daily/webhook-events.js';
import { verifyDailyWebhookSignature } from '../../services/daily/webhook-signature.js';
import {
  applyPresenceEffect,
  reconcileMeetingStatus,
  resolvePresenceEffect,
  type PresenceEffect,
  type PresenceExecutor,
} from '../../services/meetings/presence-writer.js';

const log = createLogger('daily-webhook-route');

/** Reject a room name that is not one of ours BEFORE spending a database round trip on it. */
const BALO_ROOM_NAME_PATTERN = /^balo-[0-9a-f]{32}$/;

/**
 * The work one verified delivery implies. `meeting` is resolved OUTSIDE the transaction so the
 * transaction stays short — the `resolveStripeEffect` shape.
 */
interface DailyWebhookEffect {
  /**
   * ⚠ `unhandled` IS EXCLUDED **BY TYPE**, not by a comment. `resolveEffect` answers `null` for
   * it, and narrowing here is what makes that guarantee checkable: `applyEffect` cannot be
   * written to read a field an unhandled event does not carry, and a future arm that forgets
   * the filter is a compile error rather than a runtime `undefined` reaching a presence write.
   */
  readonly event: Exclude<DailyWebhookEvent, { readonly kind: 'unhandled' }>;
  readonly meeting: Meeting;
  /**
   * The presence observation, ALREADY RESOLVED. `null` for `meeting.ended`, which closes every
   * interval at once and needs no identity.
   *
   * ⚠ RESOLVED HERE RATHER THAN INSIDE THE TRANSACTION, because `presence-writer.ts`'s own
   * contract says so in as many words: "phase 1 is READS ONLY, OUTSIDE the transaction". It is
   * not a style rule — resolving a party runs the participation gate plus a delivery-identity
   * read (four to six queries), and doing that while holding an open transaction lengthens
   * every webhook's lock window on `meeting_presence` for work that writes nothing.
   */
  readonly presence: PresenceEffect | null;
}

/**
 * Resolve the delivery's meeting, or `null` when there is nothing to apply.
 *
 * ⚠ `null` IS NOT A FAILURE ON ANY OF ITS THREE PATHS — an unhandled event type, a room name
 * that is not ours (Daily domains can host rooms this platform did not create), and a room
 * whose meeting is gone or soft-deleted. All three record their marker and ack.
 */
async function resolveEffect(event: DailyWebhookEvent): Promise<DailyWebhookEffect | null> {
  if (event.kind === 'unhandled' || event.roomName === null) {
    return null;
  }
  if (!BALO_ROOM_NAME_PATTERN.test(event.roomName)) {
    return null;
  }
  const meeting = await meetingsRepository.findByDailyRoomName(event.roomName);
  if (meeting === undefined) {
    log.warn(
      { roomName: event.roomName, eventType: event.type },
      'Daily webhook named a room with no live meeting — acking with no effect'
    );
    return null;
  }

  if (event.kind === 'meeting.ended') {
    return { event, meeting, presence: null };
  }

  // PHASE 1 — reads only, OUTSIDE the transaction. See `DailyWebhookEffect.presence`.
  const presence = await resolvePresenceEffect({
    action: event.kind === 'participant.joined' ? 'open' : 'close',
    meeting,
    participantId: event.participantId,
    at: event.occurredAt,
  });
  return { event, meeting, presence };
}

/**
 * Apply one effect on the webhook's own transaction.
 *
 * ⚠ `meeting.ended` CLOSES EVERY OPEN INTERVAL BUT DOES **NOT** END THE MEETING. A Daily
 * SESSION ends whenever the room empties — including on a network blip that drops every
 * participant for four seconds — so treating it as a termination would end live consultations.
 * What it genuinely buys is the DROPPED-`participant.left` repair in under a second instead of
 * waiting for a sweep tick; deciding the meeting is over stays the sweep's, under the idle-end
 * rule, which requires the room to have been empty for a whole window.
 *
 * ⚠⚠ AND ITS TIMESTAMP IS GUARDED HERE, BECAUSE IT IS THE ONE ARM WITHOUT A CATCH BEHIND IT.
 * The join/leave arms funnel through `applyPresenceEffect`, which ANSWERS `invalid_timestamp`
 * rather than throwing (edge case 22). `closeAllOpen` has no such courtesy: it reaches
 * `assertFiniteInstant` and THROWS — and `parseDailyWebhookEvent` deliberately returns an
 * INVALID DATE (not `null`) for a present-but-unparseable `end_ts`, so this is reachable from a
 * body Daily will happily keep sending. A throw here escapes `db.transaction`, ROLLS BACK the
 * `daily_webhook_events` marker and 500s, so Daily retries a permanently-unwritable body
 * forever and eventually DISABLES THE WEBHOOK — silently degrading presence, a money input, to
 * ≤60s sweep reconciliation. So: log it, write nothing, let the marker commit, and ack.
 */
async function applyEffect(exec: PresenceExecutor, effect: DailyWebhookEffect): Promise<void> {
  const { event, meeting, presence } = effect;

  if (event.kind === 'meeting.ended') {
    if (!Number.isFinite(event.occurredAt.getTime())) {
      log.error(
        { meetingId: meeting.id, eventId: event.eventId, outcome: 'invalid_timestamp' },
        'Daily `meeting.ended` carried a non-finite timestamp — refusing the close and acking so the vendor stops retrying'
      );
      return;
    }
    const closed = await meetingPresenceRepository.closeAllOpen(meeting.id, event.occurredAt, exec);
    log.info(
      { meetingId: meeting.id, closedIntervals: closed, trigger: 'meeting.ended' },
      'Daily session ended — closed every open presence interval'
    );
    return;
  }

  if (presence !== null) {
    await applyPresenceEffect(exec, presence);
  }
}

/** `null` for a body that is not JSON — the Zod boundary then reports `malformed_envelope`. */
function decodeBody(rawBody: Buffer): unknown {
  try {
    return JSON.parse(rawBody.toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * PER-IP VOLUME CONTROL ON THE ONE UNAUTHENTICATED WRITE PATH IN THIS FEATURE.
 *
 * ⚠ WHAT IT PROTECTS IS CPU, NOT DATA. Signature verification is the FIRST thing that touches a
 * body, and it computes an HMAC-SHA256 over the whole raw payload — up to Fastify's 1 MB body
 * limit. An attacker needs no secret and no valid signature to make this server do that work;
 * they only need a fresh timestamp, and every request is a rejected `400` that cost a megabyte
 * of hashing. The window is consumed BEFORE the HMAC for exactly that reason.
 *
 * ⚠ SIZED WELL ABOVE DAILY'S REAL DELIVERY RATE, and it has to be: every delivery arrives from
 * the vendor's small set of egress addresses, so the ENTIRE platform's webhook traffic shares
 * one bucket. Three events per participant per meeting at 20 000/hour leaves room for roughly a
 * thousand concurrent consultations from a single Daily IP, while still capping a flood at
 * ~5.5 requests/second.
 *
 * ⚠ FAILS CLOSED (`503`), AND THAT IS SAFE **ONLY BECAUSE DAILY RETRIES**. A `503` is the same
 * answer an unset secret gets and it means "not now, come back" — the delivery is not lost, and
 * the `daily_webhook_events` marker makes the retry idempotent. Failing OPEN would re-expose
 * the hashing cost during precisely the outage an attacker would pick.
 */
const DAILY_WEBHOOK_IP_RATE_LIMIT: RateLimitConfig = {
  keyPrefix: 'ratelimit:daily-webhook:ip',
  maxRequests: 20_000,
  windowSeconds: 3600,
};

/** Consume one token. `true` ⇒ the reply has ALREADY been sent. */
async function enforceWebhookRateLimit(ip: string, reply: FastifyReply): Promise<boolean> {
  try {
    const result = await withDeadline(
      () => checkRateLimit(getRedis(), DAILY_WEBHOOK_IP_RATE_LIMIT, ip),
      {
        deadlineMs: RATE_LIMIT_DEADLINE_MS,
        label: `rate limit ${DAILY_WEBHOOK_IP_RATE_LIMIT.keyPrefix}`,
      }
    );
    if (result.allowed) {
      return false;
    }
    // ⚠ NO `Retry-After` HEADER AND A `503`, NOT A `429`. Daily's retry policy is its own; a
    // `503` is the status this route already uses for "our side is not ready", and it keeps the
    // delivery in the vendor's retry queue instead of inviting it to give up.
    log.warn({ ip }, 'Daily webhook rate-limited — refusing before signature verification');
    reply.code(503).send({ error: 'rate_limited' });
    return true;
  } catch (error) {
    log.error(
      { error: error instanceof Error ? error.message : String(error) },
      'Daily webhook rate limit unavailable — failing CLOSED (Daily retries, so no delivery is lost)'
    );
    reply.code(503).send({ error: 'rate_limit_unavailable' });
    return true;
  }
}

export async function dailyWebhookRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post('/webhooks/daily', { config: { rawBody: true } }, async (request, reply) => {
    // ⚠ FIRST, BEFORE THE HMAC. See {@link DAILY_WEBHOOK_IP_RATE_LIMIT}.
    if (await enforceWebhookRateLimit(request.ip, reply)) return;

    const secret = process.env.DAILY_WEBHOOK_SECRET;
    if (!secret) {
      // ⚠ AN OUTAGE, NOT A BAD REQUEST. Answering 400 here would tell Daily to stop retrying
      // deliveries that are perfectly valid and that we will be able to process the moment the
      // variable is set.
      log.error({}, 'DAILY_WEBHOOK_SECRET is not set — refusing to process an unverified body');
      return reply.code(503).send({ error: 'webhook_not_configured' });
    }

    const rawBody = request.rawBody;
    if (!Buffer.isBuffer(rawBody)) {
      log.warn({ reason: 'missing_raw_body' }, 'Daily webhook rejected');
      return reply.code(400).send({ error: 'invalid signature' });
    }

    const verified = verifyDailyWebhookSignature(rawBody, request.headers, secret, new Date());
    if (!verified.ok) {
      // ⚠ THE REASON AS A FIELD, NEVER THE BODY. The wire gets one literal — a caller who
      // learns "stale timestamp" vs "bad signature" learns how to iterate.
      log.warn({ reason: verified.reason }, 'Daily webhook signature verification failed');
      return reply.code(400).send({ error: 'invalid signature' });
    }

    const receivedAt = new Date();
    // ⚠ THE JSON PARSE IS GUARDED EVEN THOUGH THE SIGNATURE ALREADY PASSED. A verified body is
    // proof of ORIGIN, not of SHAPE — and an uncaught `SyntaxError` here would reach the app
    // error handler as a `500`, which tells Daily to RETRY a body that can never parse.
    const parsed = parseDailyWebhookEvent(decodeBody(rawBody), receivedAt);
    if (!parsed.ok) {
      log.warn({ reason: parsed.reason }, 'Daily webhook payload could not be parsed');
      return reply.code(400).send({ error: 'invalid_payload' });
    }
    const { event } = parsed;

    // Fast idempotent short-circuit on a fully-processed replay (no txn, no reads).
    // ⚠ BRANCH ON `processedAt`, NOT ON PRESENCE — a row with a NULL stamp is a delivery that
    // died before committing its effect, and the retry exists to repair it.
    const seen = await dailyWebhookEventsRepository.findByEventId(event.eventId);
    if (seen?.processedAt) {
      log.info(
        { eventId: event.eventId, eventType: event.type },
        'Daily webhook replay — already processed, acking'
      );
      return reply.code(200).send({ received: true });
    }

    const effect = await resolveEffect(event);

    await db.transaction(async (tx) => {
      const marker = await dailyWebhookEventsRepository.insertReceived(
        { eventId: event.eventId, type: event.type, roomName: event.roomName },
        tx
      );
      if (marker === undefined) {
        // ⚠ A CONCURRENT DELIVERY WON THE UNIQUE INDEX. The other transaction either already
        // applied the effect or is about to; applying it twice is the double-interval over-bill
        // D2 exists to prevent.
        return;
      }
      if (effect !== null) {
        await applyEffect(tx, effect);
      }
      await dailyWebhookEventsRepository.markProcessed(event.eventId, tx);
    });

    // POST-COMMIT. ⚠ NEVER INSIDE THE TRANSACTION: `reconcileMeetingStatus` emits analytics and
    // touches the scheduled-notification cancel path, neither of which a rollback can undo.
    if (effect !== null && effect.event.kind !== 'meeting.ended') {
      await reconcileMeetingStatus(effect.meeting, receivedAt);
    }

    log.info(
      { eventId: event.eventId, eventType: event.type, handled: effect !== null },
      'Daily webhook processed'
    );
    return reply.code(200).send({ received: true });
  });
}

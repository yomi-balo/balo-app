/**
 * BAL-473 (§8) — `POST /webhooks/mux`. The Mux half of the recording pipeline: `video.asset.ready`
 * publishes a segment (T8), `video.asset.errored` fails it (T9).
 *
 * The handler ladder is IDENTICAL IN SHAPE to `routes/daily/webhook.ts` — same seven steps, the
 * two shared helpers (`decodeJsonBody`, `enforceWebhookIpRateLimit`) extracted to
 * `lib/webhook-request.ts` for exactly that reason. See that route's docblock for the full
 * argument on why each step is where it is; this one states only where Mux DIFFERS:
 *
 *   |                  | Daily                              | Mux                                    |
 *   | ---------------- | ----------------------------------- | --------------------------------------- |
 *   | Effect resolution| room name → meeting                 | `passthrough` → row, `mux_asset_id` fallback |
 *   | Room-name gate   | `BALO_ROOM_NAME_PATTERN`            | none — no room in a Mux payload         |
 *   | Rate budget      | 20,000/hr (Daily's real volume)     | 2,000/hr — Mux's volume is ~4 events per recording |
 *   | Marker context   | `room_name`                         | `passthrough`                           |
 *
 * ⚠ `video.asset.ready` refuses to transition when the asset carries no SIGNED playback id
 * (`data.playback_ids` has no `policy: 'signed'` entry) — a configuration bug this platform
 * must see, not a row to half-stamp. The marker still commits and the delivery still acks.
 */
import {
  db,
  meetingsRepository,
  meetingRecordingsRepository,
  muxWebhookEventsRepository,
  type Meeting,
  type MeetingRecording,
} from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import { trackServer, RECORDING_SERVER_EVENTS } from '@balo/analytics/server';
import type { FastifyInstance } from 'fastify';
import {
  decodeJsonBody,
  enforceWebhookIpRateLimit,
  enqueueBestEffort,
} from '../../lib/webhook-request.js';
import { type RateLimitConfig } from '../../lib/rate-limiter.js';
import { parseMuxWebhookEvent, type MuxWebhookEvent } from '../../services/mux/webhook-events.js';
import { verifyMuxWebhookSignature } from '../../services/mux/webhook-signature.js';
import { enqueueRecordingCleanupSource } from '../../jobs/recording-cleanup-source.js';
import { sanitizedErrorMessage } from '../../lib/sanitize-error.js';

const log = createLogger('mux-webhook-route');

/**
 * ⚠ MUX'S OWN VOLUME, NOT DAILY'S — ~4 events per recording (started/ready-to-download aside;
 * this endpoint sees `video.asset.ready` / `video.asset.errored` and the occasional unhandled
 * type), never three per participant per meeting. Own `keyPrefix` so the two webhooks' budgets
 * cannot collide or borrow from each other.
 */
const MUX_WEBHOOK_IP_RATE_LIMIT: RateLimitConfig = {
  keyPrefix: 'ratelimit:mux-webhook:ip',
  maxRequests: 2_000,
  windowSeconds: 3600,
};

/** The two handled arms — the ONLY thing `applyEffect` may act on. */
type HandledMuxWebhookEvent = Extract<
  MuxWebhookEvent,
  { readonly kind: 'video.asset.ready' } | { readonly kind: 'video.asset.errored' }
>;

interface MuxWebhookEffect {
  readonly event: HandledMuxWebhookEvent;
  readonly meeting: Meeting;
  readonly recording: MeetingRecording;
}

/**
 * Resolve the live `meeting_recordings` row: `passthrough` → `findById` first (our own id,
 * echoed back on every asset create), falling back to `data.id` → `findByMuxAssetId` when the
 * delivery carries no usable `passthrough`.
 */
async function resolveRecordingRow(
  event: HandledMuxWebhookEvent
): Promise<MeetingRecording | undefined> {
  if (event.passthrough !== null) {
    const byPassthrough = await meetingRecordingsRepository.findById(event.passthrough);
    if (byPassthrough !== undefined) {
      return byPassthrough;
    }
  }
  if (event.assetId !== null) {
    return meetingRecordingsRepository.findByMuxAssetId(event.assetId);
  }
  return undefined;
}

/**
 * Resolve the delivery's effect, or `null` when there is nothing to apply. Reads only, OUTSIDE
 * the transaction — the same contract the Daily route follows.
 */
async function resolveEffect(event: MuxWebhookEvent): Promise<MuxWebhookEffect | null> {
  if (event.kind === 'unhandled') {
    return null;
  }
  const recording = await resolveRecordingRow(event);
  if (recording === undefined) {
    log.warn(
      { eventType: event.type, eventId: event.eventId },
      'Mux webhook resolved to no meeting_recordings row — acking with no effect'
    );
    return null;
  }
  const meeting = await meetingsRepository.findById(recording.meetingId);
  if (meeting === undefined) {
    log.warn(
      { recordingId: recording.id, eventType: event.type },
      'Mux webhook resolved to a row with no live meeting — acking with no effect'
    );
    return null;
  }
  return { event, meeting, recording };
}

/** What {@link applyEffect} tells the post-commit block. */
interface ApplyEffectResult {
  readonly transitioned: boolean;
}

/**
 * The webhook's transaction executor — `@balo/db` does not export `DbExecutor` from its
 * package root, so it is derived the same way `presence-writer.ts` derives `PresenceExecutor`:
 * from a REQUIRED `exec` parameter on a repository method that already takes one.
 */
type MuxWebhookExecutor = Parameters<typeof meetingRecordingsRepository.markReady>[1];

/**
 * Apply one effect on the webhook's own transaction — exactly one CAS per arm (T8 / T9).
 */
async function applyEffect(
  exec: MuxWebhookExecutor,
  effect: MuxWebhookEffect,
  now: Date
): Promise<ApplyEffectResult> {
  const { event, recording } = effect;

  if (event.kind === 'video.asset.ready') {
    if (event.playbackId === null) {
      // ⚠ AN ASSET WITH ONLY A PUBLIC PLAYBACK ID IS A CONFIGURATION BUG, NOT A ROW TO
      // HALF-STAMP. Refuse the transition; the marker still commits and the delivery still acks.
      log.error(
        { recordingId: recording.id, eventId: event.eventId },
        'Mux video.asset.ready carried no SIGNED playback id — refusing the transition'
      );
      return { transitioned: false };
    }
    if (event.assetId === null) {
      // ⚠⚠ FIX ROUND 2 (R3) — CANNOT VERIFY WHICH ASSET THIS EVENT DESCRIBES WITHOUT `data.id`.
      // `markReady`'s CAS needs it to close the two-asset hazard (see its docblock); a delivery
      // missing it is refused rather than trusted, exactly like the missing-signed-playback-id
      // case above.
      log.error(
        { recordingId: recording.id, eventId: event.eventId },
        'Mux video.asset.ready carried no asset id — cannot verify which asset this row should describe, refusing the transition'
      );
      return { transitioned: false };
    }
    const updated = await meetingRecordingsRepository.markReady(
      {
        id: recording.id,
        muxAssetId: event.assetId,
        muxPlaybackId: event.playbackId,
        durationSeconds: event.durationSeconds,
        at: now,
      },
      exec
    );
    if (updated === undefined) {
      if (recording.status === 'ingesting' && recording.muxAssetId !== event.assetId) {
        // ⚠⚠ FIX ROUND 2 (R3) — THE ORPHAN SIGNAL. This row's `mux_asset_id` names a DIFFERENT
        // asset than the one this `video.asset.ready` event describes — the two-asset hazard
        // `markReady`'s docblock documents. The asset THIS event names is now an untracked
        // orphan at Mux; ops needs both ids to reconcile or delete it.
        log.error(
          {
            recordingId: recording.id,
            rowMuxAssetId: recording.muxAssetId,
            eventAssetId: event.assetId,
          },
          'Mux video.asset.ready resolved to a row whose mux_asset_id names a DIFFERENT asset — an orphaned Mux asset exists'
        );
      } else {
        log.info(
          { recordingId: recording.id },
          'video.asset.ready: no-op (replay, or the row already progressed)'
        );
      }
    }
    return { transitioned: updated !== undefined };
  }

  // video.asset.errored
  if (
    event.assetId !== null &&
    recording.muxAssetId !== null &&
    recording.muxAssetId !== event.assetId
  ) {
    // ⚠⚠ FIX ROUND 2 (R3) — "SAME TREATMENT FOR `video.asset.errored`". The same two-asset
    // hazard applies here: an orphaned FIRST attempt's asset can report its own error after a
    // SECOND, successful attempt has already stamped the row's `mux_asset_id`. Failing the row
    // for an asset it no longer points at would incorrectly fail a segment whose real (second)
    // asset may still succeed. Refuse rather than call `markFailed`; the marker still commits.
    log.error(
      {
        recordingId: recording.id,
        rowMuxAssetId: recording.muxAssetId,
        eventAssetId: event.assetId,
      },
      'Mux video.asset.errored named a DIFFERENT asset than this row currently points at — refusing to fail the row for an orphaned asset error'
    );
    return { transitioned: false };
  }
  const updated = await meetingRecordingsRepository.markFailed(
    {
      id: recording.id,
      stage: 'mux_asset',
      // ⚠⚠ FIX ROUND 2 (R4) — SANITIZED, matching every other vendor-error sink this PR
      // writes to (`lib/sanitize-error.ts`'s doctrine). `data.errors.messages` is arbitrary
      // vendor text; passed through `sanitizedErrorMessage` it degrades to a plain string
      // (not a `Mux.APIError`), so this reduces to `redactUrls` — the same URL-shaped-substring
      // backstop `recording-ingest.ts` and `recording-cleanup-source.ts` already apply.
      reason: sanitizedErrorMessage(
        event.errorMessage ?? 'Mux reported an asset error with no message'
      ),
      at: now,
    },
    exec
  );
  if (updated === undefined) {
    log.info(
      { recordingId: recording.id },
      'video.asset.errored: no-op (replay, or the segment already reached ready — never overwritten)'
    );
  }
  return { transitioned: updated !== undefined };
}

export async function muxWebhookRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post('/webhooks/mux', { config: { rawBody: true } }, async (request, reply) => {
    // ⚠ FIRST, BEFORE THE HMAC. See {@link MUX_WEBHOOK_IP_RATE_LIMIT}.
    if (await enforceWebhookIpRateLimit(MUX_WEBHOOK_IP_RATE_LIMIT, request.ip, reply, log)) return;

    const secret = process.env.MUX_WEBHOOK_SECRET;
    if (!secret) {
      // ⚠ AN OUTAGE, NOT A BAD REQUEST. A 400 would tell Mux to stop retrying deliveries that
      // are perfectly valid and that we will process the moment the variable is set.
      log.error({}, 'MUX_WEBHOOK_SECRET is not set — refusing to process an unverified body');
      return reply.code(503).send({ error: 'webhook_not_configured' });
    }

    const rawBody = request.rawBody;
    if (!Buffer.isBuffer(rawBody)) {
      log.warn({ reason: 'missing_raw_body' }, 'Mux webhook rejected');
      return reply.code(400).send({ error: 'invalid signature' });
    }

    const verified = await verifyMuxWebhookSignature(rawBody, request.headers, secret, new Date());
    if (!verified.ok) {
      // ⚠ THE REASON AS A FIELD, NEVER THE BODY.
      log.warn({ reason: verified.reason }, 'Mux webhook signature verification failed');
      return reply.code(400).send({ error: 'invalid signature' });
    }

    // ⚠ THE JSON PARSE IS GUARDED EVEN THOUGH THE SIGNATURE ALREADY PASSED — a verified body is
    // proof of ORIGIN, not of SHAPE.
    const parsed = parseMuxWebhookEvent(decodeJsonBody(rawBody));
    if (!parsed.ok) {
      log.warn({ reason: parsed.reason }, 'Mux webhook payload could not be parsed');
      return reply.code(400).send({ error: 'invalid_payload' });
    }
    const { event } = parsed;

    // Fast idempotent short-circuit on a fully-processed replay (no txn, no reads).
    const seen = await muxWebhookEventsRepository.findByEventId(event.eventId);
    if (seen?.processedAt) {
      log.info(
        { eventId: event.eventId, eventType: event.type },
        'Mux webhook replay — already processed, acking'
      );
      return reply.code(200).send({ received: true });
    }

    const effect = await resolveEffect(event);
    const now = new Date();

    // ⚠ `applied` is the TRANSACTION'S OWN RETURN VALUE, not a `let` closed over by the
    // callback — the latter shape defeats TypeScript's narrowing of the post-commit reads below.
    const applied: ApplyEffectResult | null = await db.transaction(async (tx) => {
      const marker = await muxWebhookEventsRepository.insertReceived(
        { eventId: event.eventId, type: event.type, passthrough: event.passthrough },
        tx
      );
      if (marker === undefined) {
        // ⚠ A CONCURRENT DELIVERY WON THE UNIQUE INDEX. Abandon the effect.
        return null;
      }
      const result = effect === null ? null : await applyEffect(tx, effect, now);
      await muxWebhookEventsRepository.markProcessed(event.eventId, tx);
      return result;
    });

    // POST-COMMIT. ⚠ NEVER INSIDE THE TRANSACTION.
    if (effect !== null && applied?.transitioned) {
      if (effect.event.kind === 'video.asset.ready') {
        // ⚠⚠ FIX ROUND 1 (F1) — `trackServer` ABOVE the enqueue, DELIBERATELY. PostHog is
        // fire-and-forget and cannot throw into this handler; the enqueue below CAN fail (a
        // Redis blip) and is wrapped best-effort so it can never turn a committed transition
        // into a `500`. If the enqueue ran first and threw before this point, `recording_ready`
        // would never fire even though the row genuinely reached `ready` — the analytics event
        // must not be at the mercy of the queue's availability.
        const secondsSinceMeetingEnd =
          effect.meeting.endedAt === null
            ? null
            : Math.round((now.getTime() - effect.meeting.endedAt.getTime()) / 1000);
        trackServer(RECORDING_SERVER_EVENTS.RECORDING_READY, {
          meeting_id: effect.meeting.id,
          recording_id: effect.recording.id,
          duration_seconds: effect.event.durationSeconds,
          seconds_since_meeting_end: secondsSinceMeetingEnd,
          distinct_id: effect.meeting.id,
        });
        await enqueueBestEffort(
          () => enqueueRecordingCleanupSource({ recordingId: effect.recording.id }),
          {
            meetingId: effect.meeting.id,
            recordingId: effect.recording.id,
            eventId: event.eventId,
          },
          log,
          'recording-cleanup-source enqueue failed on the Mux webhook — best-effort, the delivery still acks'
        );
      } else {
        trackServer(RECORDING_SERVER_EVENTS.RECORDING_FAILED, {
          meeting_id: effect.meeting.id,
          stage: 'mux_asset',
          reason: 'vendor_reported',
          distinct_id: effect.meeting.id,
        });
      }
    }

    log.info(
      { eventId: event.eventId, eventType: event.type, handled: effect !== null },
      'Mux webhook processed'
    );
    return reply.code(200).send({ received: true });
  });
}

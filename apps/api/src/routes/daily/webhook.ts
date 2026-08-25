/**
 * BAL-134 (§5.1) / BAL-473 (§7.4) — `POST /webhooks/daily`. The single idempotent Daily
 * webhook endpoint, leg 1 of D1's presence model AND the Daily half of the recording pipeline.
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
 *   6. POST-COMMIT: the status transitions, the recording enqueues, and analytics (never
 *      inside the transaction — enqueuing to BullMQ or PostHog must not be undone by a rollback).
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
 *
 * ── ⚠⚠ BAL-473 — THE RECORDING ARMS RESOLVE BY INSTANCE/RECORDING ID, NEVER BY ROOM ──────
 *
 * `recording.started` carries NO `room_name` at all (see `services/daily/webhook-events.ts`'s
 * docblock). `resolveEffect` therefore branches on the three recording kinds BEFORE the
 * room-name gate below, which governs only the presence/meeting arms.
 */
import {
  db,
  dailyWebhookEventsRepository,
  meetingPresenceRepository,
  meetingRecordingsRepository,
  meetingsRepository,
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
import { enqueueRecordingEnsure } from '../../jobs/recording-capture.js';
import { enqueueRecordingIngest } from '../../jobs/recording-ingest.js';

const log = createLogger('daily-webhook-route');

/** Reject a room name that is not one of ours BEFORE spending a database round trip on it. */
const BALO_ROOM_NAME_PATTERN = /^balo-[0-9a-f]{32}$/;

/**
 * The three RECORDING event kinds — the arm `resolveEffect`/`applyEffect` dispatch on BEFORE
 * the room-name gate.
 */
type RecordingWebhookEvent = Extract<
  DailyWebhookEvent,
  | { readonly kind: 'recording.started' }
  | { readonly kind: 'recording.ready-to-download' }
  | { readonly kind: 'recording.error' }
>;

/**
 * The work one verified delivery implies. A DISCRIMINATED UNION (BAL-473) so `applyEffect`
 * still cannot read a field an arm does not carry — the existing type discipline, preserved.
 */
type DailyWebhookEffect =
  | {
      readonly kind: 'presence';
      /**
       * ⚠ `unhandled` AND THE THREE RECORDING KINDS ARE EXCLUDED **BY TYPE**. `resolveEffect`
       * answers `null` for an unhandled event and routes every recording kind to the `kind:
       * 'recording'` arm below, and narrowing here is what makes both guarantees checkable.
       */
      readonly event: Exclude<
        DailyWebhookEvent,
        { readonly kind: 'unhandled' } | RecordingWebhookEvent
      >;
      readonly meeting: Meeting;
      /**
       * The presence observation, ALREADY RESOLVED. `null` for `meeting.ended`, which closes
       * every interval at once and needs no identity.
       *
       * ⚠ RESOLVED HERE RATHER THAN INSIDE THE TRANSACTION, because `presence-writer.ts`'s own
       * contract says so in as many words: "phase 1 is READS ONLY, OUTSIDE the transaction".
       */
      readonly presence: PresenceEffect | null;
    }
  | {
      readonly kind: 'recording';
      readonly event: RecordingWebhookEvent;
      /** Carried on the recording arm too — the post-commit enqueues and analytics need it. */
      readonly meeting: Meeting;
      readonly recording: MeetingRecording;
    };

/**
 * BAL-473 — resolve the live `meeting_recordings` row for one of the three recording arms.
 * Reads only, OUTSIDE the transaction — the same contract `presence-writer.ts` states for the
 * presence side.
 */
async function resolveRecordingRow(
  event: RecordingWebhookEvent
): Promise<MeetingRecording | undefined> {
  if (event.kind === 'recording.started') {
    // ⚠ Resolved by OUR OWN id (`instanceId` = `meeting_recordings.id`). NEVER an insert here —
    // see the module docblock's Overview reference.
    return meetingRecordingsRepository.findById(event.instanceId);
  }
  if (event.kind === 'recording.ready-to-download') {
    const byDailyId = await meetingRecordingsRepository.findByDailyRecordingId(
      event.dailyRecordingId
    );
    if (byDailyId !== undefined) {
      return byDailyId;
    }
    return resolveRecordingByRoomFallback(event.roomName);
  }
  // recording.error
  if (event.instanceId !== null) {
    const byInstanceId = await meetingRecordingsRepository.findById(event.instanceId);
    if (byInstanceId !== undefined) {
      return byInstanceId;
    }
  }
  return resolveRecordingByRoomFallback(event.roomName);
}

/**
 * The FALLBACK ladder for a dropped `recording.started` (§5.1a): room name → the meeting's
 * CAPTURING segment, accepted ONLY when that row's `dailyRecordingId IS NULL` — otherwise a
 * capturing row that already knows its Daily id could be claimed by a DIFFERENT recording's
 * payload, which is exactly the mis-attachment window this guard closes.
 */
async function resolveRecordingByRoomFallback(
  roomName: string | null
): Promise<MeetingRecording | undefined> {
  if (roomName === null || !BALO_ROOM_NAME_PATTERN.test(roomName)) {
    return undefined;
  }
  const meeting = await meetingsRepository.findByDailyRoomName(roomName);
  if (meeting === undefined) {
    return undefined;
  }
  const capturing = await meetingRecordingsRepository.findCapturingForMeeting(meeting.id);
  if (capturing === undefined || capturing.dailyRecordingId !== null) {
    return undefined;
  }
  return capturing;
}

/**
 * Resolve the delivery's effect, or `null` when there is nothing to apply.
 *
 * ⚠ `null` IS NOT A FAILURE ON ANY PATH — an unhandled event type, a recording payload that
 * resolves to no row (or a row with no live meeting), a room name that is not ours, or a room
 * whose meeting is gone or soft-deleted. Every path records its marker and acks.
 */
async function resolveEffect(event: DailyWebhookEvent): Promise<DailyWebhookEffect | null> {
  if (event.kind === 'unhandled') {
    return null;
  }

  // ── BAL-473 — the recording arms, BEFORE the room-name gate. `recording.started` has no room. ──
  if (
    event.kind === 'recording.started' ||
    event.kind === 'recording.ready-to-download' ||
    event.kind === 'recording.error'
  ) {
    const recording = await resolveRecordingRow(event);
    if (recording === undefined) {
      log.warn(
        { eventType: event.type, eventId: event.eventId },
        'Daily recording webhook resolved to no row — acking with no effect'
      );
      return null;
    }
    const meeting = await meetingsRepository.findById(recording.meetingId);
    if (meeting === undefined) {
      log.warn(
        { recordingId: recording.id, eventType: event.type },
        'Daily recording webhook resolved to a row with no live meeting — acking with no effect'
      );
      return null;
    }
    return { kind: 'recording', event, meeting, recording };
  }

  if (event.roomName === null || !BALO_ROOM_NAME_PATTERN.test(event.roomName)) {
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
    return { kind: 'presence', event, meeting, presence: null };
  }

  // PHASE 1 — reads only, OUTSIDE the transaction. See `DailyWebhookEffect.presence`.
  const presence = await resolvePresenceEffect({
    action: event.kind === 'participant.joined' ? 'open' : 'close',
    meeting,
    participantId: event.participantId,
    at: event.occurredAt,
  });
  return { kind: 'presence', event, meeting, presence };
}

/** What {@link applyEffect} tells the post-commit block, for the `kind: 'recording'` arm only. */
interface ApplyEffectResult {
  /** Whether the recording's CAS actually transitioned the row (vs. a no-op replay/refusal). */
  readonly recordingTransitioned: boolean;
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
 *
 * ⚠ BAL-473's `recording.started` arm carries the same hazard for `startedAt` and is guarded
 * the same way, for the same reason.
 */
async function applyEffect(
  exec: PresenceExecutor,
  effect: DailyWebhookEffect,
  receivedAt: Date
): Promise<ApplyEffectResult> {
  if (effect.kind === 'presence') {
    return applyPresenceKindEffect(exec, effect);
  }

  // ── BAL-473 — the recording branch. Exactly ONE CAS per arm (T2 / T3 / T4). ──────────────
  return applyRecordingKindEffect(exec, effect, receivedAt);
}

/** {@link applyEffect}'s `kind: 'presence'` arm — the join/leave/meeting-ended handling. */
async function applyPresenceKindEffect(
  exec: PresenceExecutor,
  effect: Extract<DailyWebhookEffect, { kind: 'presence' }>
): Promise<ApplyEffectResult> {
  const { event, meeting, presence } = effect;

  if (event.kind === 'meeting.ended') {
    if (!Number.isFinite(event.occurredAt.getTime())) {
      log.error(
        { meetingId: meeting.id, eventId: event.eventId, outcome: 'invalid_timestamp' },
        'Daily `meeting.ended` carried a non-finite timestamp — refusing the close and acking so the vendor stops retrying'
      );
      return { recordingTransitioned: false };
    }
    const closed = await meetingPresenceRepository.closeAllOpen(meeting.id, event.occurredAt, exec);
    log.info(
      { meetingId: meeting.id, closedIntervals: closed, trigger: 'meeting.ended' },
      'Daily session ended — closed every open presence interval'
    );
    return { recordingTransitioned: false };
  }

  if (presence !== null) {
    await applyPresenceEffect(exec, presence);
  }
  return { recordingTransitioned: false };
}

/**
 * {@link applyRecordingKindEffect}'s `recording.started` arm (T2). Extracted purely to keep
 * the caller's own Cognitive Complexity readable — behaviour is unchanged from the inline form.
 */
async function applyRecordingStarted(
  exec: PresenceExecutor,
  event: Extract<RecordingWebhookEvent, { kind: 'recording.started' }>,
  recording: MeetingRecording,
  meeting: Meeting
): Promise<ApplyEffectResult> {
  if (!Number.isFinite(event.startedAt.getTime())) {
    log.error(
      { meetingId: meeting.id, recordingId: recording.id, eventId: event.eventId },
      'Daily `recording.started` carried a non-finite start_ts — refusing the stamp and acking'
    );
    return { recordingTransitioned: false };
  }
  const updated = await meetingRecordingsRepository.markStarted(
    { id: recording.id, dailyRecordingId: event.dailyRecordingId, startedAt: event.startedAt },
    exec
  );
  if (updated === undefined) {
    if (recording.status === 'failed') {
      // ⚠⚠ THE T5 RESIDUAL (§5.1a) — DELIBERATELY REFUSED, DOCUMENTED NOT FIXED. Reviving a
      // `failed` row would put a capturing row OUTSIDE the capture slot and let a second
      // Daily recording start in parallel. The `error` rate here is the health signal.
      log.error(
        { instanceId: event.instanceId, meetingId: meeting.id, recordingId: recording.id },
        'Daily reports a recording started for a segment this platform already marked failed — an unattached Daily recording exists'
      );
    } else {
      log.info(
        { meetingId: meeting.id, recordingId: recording.id },
        'recording.started: no-op (replay, or the segment already progressed)'
      );
    }
  }
  return { recordingTransitioned: false };
}

/** {@link applyEffect}'s `kind: 'recording'` arm — the T2/T3/T4 CAS ladder. */
async function applyRecordingKindEffect(
  exec: PresenceExecutor,
  effect: Extract<DailyWebhookEffect, { kind: 'recording' }>,
  receivedAt: Date
): Promise<ApplyEffectResult> {
  const { event, recording, meeting } = effect;

  if (event.kind === 'recording.started') {
    return applyRecordingStarted(exec, event, recording, meeting);
  }

  if (event.kind === 'recording.ready-to-download') {
    const startedAt =
      event.startedAt !== null && Number.isFinite(event.startedAt.getTime())
        ? event.startedAt
        : undefined;
    const updated = await meetingRecordingsRepository.markSourceReady(
      {
        id: recording.id,
        dailyRecordingId: event.dailyRecordingId,
        durationSeconds: event.durationSeconds,
        startedAt,
        at: receivedAt,
      },
      exec
    );
    if (updated === undefined) {
      log.info(
        { meetingId: meeting.id, recordingId: recording.id },
        'recording.ready-to-download: no-op (replay, or the segment already progressed)'
      );
    }
    return { recordingTransitioned: updated !== undefined };
  }

  // recording.error
  const updated = await meetingRecordingsRepository.markFailed(
    {
      id: recording.id,
      stage: 'daily',
      reason: event.errorMessage ?? 'Daily reported a recording error with no message',
      at: receivedAt,
    },
    exec
  );
  if (updated === undefined) {
    log.info(
      { meetingId: meeting.id, recordingId: recording.id },
      'recording.error: no-op (replay, or the segment already reached ready — never overwritten)'
    );
  }
  return { recordingTransitioned: updated !== undefined };
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

/**
 * The route handler's post-commit work for a `kind: 'presence'` effect whose event is NOT
 * `meeting.ended` (the caller guards that). Extracted purely to keep the handler's own
 * Cognitive Complexity readable — behaviour is unchanged from the inline form.
 */
async function handlePresencePostCommit(
  effect: Extract<DailyWebhookEffect, { kind: 'presence' }>,
  event: DailyWebhookEvent,
  receivedAt: Date
): Promise<void> {
  const transition = await reconcileMeetingStatus(effect.meeting, receivedAt);
  // ⚠ BAL-473 — THE FIRST BULLMQ ENQUEUE AT THIS SITE. `reconcileMeetingStatus` can also
  // return `'waiting_for_participants'`, which must arm NOTHING (D1: one party alone is
  // precisely the window the recording must stay out of).
  if (transition === 'in_progress') {
    await enqueueBestEffort(
      () =>
        enqueueRecordingEnsure({
          meetingId: effect.meeting.id,
          trigger: 'in_progress',
          dedupeToken: event.eventId,
        }),
      { meetingId: effect.meeting.id, eventId: event.eventId, trigger: 'in_progress' },
      log,
      'recording-ensure enqueue failed on the Daily webhook — best-effort, the delivery still acks'
    );
  } else if (
    effect.event.kind === 'participant.joined' &&
    effect.meeting.status === 'in_progress'
  ) {
    await enqueueBestEffort(
      () =>
        enqueueRecordingEnsure({
          meetingId: effect.meeting.id,
          trigger: 'rejoin',
          dedupeToken: event.eventId,
        }),
      { meetingId: effect.meeting.id, eventId: event.eventId, trigger: 'rejoin' },
      log,
      'recording-ensure enqueue failed on the Daily webhook — best-effort, the delivery still acks'
    );
  }
}

/**
 * The route handler's post-commit work for a `kind: 'recording'` effect — the ready-to-download
 * ingest enqueue, the re-arm, and the failure analytics. Extracted purely to keep the handler's
 * own Cognitive Complexity readable — behaviour is unchanged from the inline form.
 */
async function handleRecordingPostCommit(
  effect: Extract<DailyWebhookEffect, { kind: 'recording' }>,
  applied: ApplyEffectResult | null,
  event: DailyWebhookEvent
): Promise<void> {
  if (effect.event.kind === 'recording.ready-to-download') {
    if (applied?.recordingTransitioned) {
      await enqueueBestEffort(
        () => enqueueRecordingIngest({ recordingId: effect.recording.id }),
        {
          meetingId: effect.meeting.id,
          recordingId: effect.recording.id,
          eventId: event.eventId,
        },
        log,
        'recording-ingest enqueue failed on the Daily webhook — best-effort, the delivery still acks'
      );
    }
    // ⚠⚠ THE RE-ARM (ARCHITECT ADDITION, §5.2) — UNCONDITIONAL, EVEN WHEN THE CAS WAS A
    // NO-OP. Daily auto-stops a recording on `minIdleTimeOut`; between that stop and this
    // delivery, a `participant.joined` could have found a still-capturing row and no-op'd.
    // `recording-ensure` gates itself (empty room / not in_progress / already capturing),
    // so this enqueue is free when nothing needs it.
    await enqueueBestEffort(
      () =>
        enqueueRecordingEnsure({
          meetingId: effect.meeting.id,
          trigger: 'rejoin',
          dedupeToken: event.eventId,
        }),
      { meetingId: effect.meeting.id, eventId: event.eventId, trigger: 'rejoin' },
      log,
      'recording-ensure enqueue failed on the Daily webhook — best-effort, the delivery still acks'
    );
    return;
  }

  if (effect.event.kind === 'recording.error') {
    if (applied?.recordingTransitioned) {
      trackServer(RECORDING_SERVER_EVENTS.RECORDING_FAILED, {
        meeting_id: effect.meeting.id,
        stage: 'daily',
        reason: 'vendor_reported',
        distinct_id: effect.meeting.id,
      });
    }
    // Same re-arm as `ready-to-download` — a dropped/errored segment must not leave the
    // meeting silently unrecorded for the rest of the call.
    await enqueueBestEffort(
      () =>
        enqueueRecordingEnsure({
          meetingId: effect.meeting.id,
          trigger: 'rejoin',
          dedupeToken: event.eventId,
        }),
      { meetingId: effect.meeting.id, eventId: event.eventId, trigger: 'rejoin' },
      log,
      'recording-ensure enqueue failed on the Daily webhook — best-effort, the delivery still acks'
    );
  }
  // `recording.started` — nothing post-commit.
}

export async function dailyWebhookRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post('/webhooks/daily', { config: { rawBody: true } }, async (request, reply) => {
    // ⚠ FIRST, BEFORE THE HMAC. See {@link DAILY_WEBHOOK_IP_RATE_LIMIT}.
    if (await enforceWebhookIpRateLimit(DAILY_WEBHOOK_IP_RATE_LIMIT, request.ip, reply, log))
      return;

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
    const parsed = parseDailyWebhookEvent(decodeJsonBody(rawBody), receivedAt);
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

    // ⚠ `applied` is the TRANSACTION'S OWN RETURN VALUE, not a `let` closed over by the
    // callback — the latter shape defeats TypeScript's narrowing of the post-commit reads below.
    const applied: ApplyEffectResult | null = await db.transaction(async (tx) => {
      const marker = await dailyWebhookEventsRepository.insertReceived(
        { eventId: event.eventId, type: event.type, roomName: event.roomName },
        tx
      );
      if (marker === undefined) {
        // ⚠ A CONCURRENT DELIVERY WON THE UNIQUE INDEX. The other transaction either already
        // applied the effect or is about to; applying it twice is the double-interval over-bill
        // D2 exists to prevent (or, on the recording side, a duplicate CAS attempt).
        return null;
      }
      const result = effect === null ? null : await applyEffect(tx, effect, receivedAt);
      await dailyWebhookEventsRepository.markProcessed(event.eventId, tx);
      return result;
    });

    // POST-COMMIT. ⚠ NEVER INSIDE THE TRANSACTION: enqueuing to BullMQ or PostHog, and
    // `reconcileMeetingStatus`'s analytics + scheduled-notification cancel path, must not be
    // undone by a rollback.
    if (effect?.kind === 'presence' && effect.event.kind !== 'meeting.ended') {
      await handlePresencePostCommit(effect, event, receivedAt);
    }

    if (effect?.kind === 'recording') {
      await handleRecordingPostCommit(effect, applied, event);
    }

    log.info(
      { eventId: event.eventId, eventType: event.type, handled: effect !== null },
      'Daily webhook processed'
    );
    return reply.code(200).send({ received: true });
  });
}

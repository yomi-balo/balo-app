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
 *
 * ⚠ BAL-480 — the recording arms still resolve by instance/recording id first; the
 * `ready-to-download` ROOM FALLBACK is additionally gated on the payload's start instant, so a
 * stuck-slot reap's fresh segment cannot be mistaken for an orphaned earlier recording of the
 * same room (see `resolveRecordingByRoomFallback`).
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
import {
  trackServer,
  RECORDING_SERVER_EVENTS,
  TRANSCRIPT_SERVER_EVENTS,
} from '@balo/analytics/server';
import type { FastifyInstance } from 'fastify';
import {
  decodeJsonBody,
  enforceWebhookIpRateLimit,
  enqueueBestEffort,
} from '../../lib/webhook-request.js';
import { sanitizedErrorMessage } from '../../lib/sanitize-error.js';
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
import { enqueueRecordingCleanupSource } from '../../jobs/recording-cleanup-source.js';
import { enqueueTranscriptIngest, enqueueTranscriptSubmit } from '../../jobs/transcript-capture.js';

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
 * BAL-483 — the two BATCH-PROCESSOR event kinds — the arm `resolveEffect`/`applyEffect`
 * dispatch on BEFORE the room-name gate, the same discipline as the recording arms.
 */
type BatchWebhookEvent = Extract<
  DailyWebhookEvent,
  { readonly kind: 'batch-processor.job-finished' } | { readonly kind: 'batch-processor.error' }
>;

/**
 * The work one verified delivery implies. A DISCRIMINATED UNION (BAL-473) so `applyEffect`
 * still cannot read a field an arm does not carry — the existing type discipline, preserved.
 */
type DailyWebhookEffect =
  | {
      readonly kind: 'presence';
      /**
       * ⚠ `unhandled`, THE THREE RECORDING KINDS AND THE TWO BATCH KINDS ARE EXCLUDED **BY
       * TYPE**. `resolveEffect` answers `null` for an unhandled event and routes every
       * recording/batch kind to its own arm below, and narrowing here is what makes both
       * guarantees checkable.
       */
      readonly event: Exclude<
        DailyWebhookEvent,
        { readonly kind: 'unhandled' } | RecordingWebhookEvent | BatchWebhookEvent
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
    }
  | {
      /** BAL-483 — the Daily Batch Processor transcription arm. */
      readonly kind: 'transcript_capture';
      readonly event: BatchWebhookEvent;
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
    return resolveRecordingByRoomFallback(event.roomName, event.startedAt, event.kind);
  }
  // ⚠⚠ recording.error — THE ONE RECORDING ARM THE BAL-480 GUARD CANNOT ARM. The residual that
  // leaves is STATED here rather than gated (fix round 1, item 8 — of the two options offered,
  // this is the one chosen, and the reasoning is below).
  //
  // This payload carries no start instant of any kind, so `null` is passed and the room fallback
  // runs UNGATED. `instance_id` is not the reassurance it looks like: `instanceIdFrom` requires a
  // UUID and the union's own comment says even that field is optional, so an absent or non-UUID
  // `instance_id` falls straight through to the room fallback.
  //
  // THE RESIDUAL, CONCRETELY: after a stuck-slot reap, a `recording.error` about the ORPHANED
  // earlier recording — with no usable `instance_id` — resolves the meeting's NEW, still-live
  // capturing segment by room name and `markFailed`s it.
  //
  // WHY IT IS NOT GATED: the only discriminator available here is `capturing.createdAt` age
  // against the delivery instant, and it points the WRONG way. A legitimate `recording.error` for
  // the current segment normally arrives while that row is still YOUNG (its start call has just
  // failed) — the same shape as the misattribution — so no threshold separates them, and a gate
  // would trade a rare misattribution for a common LOST failure stamp. A lost failure stamp is
  // strictly worse: it leaves the capture slot held (`capture_ended_at` never set). The bounding
  // facts: the fallback already refuses any row that HAS a Daily id, so the exposure is only the
  // brief unacknowledged window after a reap, and the reap's own `recording_failed`
  // {reason: 'stuck_capture'} emit is the signal that the window is open at all.
  if (event.instanceId !== null) {
    const byInstanceId = await meetingRecordingsRepository.findById(event.instanceId);
    if (byInstanceId !== undefined) {
      return byInstanceId;
    }
  }
  return resolveRecordingByRoomFallback(event.roomName, null, event.kind);
}

/**
 * ⚠⚠ BAL-480 — CLOCK-SKEW TOLERANCE ON THE ROOM FALLBACK'S START-INSTANT GUARD. The legitimate
 * gap between `insertCapturing` committing and Daily's `start_ts` is sub-second; the illegitimate
 * gap (an orphan from a reaped slot) is at least `STUCK_CAPTURE_THRESHOLD_MS` — five minutes. One
 * minute sits an order of magnitude above any plausible skew between Postgres `now()` and Daily's
 * clock, and five times below the smallest gap the guard must catch.
 */
const ROOM_FALLBACK_CLOCK_SKEW_MS = 60_000;

/**
 * The FALLBACK ladder for a dropped `recording.started` (§5.1a): room name → the meeting's
 * CAPTURING segment, accepted ONLY when that row's `dailyRecordingId IS NULL` — otherwise a
 * capturing row that already knows its Daily id could be claimed by a DIFFERENT recording's
 * payload, which is exactly the mis-attachment window this guard closes.
 *
 * ⚠⚠ BAL-480 — THE SECOND GUARD, AND WHY THE FIRST ONE STOPPED BEING ENOUGH. `handleEnsure`'s
 * stuck-slot reaper releases a capture slot whose `recording.started` never arrived and
 * immediately arms a FRESH segment. If Daily actually WAS recording (only the delivery was
 * lost), that first recording is now an ORPHAN, and when it finishes its `ready-to-download`
 * resolves nothing by `recording_id` and lands here — where `findCapturingForMeeting` returns
 * the NEW, STILL-LIVE segment. `dailyRecordingId IS NULL` does not save us, because the very
 * fault that caused the reap (a dropped `recording.started`) is likely to have hit the new
 * segment too. Marking a live segment `source_ready` against the orphan's asset releases its
 * slot mid-capture and CASCADES.
 *
 * ⚠ `startedAt` IS THE DISCRIMINATOR because the row is created BEFORE Daily is asked to start
 * it, so a legitimate `start_ts` is never earlier than `createdAt`.
 *
 * ⚠⚠ THERE ARE **TWO** DEGRADE PATHS, NOT ONE, AND THEY ARE ANSWERED DIFFERENTLY (fix round 1):
 *   · `null` — "the vendor did not tell us when". `recording.error` always takes this path (it
 *     carries no `start_ts` at all); `ready-to-download` takes it when the field is absent. The
 *     guard cannot be evaluated, so the row is ACCEPTED — the pre-BAL-480 behaviour — and the
 *     acceptance is LOGGED, because a guard nobody can prove is running is not a guard. A
 *     production stream of that log line on `ready-to-download` means `start_ts` is not the
 *     field name Daily actually sends and the guard is inert.
 *   · AN **INVALID DATE** — "the vendor told us something we cannot interpret". `instantFrom`
 *     (`services/daily/webhook-events.ts`) returns exactly this rather than `null`, deliberately.
 *     It is REFUSED. `NaN < x` is `false`, so a bare comparison would have failed OPEN on
 *     `start_ts: "garbage"` — the one input where we can least prove the payload belongs to the
 *     current segment. Refusing costs one un-ingested orphan (an already-accepted, logged
 *     residual); accepting corrupts a live segment mid-capture. Same posture as
 *     `applyRecordingStarted`'s non-finite refusal, below.
 */
async function resolveRecordingByRoomFallback(
  roomName: string | null,
  recordingStartedAt: Date | null,
  eventKind: RecordingWebhookEvent['kind']
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
  if (recordingStartedAt === null) {
    // ⚠ THE GUARD IS NOT ARMED FOR THIS DELIVERY — the ONLY way ops can tell whether it is
    // armed in production at all. Expected on every `recording.error`; on
    // `recording.ready-to-download` it means the payload carried no `start_ts`/`startTs`.
    log.info(
      { roomName, meetingId: meeting.id, recordingId: capturing.id, eventKind },
      'Daily room fallback resolved a capturing segment with NO start instant — the BAL-480 start-instant guard could not be evaluated for this delivery'
    );
    return capturing;
  }
  const startedAtMs = recordingStartedAt.getTime();
  if (!Number.isFinite(startedAtMs)) {
    log.warn(
      { roomName, meetingId: meeting.id, recordingId: capturing.id, eventKind },
      'Daily room fallback carried an UNINTERPRETABLE start instant — refusing rather than failing open, since an unparseable timestamp cannot prove the payload belongs to the current capturing segment (BAL-480)'
    );
    return undefined;
  }
  if (startedAtMs < capturing.createdAt.getTime() - ROOM_FALLBACK_CLOCK_SKEW_MS) {
    log.warn(
      {
        roomName,
        meetingId: meeting.id,
        recordingId: capturing.id,
        startedAt: recordingStartedAt.toISOString(),
        capturingCreatedAt: capturing.createdAt.toISOString(),
      },
      "Daily ready-to-download names a recording that began BEFORE this meeting's current capturing segment — refusing the room fallback; an orphaned Daily recording from a reaped capture slot (BAL-480)"
    );
    return undefined;
  }
  return capturing;
}

/**
 * BAL-483 — resolve the live `meeting_recordings` row for a batch-processor arm. Reads only,
 * OUTSIDE the transaction (the `resolveRecordingRow` contract).
 *
 * PRIMARY: `transcript_job_id` — OUR stamp of the id Daily returned SYNCHRONOUSLY from
 * `POST /batch-processor`. Exact; no inference.
 *
 * FALLBACK: `input.recordingId` → `daily_recording_id`. It exists for exactly ONE window —
 * the POST succeeded but `markTranscriptJobSubmitted` lost its transaction, leaving a
 * submitted job with no stamp. ⚠ IT REFUSES A ROW ALREADY OWNED BY A DIFFERENT JOB, the
 * `resolveRecordingByRoomFallback` guard restated: a row whose `transcript_job_id` names some
 * OTHER job must not be claimed by this delivery.
 */
async function resolveBatchRecordingRow(
  event: BatchWebhookEvent
): Promise<MeetingRecording | undefined> {
  const byJobId = await meetingRecordingsRepository.findByTranscriptJobId(event.batchJobId);
  if (byJobId !== undefined) {
    return byJobId;
  }
  if (event.dailyRecordingId === null) {
    return undefined;
  }
  const byRecordingId = await meetingRecordingsRepository.findByDailyRecordingId(
    event.dailyRecordingId
  );
  if (byRecordingId === undefined || byRecordingId.transcriptJobId !== null) {
    return undefined;
  }
  log.info(
    { recordingId: byRecordingId.id, eventType: event.type },
    'Daily batch-processor delivery resolved by daily_recording_id — the submit stamp is missing for this segment (BAL-483)'
  );
  return byRecordingId;
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

  // ── BAL-483 — the two batch-processor arms, BEFORE the room-name gate. Neither carries a room. ──
  if (event.kind === 'batch-processor.job-finished' || event.kind === 'batch-processor.error') {
    const recording = await resolveBatchRecordingRow(event);
    if (recording === undefined) {
      log.warn(
        { eventType: event.type, eventId: event.eventId },
        'Daily batch-processor webhook resolved to no row — acking with no effect'
      );
      return null;
    }
    // ⚠ FIX ROUND 1 (M9) — IF THIS EVER FIRES WHILE THE RECORDING'S BATCH JOB IS STILL IN
    // FLIGHT (`transcript_job_submitted_at IS NOT NULL AND transcript_job_finished_at IS NULL`),
    // this webhook's terminal effect is DROPPED — no CAS runs, `transcript_job_finished_at`
    // never gets stamped, and `recording-cleanup-source`'s withhold gate (§7.4) then blocks that
    // row's cleanup FOREVER (see the matching comment there). Not reachable today — there is no
    // delete-meeting route in this codebase — but a meeting deleted mid-batch-job would trigger
    // exactly this the moment one ships.
    const meeting = await meetingsRepository.findById(recording.meetingId);
    if (meeting === undefined) {
      log.warn(
        { recordingId: recording.id, eventType: event.type },
        'Daily batch-processor webhook resolved to a row with no live meeting — acking with no effect'
      );
      return null;
    }
    return { kind: 'transcript_capture', event, meeting, recording };
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
  if (effect.kind === 'transcript_capture') {
    return applyTranscriptCaptureEffect(exec, effect, receivedAt);
  }

  // ── BAL-473 — the recording branch. Exactly ONE CAS per arm (T2 / T3 / T4). ──────────────
  return applyRecordingKindEffect(exec, effect, receivedAt);
}

/**
 * {@link applyEffect}'s `kind: 'transcript_capture'` arm (BAL-483) — exactly ONE CAS per arm
 * (B2t / B2e). ⚠⚠ NEITHER ARM TOUCHES `status` / `failed_stage` / `failure_reason` — a failed
 * TRANSCRIPTION is not a failed RECORDING; the recording is still playable and `status` must
 * stay `ready`.
 */
async function applyTranscriptCaptureEffect(
  exec: PresenceExecutor,
  effect: Extract<DailyWebhookEffect, { kind: 'transcript_capture' }>,
  receivedAt: Date
): Promise<ApplyEffectResult> {
  const { event, recording, meeting } = effect;

  if (event.kind === 'batch-processor.job-finished') {
    const updated = await meetingRecordingsRepository.markTranscriptJobFinished(
      { id: recording.id, at: receivedAt },
      exec
    );
    if (updated === undefined) {
      log.info(
        { meetingId: meeting.id, recordingId: recording.id },
        'batch-processor.job-finished: no-op (replay, or already terminal)'
      );
    }
    return { recordingTransitioned: updated !== undefined };
  }

  // batch-processor.error
  // ⚠⚠ FIX ROUND 1 (M3) — SANITIZED BEFORE IT IS PERSISTED. `event.errorMessage` is Daily's raw
  // `payload.error` — arbitrary response text — and Daily's OWN documented download failure is
  // `Failed to download <presigned S3 URL>: 403 Forbidden` (see `recording.error`'s identical
  // fix below), so an unsanitized write here would persist a signed URL into
  // `transcript_job_failure_reason` indefinitely. `lib/sanitize-error.ts` names this exact sink.
  const updated = await meetingRecordingsRepository.markTranscriptJobFailed(
    {
      id: recording.id,
      reason: sanitizedErrorMessage(
        event.errorMessage ?? 'Daily reported a batch-processor error with no message'
      ),
      at: receivedAt,
    },
    exec
  );
  if (updated === undefined) {
    log.info(
      { meetingId: meeting.id, recordingId: recording.id },
      'batch-processor.error: no-op (replay, or already terminal)'
    );
  }
  return { recordingTransitioned: updated !== undefined };
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
  // ⚠⚠ FIX ROUND 1 (M3) — SANITIZED, IN PASSING. This arm shipped before BAL-483 and had the
  // identical gap `batch-processor.error` (above) was just closed for: `event.errorMessage` is
  // Daily's raw `payload.error_msg` text, and Daily's own documented download failure is
  // `Failed to download <presigned S3 URL>: 403 Forbidden` — an unsanitized write would persist
  // a signed URL into `meeting_recordings.failure_reason` indefinitely.
  const updated = await meetingRecordingsRepository.markFailed(
    {
      id: recording.id,
      stage: 'daily',
      reason: sanitizedErrorMessage(
        event.errorMessage ?? 'Daily reported a recording error with no message'
      ),
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
      // BAL-483 — the transcription producer. SAME gate as the Mux ingest (the CAS actually
      // moved the row to `source_ready`, so the Daily artefact exists and its id is stamped)
      // and the same best-effort posture: a failed enqueue must not fail the delivery.
      await enqueueBestEffort(
        () => enqueueTranscriptSubmit({ recordingId: effect.recording.id }),
        {
          meetingId: effect.meeting.id,
          recordingId: effect.recording.id,
          eventId: event.eventId,
        },
        log,
        'transcript-capture submit enqueue failed on the Daily webhook — best-effort, the delivery still acks'
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

/**
 * BAL-483 — the route handler's post-commit work for a `kind: 'transcript_capture'` effect:
 * the ingest enqueue on success, the failure analytics on error, and the cleanup-source
 * release valve on BOTH arms. Extracted purely to keep the handler's own Cognitive Complexity
 * readable.
 */
async function handleTranscriptCapturePostCommit(
  effect: Extract<DailyWebhookEffect, { kind: 'transcript_capture' }>,
  applied: ApplyEffectResult | null
): Promise<void> {
  if (effect.event.kind === 'batch-processor.job-finished' && applied?.recordingTransitioned) {
    await enqueueBestEffort(
      () =>
        enqueueTranscriptIngest({
          recordingId: effect.recording.id,
          batchJobId: effect.event.batchJobId,
        }),
      { meetingId: effect.meeting.id, recordingId: effect.recording.id },
      log,
      'transcript-capture ingest enqueue failed on the Daily webhook — best-effort, the delivery still acks'
    );
  }

  if (effect.event.kind === 'batch-processor.error' && applied?.recordingTransitioned) {
    // ⚠ `reason` is the CLOSED label, never `event.errorMessage` — PostHog is a third party and
    // a Daily error body is arbitrary text (the `RECORDING_FAILED` posture). The full text
    // lives in `transcript_job_failure_reason` and — SANITIZED (M3) — in the `log.error` below.
    //
    // ⚠⚠ FIX ROUND 1 (M4) — THE `log.error` THE COMMENT ABOVE CLAIMED DID NOT EXIST UNTIL NOW.
    // Genuinely useful for triage (this is a webhook-driven vendor failure with no other
    // operator-visible signal at INFO/WARN), so added rather than just correcting the comment —
    // but logging `event.errorMessage` sanitized, never raw, for the same reason the DB write is.
    log.error(
      {
        meetingId: effect.meeting.id,
        recordingId: effect.recording.id,
        error: sanitizedErrorMessage(
          effect.event.errorMessage ?? 'Daily reported a batch-processor error with no message'
        ),
      },
      'Daily batch-processor transcription job failed (BAL-483)'
    );
    trackServer(TRANSCRIPT_SERVER_EVENTS.TRANSCRIPT_CAPTURE_FAILED, {
      meeting_id: effect.meeting.id,
      recording_id: effect.recording.id,
      stage: 'batch_job',
      reason: 'vendor_reported',
      distinct_id: effect.meeting.id,
    });
  }

  // ⚠⚠ BOTH ARMS, UNCONDITIONALLY (even on a CAS no-op — the cleanup job gates itself, same
  // reason the recording re-arm is unconditional). This is the release valve for §7.4's
  // withheld cleanup: the source was held back while the batch job read it, and the job is
  // now terminal.
  if (effect.recording.status === 'ready') {
    await enqueueBestEffort(
      () =>
        // ⚠ BAL-483 §7.4 — A RE-DRIVE, NOT A FIRST ENQUEUE. This cleanup job may already have
        // run and COMPLETED (withheld by the very batch job this webhook answers) under the
        // Mux-triggered, ROW-keyed jobId (`routes/mux/webhook.ts`). BullMQ retains 100
        // completed jobs per jobId (`lib/queue.ts`), so a re-`add` under that SAME jobId would
        // be silently dropped.
        //
        // ⚠⚠ FIX ROUND 2 — FIX ROUND 1 (M2) decoupled a rejecting `Queue.remove()` from the
        // re-add so the re-add ran unconditionally, but that closed only PART of the leak.
        // `remove()` can reject not just on a transient fault but because the job is ACTIVE —
        // and BullMQ dedups a jobId against a job in ANY state, including `active`, so the
        // unconditional re-add was then SILENTLY DROPPED too. Concretely: Mux reports `ready` →
        // the cleanup job goes ACTIVE and withholds (this batch job was still in flight) → THIS
        // webhook's batch job goes terminal and tries to re-drive → `remove()` rejects (the job
        // is locked) → the re-add runs but dedups against the still-active job under the same
        // jobId and is dropped → that job completes as a no-op on its stale pre-commit read →
        // nothing ever re-drives it, because Mux's `video.asset.ready` fires ONCE. The raw
        // Daily source would leak PERMANENTLY — the same outcome M2 existed to prevent, through
        // a narrower door.
        //
        // THE FIX: key this write's jobId on ITSELF, not on the row — `dedupeToken` is the
        // Daily batch job id, the identity of the write that makes this a re-drive at all,
        // already in scope on `effect.event`. That jobId is disjoint from the Mux-triggered
        // job's bare, row-keyed one, so the active-job dedup this docblock describes cannot
        // reach it. It is also stable across a replayed `batch-processor.job-finished`
        // delivery (same batch job id → same jobId → the SAME re-drive, deduped against
        // itself rather than fired twice). `recordingCleanupSourceJobId`
        // (`jobs/recording-cleanup-source.ts`) is still the ONE definition of the scheme (fix
        // round 1's M5); this call site only supplies the token.
        //
        // `remove()` is gone: there is nothing retained under a jobId this call site never
        // reuses, and a duplicate re-drive is a clean no-op regardless — `handleCleanup`
        // (`jobs/recording-cleanup-source.ts`) short-circuits on `sourceDeletedAt !== null`
        // before it ever touches Daily, which is what makes a write-keyed jobId safe to fire
        // more than once.
        enqueueRecordingCleanupSource({
          recordingId: effect.recording.id,
          dedupeToken: effect.event.batchJobId,
        }),
      { meetingId: effect.meeting.id, recordingId: effect.recording.id },
      log,
      'recording-cleanup-source re-enqueue failed on the Daily batch-processor webhook — best-effort, the delivery still acks'
    );
  }
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

    if (effect?.kind === 'transcript_capture') {
      await handleTranscriptCapturePostCommit(effect, applied);
    }

    log.info(
      { eventId: event.eventId, eventType: event.type, handled: effect !== null },
      'Daily webhook processed'
    );
    return reply.code(200).send({ received: true });
  });
}

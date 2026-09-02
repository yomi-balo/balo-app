/**
 * BAL-483 (§6, §7.3, §8) — `transcript-capture`. ONE queue, TWO job names (`submit` / `ingest`)
 * — the Daily Batch Processor transcription producer feeding BAL-387's shipped pipeline seam.
 *
 * ⚠⚠ NO LIMITER, NO PRIORITY (D3). `recording-capture`'s `DAILY_RECORDING_START_LIMITER` is a
 * WORKER-level limiter (per queue, not per job name); folding this family into that queue would
 * halve its budget and risk `MAX_DAILY_FAILURES_PER_MEETING`, which PERMANENTLY DISABLES
 * recording for a meeting. This is its own queue for exactly that reason — see the
 * `recording-ingest` precedent this mirrors: own queue, own attempts, no limiter, no priority.
 *
 * ⚠⚠ NO RE-ARM, ANYWHERE, EVER (§10 circuit breaker). The batch input is a FIXED, FINISHED
 * artefact — a batch job that fails on it will fail on it again, so nothing here re-submits on
 * `batch-processor.error`. `MAX_DAILY_FAILURES_PER_MEETING` has no analogue because there is no
 * error→retry ARM to bound in the first place. `markTranscriptJobSubmitted`'s CAS on
 * `submitted_at IS NULL` is the sole "exactly once, ever" guarantee.
 *
 * ⚠⚠ jobIds ARE KEYED ON A WRITE, NEVER ON A TARGET STATE:
 *   · `transcript-submit--{recordingId}` — "this segment gets its ONE batch submission", ever.
 *   · `transcript-ingest--{recordingId}` — "this segment gets its ONE transcript", keyed on the
 *     ROW, deliberately NOT on `batchJobId`: in the rare POST-succeeded/stamp-failed duplicate
 *     -submit window (see `handleSubmit`'s docblock) two batch jobs can exist for one recording,
 *     and keying on the row collapses them to one transcript ingest attempt in flight at a time.
 */
import { Worker, UnrecoverableError, type Job } from 'bullmq';
import {
  meetingRecordingsRepository,
  transcriptsRepository,
  type MeetingRecording,
} from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import {
  trackServer,
  TRANSCRIPT_SERVER_EVENTS,
  type TranscriptCaptureSkipReason,
  type TranscriptCaptureFailureStage,
  type TranscriptCaptureFailureReason,
} from '@balo/analytics/server';
import { createRedisConnection } from '../lib/redis.js';
import { getQueue } from '../lib/queue.js';
import { sanitizedErrorMessage } from '../lib/sanitize-error.js';
import {
  BatchArtefactTooLargeError,
  fetchBatchArtefactJson,
  getBatchJobTranscriptLink,
  submitTranscriptBatchJob,
} from '../services/daily/batch-processor.js';
import { DailyApiError, DailyConfigError } from '../services/daily/errors.js';
import { adaptDailyBatchTranscriptJson } from '../services/transcript/normalizers/daily-batch-json.js';
import type { DailyDeepgramTranscriptPayload } from '../services/transcript/normalizers/index.js';
import {
  resolveMeetingEngagement,
  type MeetingEngagementResolution,
} from '../services/meetings/resolve-meeting-engagement.js';
import { enqueueTranscriptPipeline } from './transcript-pipeline.js';

const log = createLogger('transcript-capture');

export const TRANSCRIPT_CAPTURE_QUEUE = 'transcript-capture';

const SUBMIT_ATTEMPTS = 3;
const INGEST_ATTEMPTS = 5;
const BACKOFF_DELAY_MS = 10_000;

/** ⚠ A WARN, not a refusal — truncating a transcript is worse than a fat Redis job. It is the
 *  signal that the payload-size arithmetic in plan §9 has stopped holding. */
export const ADAPTED_PAYLOAD_WARN_BYTES = 1_000_000;

export interface TranscriptCaptureSubmitJobData {
  recordingId: string;
}
export interface TranscriptCaptureIngestJobData {
  recordingId: string;
  batchJobId: string;
}
export type TranscriptCaptureJobData =
  | TranscriptCaptureSubmitJobData
  | TranscriptCaptureIngestJobData;

export interface EnqueueTranscriptSubmitInput {
  recordingId: string;
}

/** The write is "this segment gets its ONE batch submission" — once per row, ever. */
export async function enqueueTranscriptSubmit(input: EnqueueTranscriptSubmitInput): Promise<void> {
  await getQueue(TRANSCRIPT_CAPTURE_QUEUE).add(
    'submit',
    { recordingId: input.recordingId } satisfies TranscriptCaptureSubmitJobData,
    {
      jobId: `transcript-submit--${input.recordingId}`,
      attempts: SUBMIT_ATTEMPTS,
      backoff: { type: 'exponential', delay: BACKOFF_DELAY_MS },
    }
  );
}

export interface EnqueueTranscriptIngestInput {
  recordingId: string;
  batchJobId: string;
}

/** The write is "this segment gets its ONE transcript" — keyed on the ROW, not `batchJobId`. */
export async function enqueueTranscriptIngest(input: EnqueueTranscriptIngestInput): Promise<void> {
  await getQueue(TRANSCRIPT_CAPTURE_QUEUE).add(
    'ingest',
    {
      recordingId: input.recordingId,
      batchJobId: input.batchJobId,
    } satisfies TranscriptCaptureIngestJobData,
    {
      jobId: `transcript-ingest--${input.recordingId}`,
      attempts: INGEST_ATTEMPTS,
      backoff: { type: 'exponential', delay: BACKOFF_DELAY_MS },
    }
  );
}

/**
 * BAL-483 — a distinguishable terminal error carrying the analytics `reason`, mirroring
 * `recording-ingest.ts`'s `IngestUnrecoverableError`: `UnrecoverableError`'s own constructor
 * takes only a message, so wrapping is what lets `worker.on('failed')` recover the RIGHT reason
 * instead of re-deriving it from a message string.
 */
class TranscriptCaptureUnrecoverableError extends UnrecoverableError {
  constructor(
    message: string,
    public readonly reason: TranscriptCaptureFailureReason
  ) {
    super(message);
    this.name = 'TranscriptCaptureUnrecoverableError';
  }
}

/** D4's `MeetingEngagementResolution` outcome → the closed analytics reason + log level. */
const SKIP_REASON_BY_OUTCOME: Record<
  Exclude<MeetingEngagementResolution['outcome'], 'resolved'>,
  TranscriptCaptureSkipReason
> = {
  no_engagement_context: 'no_engagement_context',
  ambiguous_context: 'ambiguous_context',
  engagement_missing: 'engagement_missing',
  meeting_not_found: 'meeting_missing',
};

/** `no_engagement_context` is EXPECTED and ROUTINE (§5.2) — `info`. The other three are
 *  integrity signals — `warn`. */
const SKIP_LEVEL_BY_OUTCOME: Record<
  Exclude<MeetingEngagementResolution['outcome'], 'resolved'>,
  'info' | 'warn'
> = {
  no_engagement_context: 'info',
  ambiguous_context: 'warn',
  engagement_missing: 'warn',
  meeting_not_found: 'warn',
};

/** A clean, logged, analytics-visible no-op — never a failure, never a throw. `message` defaults
 *  to the D4 submit-gate wording; a caller skipping for a DIFFERENT reason (e.g. M1's empty-
 *  transcript guard, at ingest) supplies its own so the log line stays accurate. */
async function skip(input: {
  recordingId: string;
  meetingId: string;
  reason: TranscriptCaptureSkipReason;
  level: 'info' | 'warn';
  message?: string;
}): Promise<void> {
  const fields = {
    recordingId: input.recordingId,
    meetingId: input.meetingId,
    reason: input.reason,
  };
  const message =
    input.message ?? 'transcript-capture: skipped — no batch job submitted (BAL-483 D4)';
  if (input.level === 'warn') {
    log.warn(fields, message);
  } else {
    log.info(fields, message);
  }
  trackServer(TRANSCRIPT_SERVER_EVENTS.TRANSCRIPT_CAPTURE_SKIPPED, {
    meeting_id: input.meetingId,
    recording_id: input.recordingId,
    reason: input.reason,
    distinct_id: input.meetingId,
  });
}

async function skipForEngagementGate(
  recordingId: string,
  meetingId: string,
  outcome: Exclude<MeetingEngagementResolution['outcome'], 'resolved'>
): Promise<void> {
  await skip({
    recordingId,
    meetingId,
    reason: SKIP_REASON_BY_OUTCOME[outcome],
    level: SKIP_LEVEL_BY_OUTCOME[outcome],
  });
}

/**
 * `submit` — claim ONE Daily batch-processor `transcript` job for this recording segment.
 *
 * ⚠ THE ONE ACCEPTED WINDOW, STATED NOT FIXED: the POST succeeds and
 * `markTranscriptJobSubmitted` then fails (a DB blip). BullMQ retries,
 * `transcript_job_submitted_at` is still NULL, and a SECOND batch job is created — a second
 * transcript for that segment. Bounded by {@link SUBMIT_ATTEMPTS}, requires a DB failure inside
 * a ~100ms window, and is exactly the shape and severity BAL-473 already accepted for the
 * orphaned-Mux-asset window (`recording-ingest.ts`). The alternative — claiming the slot BEFORE
 * the POST — trades this for a strictly worse failure: a POST that throws would leave the slot
 * claimed forever and the segment permanently untranscribed.
 */
async function handleSubmit(job: Job<TranscriptCaptureSubmitJobData>): Promise<void> {
  const { recordingId } = job.data;

  const row = await meetingRecordingsRepository.findById(recordingId);
  if (row === undefined) {
    log.info({ recordingId }, 'transcript-capture submit: no live row — no-op');
    return;
  }
  if (row.transcriptJobSubmittedAt !== null) {
    log.info({ recordingId }, 'transcript-capture submit: already submitted — no-op');
    return;
  }
  if (row.dailyRecordingId === null || row.sourceDeletedAt !== null) {
    await skip({
      recordingId: row.id,
      meetingId: row.meetingId,
      reason: 'no_daily_source',
      level: 'warn',
    });
    return;
  }

  // D4 — the engagement gate. A non-engagement meeting is a CLEAN no-op, never a failure, and
  // NO batch job is submitted (no vendor spend, no webhook that resolves to nothing).
  const resolution = await resolveMeetingEngagement(row.meetingId);
  if (resolution.outcome !== 'resolved') {
    await skipForEngagementGate(row.id, row.meetingId, resolution.outcome);
    return;
  }

  let batchJobId: string;
  try {
    batchJobId = await submitTranscriptBatchJob({ dailyRecordingId: row.dailyRecordingId });
  } catch (error) {
    if (error instanceof DailyConfigError) {
      throw new TranscriptCaptureUnrecoverableError(sanitizedErrorMessage(error), 'config_error');
    }
    if (
      error instanceof DailyApiError &&
      error.status >= 400 &&
      error.status < 500 &&
      error.status !== 429
    ) {
      throw new TranscriptCaptureUnrecoverableError(
        sanitizedErrorMessage(error),
        'daily_api_error'
      );
    }
    throw error;
  }

  let updated: MeetingRecording | undefined;
  try {
    updated = await meetingRecordingsRepository.markTranscriptJobSubmitted({
      id: row.id,
      transcriptJobId: batchJobId,
      at: new Date(),
    });
  } catch (error) {
    // ⚠⚠ THE ACCEPTED WINDOW (§7.3/§7.4), MADE VISIBLE — DBA flag. The Daily POST above
    // SUCCEEDED, so a batch job now exists at the vendor, but the write that would record it
    // just failed. Until a retry re-stamps (or gives up), `transcript_job_submitted_at` stays
    // NULL — the ONE window `recording-cleanup-source`'s BAL-483 withhold gate CANNOT see, so
    // it can delete the Daily source out from under this in-flight job. Logged loudly here
    // rather than left to a generic retry log, because this is exactly the residual the
    // withhold gate does not cover.
    log.warn(
      {
        recordingId: row.id,
        orphanedBatchJobId: batchJobId,
        error: sanitizedErrorMessage(error),
      },
      'transcript-capture submit: the Daily batch job was created but the submitted_at stamp failed — recording-cleanup-source will NOT withhold for it until a retry re-stamps it'
    );
    throw error;
  }
  if (updated === undefined) {
    // ⚠ A CONCURRENT JOB WON THE CAS. The batch job we just created is an ORPHAN nothing
    // points at — log its id so ops can reconcile, exactly as `recording-ingest.ts` does for
    // an orphaned Mux asset. Not an error; do not retry.
    log.error(
      { recordingId: row.id, orphanedBatchJobId: batchJobId },
      'transcript-capture submit: markTranscriptJobSubmitted lost the race — an orphaned Daily batch job exists'
    );
    return;
  }

  trackServer(TRANSCRIPT_SERVER_EVENTS.TRANSCRIPT_CAPTURE_SUBMITTED, {
    meeting_id: row.meetingId,
    recording_id: row.id,
    duration_seconds: row.durationSeconds,
    distinct_id: row.meetingId,
  });
  // ⚠ NEVER the batch job id in a happy-path log — a vendor handle, and the row already holds it.
  log.info(
    { recordingId: row.id, meetingId: row.meetingId },
    'transcript-capture: batch job submitted'
  );
}

/** `getBatchJobTranscriptLink`'s classification: 404 (unknown job) is terminal; 400 (not yet
 *  finished — a race with the webhook) and everything else retries. */
function classifyAccessLinkError(error: unknown): unknown {
  if (error instanceof DailyConfigError) {
    return new TranscriptCaptureUnrecoverableError(sanitizedErrorMessage(error), 'config_error');
  }
  if (error instanceof DailyApiError && error.status === 404) {
    return new TranscriptCaptureUnrecoverableError(sanitizedErrorMessage(error), 'daily_api_error');
  }
  return error;
}

/** `fetchBatchArtefactJson`'s classification: the size cap and an unparseable body are
 *  terminal; a non-2xx / timeout against the signed S3 URL always retries (a fresh link is
 *  re-minted on every attempt, so a transient fault is worth one more try). */
function classifyArtefactFetchError(error: unknown): unknown {
  if (error instanceof BatchArtefactTooLargeError) {
    return new TranscriptCaptureUnrecoverableError(
      sanitizedErrorMessage(error),
      'artefact_too_large'
    );
  }
  if (error instanceof SyntaxError) {
    return new TranscriptCaptureUnrecoverableError(
      sanitizedErrorMessage(error),
      'artefact_unreadable'
    );
  }
  return error;
}

/**
 * `ingest` — mint the batch job's access link, fetch + adapt the artefact, and hand it to
 * BAL-387's shipped `enqueueTranscriptPipeline` seam.
 *
 * ⚠⚠ THE ACCESS LINK IS MINTED INSIDE THIS HANDLER, ON EVERY ATTEMPT — never at webhook time,
 * never carried across a retry, never logged. No TTL is documented and no `expires` field is
 * returned (contrast the recording access link), so a carried link is a link with an unknown
 * remaining life.
 */
async function handleIngest(job: Job<TranscriptCaptureIngestJobData>): Promise<void> {
  const { recordingId, batchJobId } = job.data;

  const row = await meetingRecordingsRepository.findById(recordingId);
  if (row === undefined) {
    log.info({ recordingId }, 'transcript-capture ingest: no live row — no-op');
    return;
  }

  const captureId = `daily-batch:${batchJobId}`;
  const existing = await transcriptsRepository.findByCaptureId(captureId);
  if (existing !== undefined) {
    log.info({ recordingId, captureId }, 'transcript-capture ingest: already ingested — no-op');
    return;
  }

  // Defensive re-check — see the module docblock. `findPrimaryMeetingContextRepoint` refuses a
  // repoint, so this should be unreachable in practice; a non-`resolved` outcome here is still
  // a clean no-op rather than a failure.
  const resolution = await resolveMeetingEngagement(row.meetingId);
  if (resolution.outcome !== 'resolved') {
    await skipForEngagementGate(row.id, row.meetingId, resolution.outcome);
    return;
  }

  let link: string;
  try {
    link = await getBatchJobTranscriptLink(batchJobId, 'json');
  } catch (error) {
    throw classifyAccessLinkError(error);
  }
  log.info({ recordingId: row.id }, 'transcript-capture ingest: access link minted');

  let raw: unknown;
  try {
    raw = await fetchBatchArtefactJson(link);
  } catch (error) {
    throw classifyArtefactFetchError(error);
  }

  let payload: DailyDeepgramTranscriptPayload;
  try {
    payload = adaptDailyBatchTranscriptJson(raw);
  } catch (error) {
    throw new TranscriptCaptureUnrecoverableError(
      error instanceof Error ? error.message : String(error),
      'artefact_unreadable'
    );
  }

  const payloadBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  if (payloadBytes > ADAPTED_PAYLOAD_WARN_BYTES) {
    log.warn(
      { recordingId: row.id, bytes: payloadBytes },
      'transcript-capture ingest: adapted payload over the warn threshold'
    );
  }

  // ⚠⚠ FIX ROUND 1 (M1) — AN EMPTY TRANSCRIPT MUST NEVER REACH THE PIPELINE. The R3
  // fragmentation shape: `MIN_IDLE_TIMEOUT_SECONDS` auto-stops a segment, the unconditional
  // re-arm starts a second, and participants rejoin and hang up before saying anything.
  // Deepgram returns zero words either way `adaptDailyBatchTranscriptJson` folds them
  // (`utterances: []`). Enqueuing anyway would burn two real Anthropic calls on empty text
  // (BAL-387 stages 3–4) and stage 6 would publish `recap.ready` — an EMPTY recap email to
  // BOTH parties, on a publish that has never fired in production before. Terminal no-op, not
  // a failure: never throw, never retry.
  if (payload.utterances.length === 0) {
    await skip({
      recordingId: row.id,
      meetingId: row.meetingId,
      reason: 'empty_transcript',
      level: 'warn',
      message:
        'transcript-capture ingest: skipped — Deepgram returned zero utterances (BAL-483 fix round 1 M1)',
    });
    return;
  }

  await enqueueTranscriptPipeline({
    captureId,
    engagementId: resolution.engagementId,
    meetingId: row.meetingId,
    vendor: 'daily_deepgram',
    payload,
    durationMs:
      payload.durationSeconds === null ? null : Math.round(payload.durationSeconds * 1000),
  });

  log.info(
    { recordingId: row.id, meetingId: row.meetingId, segmentCount: payload.utterances.length },
    'transcript-capture: pipeline enqueued'
  );
}

/** `TranscriptCaptureUnrecoverableError` carries the right reason; anything else that exhausted
 *  its retries falls back to `'unknown'`. */
function classifyFailureReason(err: unknown): TranscriptCaptureFailureReason {
  if (err instanceof TranscriptCaptureUnrecoverableError) {
    return err.reason;
  }
  return 'unknown';
}

/**
 * Best-effort terminal-failure reporting, mirroring `recording-ingest.ts`'s
 * `reportIngestFailure`. Looks up the row's `meetingId` for the analytics event —
 * `TRANSCRIPT_CAPTURE_FAILED` is typed on `meeting_id`, never a `meeting_recordings.id`, and
 * the job's own data carries only `recordingId`.
 */
async function reportCaptureFailure(
  recordingId: string,
  stage: TranscriptCaptureFailureStage,
  err: unknown
): Promise<void> {
  const row = await meetingRecordingsRepository.findById(recordingId).catch(() => undefined);
  // ⚠⚠ FIX ROUND 1 (M8) — STAMP THE ROW, mirroring `recording-ingest.ts`'s `reportIngestFailure`
  // (`markFailed({ id: recordingId, ... })`, called on `recordingId` itself, BEFORE the row
  // lookup is even checked). Without this, a terminal capture failure left NOTHING durable on
  // `meeting_recordings`, so an ops audit could not tell "this segment's capture failed" apart
  // from "this segment never got that far". Sanitized (`lib/sanitize-error.ts`) — an artefact-
  // fetch or Daily error can echo a signed URL.
  //
  // ⚠ FOR THE 'artefact_fetch' STAGE THIS CAS TYPICALLY NO-OPS, AND THAT IS CORRECT, NOT A BUG:
  // by the time `ingest` ever runs, `transcript_job_finished_at` is already stamped by the
  // `batch-processor.job-finished` webhook (first-terminal-wins — see `markTranscriptJobFailed`'s
  // own docblock), so this write protects Daily's own SUCCESS stamp from being overwritten by
  // OUR post-processing failure. It reliably closes the gap for a terminal 'batch_submit'
  // failure, where `finished_at` is genuinely still NULL.
  await meetingRecordingsRepository
    .markTranscriptJobFailed({
      id: recordingId,
      reason: sanitizedErrorMessage(err),
      at: new Date(),
    })
    .catch(() => undefined);
  if (row === undefined) {
    log.error(
      { recordingId, stage },
      'transcript-capture: terminal failure but the row could not be resolved — no transcript_capture_failed emitted'
    );
    return;
  }
  trackServer(TRANSCRIPT_SERVER_EVENTS.TRANSCRIPT_CAPTURE_FAILED, {
    meeting_id: row.meetingId,
    recording_id: row.id,
    stage,
    reason: classifyFailureReason(err),
    distinct_id: row.meetingId,
  });
}

/** Start the `transcript-capture` worker — event-triggered, no cron. Dispatches on `job.name`.
 *  ⚠ NO `limiter` OPTION, DELIBERATELY (D3) — see the module docblock. */
export function startTranscriptCaptureWorker(): Worker<TranscriptCaptureJobData> {
  const worker = new Worker<TranscriptCaptureJobData>(
    TRANSCRIPT_CAPTURE_QUEUE,
    async (job) => {
      if (job.name === 'submit') {
        await handleSubmit(job as Job<TranscriptCaptureSubmitJobData>);
        return;
      }
      if (job.name === 'ingest') {
        await handleIngest(job as Job<TranscriptCaptureIngestJobData>);
        return;
      }
      // Defensive: no other job name is ever enqueued onto this queue.
      log.error(
        { jobName: job.name },
        'transcript-capture: unknown job name — acking with no effect'
      );
    },
    { connection: createRedisConnection(), concurrency: 5 }
  );

  worker.on('failed', (job, err) => {
    if (!job) {
      return;
    }
    const defaultAttempts = job.name === 'submit' ? SUBMIT_ATTEMPTS : INGEST_ATTEMPTS;
    const attempts = job.opts.attempts ?? defaultAttempts;
    const terminal = err instanceof UnrecoverableError || job.attemptsMade >= attempts;
    if (!terminal) {
      return;
    }
    const { recordingId } = job.data;
    log.error(
      { recordingId, error: sanitizedErrorMessage(err) },
      'transcript-capture: exhausted retries'
    );
    const stage: TranscriptCaptureFailureStage =
      job.name === 'submit' ? 'batch_submit' : 'artefact_fetch';
    reportCaptureFailure(recordingId, stage, err).catch(() => undefined);
  });

  return worker;
}

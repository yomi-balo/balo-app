/**
 * BAL-473 (§6.3) — `recording-ingest`. Fetches the Daily source's short-lived access link and
 * hands it to Mux as a signed asset. ONE job per `meeting_recordings` row.
 *
 * ⚠⚠ THE ACCESS LINK IS MINTED INSIDE THIS HANDLER, ON EVERY ATTEMPT — never at webhook time,
 * never carried across a retry. It is short-lived; a stale one handed to Mux fails the ingest
 * with no recovery but a fresh mint.
 */
import { Worker, UnrecoverableError, type Job } from 'bullmq';
import { meetingRecordingsRepository } from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import {
  trackServer,
  RECORDING_SERVER_EVENTS,
  type RecordingFailureReason,
} from '@balo/analytics/server';
import { createRedisConnection } from '../lib/redis.js';
import { getQueue } from '../lib/queue.js';
import { sanitizedErrorMessage } from '../lib/sanitize-error.js';
import { getRecordingAccessLink } from '../services/daily/recordings.js';
import { createSignedAssetFromUrl, type CreatedMuxAsset } from '../services/mux/assets.js';
import { isRetryableMuxError, MuxConfigError } from '../services/mux/errors.js';

const log = createLogger('recording-ingest');

/**
 * BAL-473 FIX ROUND 1 (F7) — carries the ANALYTICS REASON alongside the terminal throw, computed
 * at the point the ORIGINAL vendor error is still in hand. `UnrecoverableError`'s own constructor
 * takes only a message, so wrapping loses `instanceof MuxConfigError` / `isRetryableMuxError`'s
 * verdict by the time `worker.on('failed')` sees it — this subclass is what lets
 * `reportIngestFailure` recover the RIGHT reason instead of re-deriving it from a message string.
 */
class IngestUnrecoverableError extends UnrecoverableError {
  constructor(
    message: string,
    public readonly reason: RecordingFailureReason
  ) {
    super(message);
    this.name = 'IngestUnrecoverableError';
  }
}

export const RECORDING_INGEST_QUEUE = 'recording-ingest';

const ATTEMPTS = 5;
const BACKOFF_DELAY_MS = 10_000;

export interface RecordingIngestJobData {
  recordingId: string;
}

export interface EnqueueRecordingIngestInput {
  recordingId: string;
}

/**
 * ⚠ jobId IS `meeting_recordings.id` — the row, NOT the Daily recording id the ticket names.
 * Our id is always present the moment the row exists; the Daily id may only have arrived by
 * the room-name fallback. One ingest per ROW is one write.
 *
 * ⚠ OPS RE-DRIVE CAVEAT (runbook-load-bearing): because completed and failed jobs are
 * RETAINED, a plain re-`add` under the same jobId is SILENTLY DROPPED. Re-driving a `failed`
 * row requires `await getQueue('recording-ingest').remove('recording-ingest--<id>')` first.
 */
export async function enqueueRecordingIngest(input: EnqueueRecordingIngestInput): Promise<void> {
  await getQueue(RECORDING_INGEST_QUEUE).add(
    'ingest',
    { recordingId: input.recordingId } satisfies RecordingIngestJobData,
    {
      jobId: `recording-ingest--${input.recordingId}`,
      attempts: ATTEMPTS,
      backoff: { type: 'exponential', delay: BACKOFF_DELAY_MS },
    }
  );
}

async function handleIngest(job: Job<RecordingIngestJobData>): Promise<void> {
  const { recordingId } = job.data;

  const row = await meetingRecordingsRepository.findById(recordingId);
  if (row === undefined) {
    log.info({ recordingId }, 'recording-ingest: no live row — no-op');
    return;
  }

  // Idempotency: a concurrent/earlier attempt already stamped the asset, or the row is already
  // terminal-success.
  if (row.muxAssetId !== null || row.status === 'ready') {
    log.info({ recordingId }, 'recording-ingest: already ingested — no-op');
    return;
  }

  if (row.status !== 'source_ready') {
    throw new UnrecoverableError(
      `recording ${recordingId} is not source_ready (status=${row.status})`
    );
  }
  if (row.dailyRecordingId === null) {
    throw new UnrecoverableError(`recording ${recordingId} has no daily_recording_id to fetch`);
  }

  let downloadLink: string;
  let expiresAt: Date;
  let asset: CreatedMuxAsset;
  try {
    // ⚠ MINTED HERE, ON EVERY ATTEMPT. Log `expiresAt` — NEVER `downloadLink`.
    ({ downloadLink, expiresAt } = await getRecordingAccessLink(row.dailyRecordingId));
    log.info(
      { recordingId, expiresAt: expiresAt.toISOString() },
      'recording-ingest: access link minted'
    );
    asset = await createSignedAssetFromUrl({ url: downloadLink, passthrough: row.id });
  } catch (error) {
    // ⚠⚠ FIX ROUND 1 (F7) — WITHOUT THIS, A PERMANENT MUX 4XX BURNED ALL 5 ATTEMPTS ACROSS
    // ~2.5 MINUTES, RE-MINTING A FRESH DAILY ACCESS LINK EVERY TIME — `isRetryableMuxError` was
    // consumed only as an analytics label, never for control flow. `MuxConfigError` (no
    // `status`) is caught FIRST and explicitly, because `isRetryableMuxError` alone would
    // otherwise label an unset `MUX_TOKEN_ID` `mux_api_error` and retry it exactly like a
    // transient fault.
    if (error instanceof MuxConfigError) {
      throw new IngestUnrecoverableError(sanitizedErrorMessage(error), 'config_error');
    }
    if (!isRetryableMuxError(error)) {
      throw new IngestUnrecoverableError(sanitizedErrorMessage(error), 'unknown');
    }
    throw error;
  }

  const updated = await meetingRecordingsRepository.markIngesting({
    id: row.id,
    muxAssetId: asset.id,
  });
  if (updated === undefined) {
    // ⚠ A CONCURRENT JOB ALREADY STAMPED. The recording is NOT lost — `passthrough` is on the
    // asset, so `video.asset.ready` resolves it by `passthrough` regardless. But an orphan Mux
    // asset now exists that nothing points at; log its id so ops can reconcile or delete it.
    log.error(
      { recordingId, orphanedMuxAssetId: asset.id },
      'recording-ingest: markIngesting lost the race — an orphaned Mux asset exists'
    );
    return;
  }
  // ⚠⚠ FIX ROUND 1 (F4) — THE HAPPY-PATH `muxAssetId` LOG WAS DROPPED HERE, DELIBERATELY. It
  // logged nothing `markIngesting`'s own return value (checked above) doesn't already prove —
  // the row was just written two lines up — and the review flagged it as one more place a Mux
  // API delete-handle would otherwise sit in a log line for no operational reason.
}

/**
 * Best-effort terminal-failure reporting (the BAL-387 `markFailedForCapture` shape). Looks up
 * the row's `meetingId` for the analytics event — `RECORDING_FAILED` is typed on `meeting_id`,
 * never a `meeting_recordings.id`, and the job's own data carries only `recordingId`.
 */
async function reportIngestFailure(recordingId: string, err: unknown): Promise<void> {
  const row = await meetingRecordingsRepository.findById(recordingId).catch(() => undefined);
  // ⚠⚠ FIX ROUND 1 (F4) — SANITIZED, never a raw vendor error. See `lib/sanitize-error.ts`'s
  // docblock: a rejected `assets.create` can echo the live Daily signed access link.
  const sanitizedReason = sanitizedErrorMessage(err);
  // ⚠ THE DAILY SOURCE IS DELIBERATELY NOT DELETED (D4) — it is the only thing a re-drive can
  // retry from.
  await meetingRecordingsRepository
    .markFailed({ id: recordingId, stage: 'mux_ingest', reason: sanitizedReason, at: new Date() })
    .catch(() => undefined);

  if (row === undefined) {
    // ⚠⚠ FIX ROUND 1 (F12) — `row?.meetingId ?? recordingId` used to send
    // `meeting_recordings.id` as PostHog's `meeting_id` AND `distinct_id` when the row could
    // not be resolved, creating a person profile keyed on a recording id and corrupting the
    // metric §11 exists to answer. Skip the event; the DB write above and this log are the
    // record of what happened.
    log.error(
      { recordingId },
      'recording-ingest: terminal failure but the row could not be resolved — no recording_failed emitted'
    );
    return;
  }
  trackServer(RECORDING_SERVER_EVENTS.RECORDING_FAILED, {
    meeting_id: row.meetingId,
    stage: 'mux_ingest',
    reason: classifyFailureReason(err),
    distinct_id: row.meetingId,
  });
}

/**
 * The analytics `reason` for a terminal ingest failure. `IngestUnrecoverableError` (F7) already
 * carries the RIGHT answer, computed at the point the original vendor error was still in hand;
 * an error that exhausted its retries unwrapped falls back to the pre-fix-round classification.
 *
 * ⚠ NOT A NESTED TERNARY (SonarCloud S3358) — a lookup would need a runtime discriminant this
 * function doesn't have (whether `err` IS the reason or must be CLASSIFIED into one), so this
 * is an early-return ladder instead.
 */
function classifyFailureReason(err: unknown): RecordingFailureReason {
  if (err instanceof IngestUnrecoverableError) {
    return err.reason;
  }
  if (isRetryableMuxError(err)) {
    return 'mux_api_error';
  }
  return 'unknown';
}

export function startRecordingIngestWorker(): Worker<RecordingIngestJobData> {
  const worker = new Worker<RecordingIngestJobData>(
    RECORDING_INGEST_QUEUE,
    async (job) => handleIngest(job),
    { connection: createRedisConnection(), concurrency: 5 }
  );

  worker.on('failed', (job, err) => {
    if (!job) {
      return;
    }
    const attempts = job.opts.attempts ?? ATTEMPTS;
    const terminal = err instanceof UnrecoverableError || job.attemptsMade >= attempts;
    if (!terminal) {
      return;
    }
    const { recordingId } = job.data;
    log.error(
      { recordingId, error: sanitizedErrorMessage(err) },
      'recording-ingest: exhausted retries'
    );
    reportIngestFailure(recordingId, err).catch(() => undefined);
  });

  return worker;
}

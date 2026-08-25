/**
 * BAL-473 (§6.1/§6.2) — `recording-capture`. ONE queue, TWO job names (`ensure` / `stop`) —
 * they share the Daily REST seam, the meeting lookup, and the retry posture, so BullMQ
 * dispatches on `job.name` rather than splitting into two queues.
 *
 * ⚠⚠ EVERY jobId BELOW IS KEYED ON A WRITE, NEVER ON A TARGET STATE (memory
 * `reference_bullmq_jobid_must_be_per_write_not_per_state`). `getQueue`'s defaults retain
 * completed jobs (`removeOnComplete: { count: 100 }`), so a re-`add` under a state-shaped
 * jobId is SILENTLY DROPPED. `ensure`'s dedupe token is the Daily event id (webhook origin) or
 * a per-minute sweep bucket (sweep origin) — never the bare `meetingId` alone, because
 * "rejoin after empty" is LITERALLY a return to a previous state.
 */
import { Worker, UnrecoverableError, type Job } from 'bullmq';
import {
  meetingsRepository,
  meetingPresenceRepository,
  meetingRecordingsRepository,
} from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import {
  trackServer,
  RECORDING_SERVER_EVENTS,
  type RecordingTrigger,
} from '@balo/analytics/server';
import { createRedisConnection } from '../lib/redis.js';
import { getQueue } from '../lib/queue.js';
import { startRoomRecording, stopRoomRecording } from '../services/daily/recordings.js';
import { DailyApiError } from '../services/daily/errors.js';

const log = createLogger('recording-capture');

export const RECORDING_CAPTURE_QUEUE = 'recording-capture';

const ATTEMPTS = 3;
const BACKOFF_DELAY_MS = 5_000;

export interface RecordingEnsureJobData {
  meetingId: string;
  trigger: RecordingTrigger;
}
export interface RecordingStopJobData {
  meetingId: string;
}
export type RecordingCaptureJobData = RecordingEnsureJobData | RecordingStopJobData;

export interface EnqueueRecordingEnsureInput {
  meetingId: string;
  trigger: RecordingTrigger;
  /**
   * The Daily webhook event id (unique forever, never revisited) when the enqueue originates
   * in the webhook, or `` `sweep-${Math.floor(now.getTime() / 60_000)}` `` from the per-minute
   * lifecycle sweep (monotonic, so repeated ticks within one minute collapse to one ensure).
   */
  dedupeToken: string;
}

/**
 * Enqueue `ensure` — "make sure this meeting is (still) being captured". Idempotent by THREE
 * independent layers: (a) the BullMQ jobId collapses repeated enqueues from the same trigger;
 * (b) the row check inside the handler catches a second trigger that arrives after the first
 * committed; (c) the partial-unique `meeting_recording_capturing_idx` is the REAL gate — two
 * ensures that both pass the row check concurrently cannot both insert, and the loser gets a
 * clean `undefined`.
 */
export async function enqueueRecordingEnsure(input: EnqueueRecordingEnsureInput): Promise<void> {
  await getQueue(RECORDING_CAPTURE_QUEUE).add(
    'ensure',
    { meetingId: input.meetingId, trigger: input.trigger } satisfies RecordingEnsureJobData,
    {
      jobId: `recording-ensure--${input.meetingId}--${input.dedupeToken}`,
      attempts: ATTEMPTS,
      backoff: { type: 'exponential', delay: BACKOFF_DELAY_MS },
    }
  );
}

export interface EnqueueRecordingStopInput {
  meetingId: string;
}

/**
 * Enqueue `stop`. Per-write, not per-state: `meetingsRepository.endMeeting` is a
 * compare-and-set that returns `undefined` on a second attempt and both call sites (
 * `end-meeting.ts`, `meeting-lifecycle-sweep.ts`) enqueue only on the winning branch — a
 * meeting reaches `ended` EXACTLY ONCE, so `recording-stop--${meetingId}` alone is safe here
 * (unlike `ensure`, there is no "return to a previous state" for a terminal transition).
 */
export async function enqueueRecordingStop(input: EnqueueRecordingStopInput): Promise<void> {
  await getQueue(RECORDING_CAPTURE_QUEUE).add(
    'stop',
    { meetingId: input.meetingId } satisfies RecordingStopJobData,
    {
      jobId: `recording-stop--${input.meetingId}`,
      attempts: ATTEMPTS,
      backoff: { type: 'exponential', delay: BACKOFF_DELAY_MS },
    }
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * ⚠⚠ FIX ROUND 1 (F8) — how long a `recording` row may sit with `dailyRecordingId === null`
 * before `handleEnsure`'s step 5 treats it as STUCK rather than merely "still capturing".
 * Chosen well above the ordinary Daily round trip (`startRoomRecording` + the
 * `recording.started` webhook typically land in well under a second) so a genuine in-flight
 * capture is never misreported.
 */
const STUCK_CAPTURE_THRESHOLD_MS = 2 * 60_000;

/**
 * Non-retryable per `rooms.ts`'s Daily 4xx rule, restated: any 4xx OTHER THAN 429 is a config
 * or payload bug, not a transient fault — retrying it changes nothing.
 */
function isUnrecoverableDailyError(error: unknown): boolean {
  return error instanceof DailyApiError && error.status !== 429 && error.status < 500;
}

/**
 * `ensure` — plan §6.1's ladder, every gate a successful no-op.
 */
async function handleEnsure(job: Job<RecordingEnsureJobData>): Promise<void> {
  const { meetingId, trigger } = job.data;

  // 1. Absent / soft-deleted / terminal → no-op.
  const meeting = await meetingsRepository.findById(meetingId);
  if (meeting === undefined) {
    log.info({ meetingId }, 'recording-ensure: no live meeting — no-op');
    return;
  }
  if (meeting.status === 'ended' || meeting.status === 'cancelled') {
    log.info(
      { meetingId, status: meeting.status },
      'recording-ensure: meeting is terminal — no-op'
    );
    return;
  }

  // 2. No venue (OD-11: daily_room_name is nullable).
  if (meeting.dailyRoomName === null) {
    log.warn({ meetingId }, 'recording-ensure: meeting has no venue — no-op');
    return;
  }

  // 3. D1 — the recording is the billable session's record.
  if (meeting.status !== 'in_progress') {
    log.info(
      { meetingId, status: meeting.status },
      'recording-ensure: meeting is not in_progress — no-op'
    );
    return;
  }

  // 4. Never start a recording into an empty room.
  const open = await meetingPresenceRepository.listOpen(meetingId);
  if (open.length === 0) {
    log.info({ meetingId }, 'recording-ensure: room is empty — no-op');
    return;
  }

  // 5. A segment is already capturing.
  const capturing = await meetingRecordingsRepository.findCapturingForMeeting(meetingId);
  if (capturing !== undefined) {
    // ⚠⚠ FIX ROUND 1 (F8) — A WORKER CAN DIE BETWEEN `insertCapturing` COMMITTING AND THE
    // DAILY CALL RETURNING (a deploy, an OOM). The row this branch found may be exactly that:
    // `dailyRecordingId` still NULL, and no Daily event will EVER arrive for it, since Daily
    // was never actually asked to start it. Left at `log.info`, every later ensure for this
    // meeting no-ops FOREVER against a segment that never recorded anything — silently, with
    // no signal anywhere. `createdAt` older than the threshold is what distinguishes this from
    // the ordinary (sub-second) window between insert and the Daily call returning.
    const stuck =
      capturing.dailyRecordingId === null &&
      Date.now() - capturing.createdAt.getTime() > STUCK_CAPTURE_THRESHOLD_MS;
    if (stuck) {
      log.error(
        {
          meetingId,
          recordingId: capturing.id,
          createdAt: capturing.createdAt.toISOString(),
        },
        'recording-ensure: capture slot held by a segment Daily never acknowledged — a worker likely died between insert and the Daily call (see schema docblock, second residual)'
      );
      return;
    }
    log.info(
      { meetingId, recordingId: capturing.id },
      'recording-ensure: already_capturing — no-op'
    );
    return;
  }

  // 6. THE REAL GATE — a concurrent ensure can still win the unique index here.
  const row = await meetingRecordingsRepository.insertCapturing({ meetingId });
  if (row === undefined) {
    log.info({ meetingId }, 'recording-ensure: lost the capturing-slot race — no-op');
    return;
  }

  // 7. The Daily start call.
  try {
    await startRoomRecording(meeting.dailyRoomName, { instanceId: row.id });
    trackServer(RECORDING_SERVER_EVENTS.RECORDING_STARTED, {
      meeting_id: meetingId,
      trigger,
      distinct_id: meetingId,
    });
    log.info(
      { meetingId, recordingId: row.id, trigger },
      'recording-ensure: Daily recording started'
    );
  } catch (error) {
    // ⚠⚠ §5.1b — STAMP `failed` IMMEDIATELY, IN THIS INVOCATION, BEFORE RETHROWING. Leaving the
    // row at `recording` would hold the meeting's capture slot forever (capture_ended_at stays
    // NULL), so every subsequent ensure — including THIS job's own BullMQ retry — would find a
    // capturing row and no-op, and the meeting would silently never record.
    const dailyErrorPrefix = error instanceof DailyApiError ? `Daily ${error.status}: ` : '';
    await meetingRecordingsRepository.markFailed({
      id: row.id,
      stage: 'daily',
      reason: `${dailyErrorPrefix}${errorMessage(error)}`,
      at: new Date(),
    });
    if (isUnrecoverableDailyError(error)) {
      throw new UnrecoverableError(errorMessage(error));
    }
    throw error;
  }
}

/**
 * `stop` — plan §6.2's ladder. NEVER stamps the row: stopping is a REQUEST, and
 * `ready-to-download` is the only thing that may stamp `capture_ended_at` on a successful
 * capture.
 */
async function handleStop(job: Job<RecordingStopJobData>): Promise<void> {
  const { meetingId } = job.data;

  const meeting = await meetingsRepository.findById(meetingId);
  if (meeting === undefined || meeting.dailyRoomName === null) {
    log.info({ meetingId }, 'recording-stop: no live meeting or no venue — success');
    return;
  }

  const capturing = await meetingRecordingsRepository.findCapturingForMeeting(meetingId);
  if (capturing === undefined) {
    log.info({ meetingId }, 'recording-stop: nothing capturing — success');
    return;
  }

  try {
    const outcome = await stopRoomRecording(meeting.dailyRoomName, { instanceId: capturing.id });
    log.info({ meetingId, recordingId: capturing.id, outcome }, 'recording-stop: requested');
  } catch (error) {
    // OD-7's answer for stop is expressed inside `stopRoomRecording` (400/404 → success); a
    // throw here is therefore genuinely retryable (429/5xx/network) or a real 4xx bug.
    if (isUnrecoverableDailyError(error)) {
      throw new UnrecoverableError(errorMessage(error));
    }
    throw error;
  }
}

/**
 * Start the `recording-capture` worker — event-triggered, no cron. Dispatches on `job.name`.
 */
export function startRecordingCaptureWorker(): Worker<RecordingCaptureJobData> {
  const worker = new Worker<RecordingCaptureJobData>(
    RECORDING_CAPTURE_QUEUE,
    async (job) => {
      if (job.name === 'ensure') {
        await handleEnsure(job as Job<RecordingEnsureJobData>);
        return;
      }
      if (job.name === 'stop') {
        await handleStop(job as Job<RecordingStopJobData>);
        return;
      }
      // Defensive: no other job name is ever enqueued onto this queue.
      log.error(
        { jobName: job.name },
        'recording-capture: unknown job name — acking with no effect'
      );
    },
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
    log.error(
      { jobName: job.name, meetingId: job.data.meetingId, error: errorMessage(err) },
      `recording-capture: ${job.name} exhausted retries`
    );
    if (job.name === 'ensure') {
      // ⚠ DOES NOT STAMP THE ROW — §5.1b already stamped it inside the handler, before this
      // point, so the retry could re-enter with a fresh row.
      trackServer(RECORDING_SERVER_EVENTS.RECORDING_FAILED, {
        meeting_id: job.data.meetingId,
        stage: 'daily',
        reason: 'daily_api_error',
        distinct_id: job.data.meetingId,
      });
    }
    // `stop`'s terminal failure emits no analytics (the ticket defines none) and stamps
    // nothing — the recording still completes via Daily's own finalization.
  });

  return worker;
}

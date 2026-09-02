import { describe, it, expect, vi, beforeEach } from 'vitest';

const findById = vi.hoisted(() => vi.fn());
const markTranscriptJobSubmitted = vi.hoisted(() => vi.fn());
const markTranscriptJobFailed = vi.hoisted(() => vi.fn());
const markTranscriptJobSubmitFailed = vi.hoisted(() => vi.fn());
const findByCaptureId = vi.hoisted(() => vi.fn());
const resolveMeetingEngagement = vi.hoisted(() => vi.fn());
const submitTranscriptBatchJob = vi.hoisted(() => vi.fn());
const getBatchJobTranscriptLink = vi.hoisted(() => vi.fn());
const fetchBatchArtefactJson = vi.hoisted(() => vi.fn());
const adaptDailyBatchTranscriptJson = vi.hoisted(() => vi.fn());
const enqueueTranscriptPipeline = vi.hoisted(() => vi.fn());
const trackServer = vi.hoisted(() => vi.fn());
const queueAdd = vi.hoisted(() => vi.fn());
const logError = vi.hoisted(() => vi.fn());
const logInfo = vi.hoisted(() => vi.fn());
const logWarn = vi.hoisted(() => vi.fn());

const wired = vi.hoisted(
  () =>
    ({ processor: undefined, failedHandler: undefined }) as {
      processor?: (job: unknown) => Promise<void>;
      failedHandler?: (job: unknown, err: Error) => void;
    }
);

const MockUnrecoverableError = vi.hoisted(
  () =>
    class extends Error {
      constructor(message?: string) {
        super(message);
        this.name = 'UnrecoverableError';
      }
    }
);

const WorkerMock = vi.hoisted(() =>
  vi.fn(function (_queue: string, processor: (job: unknown) => Promise<void>) {
    wired.processor = processor;
    return {
      on: (event: string, handler: (job: unknown, err: Error) => void) => {
        if (event === 'failed') {
          wired.failedHandler = handler;
        }
      },
    };
  })
);

vi.mock('../lib/queue.js', () => ({ getQueue: () => ({ add: queueAdd }) }));
vi.mock('../lib/redis.js', () => ({ createRedisConnection: vi.fn(() => ({ conn: true })) }));
vi.mock('bullmq', () => ({ Worker: WorkerMock, UnrecoverableError: MockUnrecoverableError }));
vi.mock('@balo/db', () => ({
  meetingRecordingsRepository: {
    findById,
    markTranscriptJobSubmitted,
    markTranscriptJobFailed,
    markTranscriptJobSubmitFailed,
  },
  transcriptsRepository: { findByCaptureId },
}));
vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ error: logError, info: logInfo, warn: logWarn }),
}));
vi.mock('@balo/analytics/server', () => ({
  trackServer,
  TRANSCRIPT_SERVER_EVENTS: {
    TRANSCRIPT_CAPTURE_SUBMITTED: 'transcript_capture_submitted',
    TRANSCRIPT_CAPTURE_SKIPPED: 'transcript_capture_skipped',
    TRANSCRIPT_CAPTURE_FAILED: 'transcript_capture_failed',
  },
}));
vi.mock('../services/daily/batch-processor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/daily/batch-processor.js')>();
  return {
    ...actual,
    submitTranscriptBatchJob,
    getBatchJobTranscriptLink,
    fetchBatchArtefactJson,
  };
});
vi.mock('../services/transcript/normalizers/daily-batch-json.js', () => ({
  adaptDailyBatchTranscriptJson,
}));
vi.mock('../services/meetings/resolve-meeting-engagement.js', () => ({
  resolveMeetingEngagement,
}));
vi.mock('./transcript-pipeline.js', () => ({ enqueueTranscriptPipeline }));

import {
  enqueueTranscriptSubmit,
  enqueueTranscriptIngest,
  startTranscriptCaptureWorker,
  TRANSCRIPT_CAPTURE_QUEUE,
  ADAPTED_PAYLOAD_WARN_BYTES,
} from './transcript-capture.js';
import { DailyApiError, DailyConfigError } from '../services/daily/errors.js';
import { BatchArtefactTooLargeError } from '../services/daily/batch-processor.js';

const RECORDING_ID = 'rec-1';
const MEETING_ID = '11111111-1111-4111-8111-111111111111';
const DAILY_RECORDING_ID = 'daily-rec-1';
const BATCH_JOB_ID = '02c2508e-8835-4f3e-bcf2-e319d00f0eec';
const ENGAGEMENT_ID = '22222222-2222-4222-8222-222222222222';

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: RECORDING_ID,
    meetingId: MEETING_ID,
    dailyRecordingId: DAILY_RECORDING_ID,
    sourceDeletedAt: null,
    transcriptJobSubmittedAt: null,
    // ⚠ FIX ROUND 4 — a real DB row is NEVER `undefined` here (the column exists and defaults
    // to `NULL`), so the mock must default it too, or `!== null` in the new `handleSubmit` guard
    // would fire on every test that does not explicitly override this field.
    transcriptJobFinishedAt: null,
    durationSeconds: 1800,
    ...overrides,
  };
}

function resolvedEngagement(engagementId = ENGAGEMENT_ID): Record<string, unknown> {
  return { outcome: 'resolved', engagementId, contextType: 'case' };
}

describe('transcript-capture — enqueue', () => {
  beforeEach(() => vi.clearAllMocks());

  it('enqueueTranscriptSubmit — jobId keyed on the recordingId, 3 attempts, exponential 10s', async () => {
    await enqueueTranscriptSubmit({ recordingId: RECORDING_ID });

    expect(queueAdd).toHaveBeenCalledWith(
      'submit',
      { recordingId: RECORDING_ID },
      {
        jobId: `transcript-submit--${RECORDING_ID}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 10_000 },
      }
    );
  });

  it('enqueueTranscriptIngest — jobId keyed on the recordingId (NOT batchJobId), 5 attempts', async () => {
    await enqueueTranscriptIngest({ recordingId: RECORDING_ID, batchJobId: BATCH_JOB_ID });

    expect(queueAdd).toHaveBeenCalledWith(
      'ingest',
      { recordingId: RECORDING_ID, batchJobId: BATCH_JOB_ID },
      {
        jobId: `transcript-ingest--${RECORDING_ID}`,
        attempts: 5,
        backoff: { type: 'exponential', delay: 10_000 },
      }
    );
  });

  it('exposes the queue name', () => {
    expect(TRANSCRIPT_CAPTURE_QUEUE).toBe('transcript-capture');
  });
});

describe('transcript-capture — submit handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    startTranscriptCaptureWorker();
    resolveMeetingEngagement.mockResolvedValue(resolvedEngagement());
  });

  async function runSubmit(recordingId = RECORDING_ID): Promise<void> {
    await wired.processor?.({ name: 'submit', data: { recordingId } });
  }

  it('no live row ⇒ no-op', async () => {
    findById.mockResolvedValue(undefined);
    await runSubmit();
    expect(submitTranscriptBatchJob).not.toHaveBeenCalled();
  });

  it('already submitted ⇒ no-op', async () => {
    findById.mockResolvedValue(row({ transcriptJobSubmittedAt: new Date() }));
    await runSubmit();
    expect(submitTranscriptBatchJob).not.toHaveBeenCalled();
  });

  /**
   * ⚠⚠ FIX ROUND 4 — a row can carry `finished_at` with `submitted_at` STILL NULL (the
   * `daily_recording_id` fallback in `resolveBatchRecordingRow` stamps exactly this orphan
   * shape). Without this guard a manual re-submit would sail past the `submitted_at` check above
   * and buy a SECOND Daily batch job whose own `job-finished` webhook then CAS-no-ops.
   */
  it('⚠⚠ FIX ROUND 4 — finished_at already set, submitted_at NULL ⇒ skipped reason already_finished, no submit', async () => {
    findById.mockResolvedValue(
      row({ transcriptJobSubmittedAt: null, transcriptJobFinishedAt: new Date() })
    );

    await runSubmit();

    expect(submitTranscriptBatchJob).not.toHaveBeenCalled();
    expect(trackServer).toHaveBeenCalledWith(
      'transcript_capture_skipped',
      expect.objectContaining({
        reason: 'already_finished',
        meeting_id: MEETING_ID,
        recording_id: RECORDING_ID,
      })
    );
    expect(logInfo).toHaveBeenCalledWith(
      expect.objectContaining({ recordingId: RECORDING_ID, reason: 'already_finished' }),
      expect.stringContaining('transcript_job_finished_at already set')
    );
  });

  it('no daily_recording_id ⇒ skipped with reason no_daily_source', async () => {
    findById.mockResolvedValue(row({ dailyRecordingId: null }));
    await runSubmit();
    expect(submitTranscriptBatchJob).not.toHaveBeenCalled();
    expect(trackServer).toHaveBeenCalledWith(
      'transcript_capture_skipped',
      expect.objectContaining({ reason: 'no_daily_source' })
    );
  });

  it('source_deleted_at set ⇒ skipped with reason no_daily_source', async () => {
    findById.mockResolvedValue(row({ sourceDeletedAt: new Date() }));
    await runSubmit();
    expect(submitTranscriptBatchJob).not.toHaveBeenCalled();
    expect(trackServer).toHaveBeenCalledWith(
      'transcript_capture_skipped',
      expect.objectContaining({ reason: 'no_daily_source' })
    );
  });

  it.each([
    ['no_engagement_context', 'no_engagement_context'],
    ['ambiguous_context', 'ambiguous_context'],
    ['engagement_missing', 'engagement_missing'],
    ['meeting_not_found', 'meeting_missing'],
  ])(
    'engagement outcome %s ⇒ TRANSCRIPT_CAPTURE_SKIPPED reason %s, no submit',
    async (outcome, reason) => {
      findById.mockResolvedValue(row());
      resolveMeetingEngagement.mockResolvedValue({ outcome });

      await runSubmit();

      expect(submitTranscriptBatchJob).not.toHaveBeenCalled();
      expect(trackServer).toHaveBeenCalledWith(
        'transcript_capture_skipped',
        expect.objectContaining({ reason, meeting_id: MEETING_ID, recording_id: RECORDING_ID })
      );
    }
  );

  it('happy path: POST, then markTranscriptJobSubmitted, then TRANSCRIPT_CAPTURE_SUBMITTED', async () => {
    findById.mockResolvedValue(row());
    submitTranscriptBatchJob.mockResolvedValue(BATCH_JOB_ID);
    markTranscriptJobSubmitted.mockResolvedValue(row({ transcriptJobId: BATCH_JOB_ID }));

    await runSubmit();

    expect(submitTranscriptBatchJob).toHaveBeenCalledWith({ dailyRecordingId: DAILY_RECORDING_ID });
    expect(markTranscriptJobSubmitted).toHaveBeenCalledWith({
      id: RECORDING_ID,
      transcriptJobId: BATCH_JOB_ID,
      at: expect.any(Date),
    });
    expect(trackServer).toHaveBeenCalledWith('transcript_capture_submitted', {
      meeting_id: MEETING_ID,
      recording_id: RECORDING_ID,
      duration_seconds: 1800,
      distinct_id: MEETING_ID,
    });
  });

  it('⚠ the batch job id never appears in a happy-path log', async () => {
    findById.mockResolvedValue(row());
    submitTranscriptBatchJob.mockResolvedValue(BATCH_JOB_ID);
    markTranscriptJobSubmitted.mockResolvedValue(row({ transcriptJobId: BATCH_JOB_ID }));

    await runSubmit();

    const allLoggedFields = [...logInfo.mock.calls, ...logWarn.mock.calls].flat();
    for (const field of allLoggedFields) {
      expect(JSON.stringify(field)).not.toContain(BATCH_JOB_ID);
    }
  });

  it('⚠⚠ CAS returning undefined logs the orphan batch job id at error, does not throw', async () => {
    findById.mockResolvedValue(row());
    submitTranscriptBatchJob.mockResolvedValue(BATCH_JOB_ID);
    markTranscriptJobSubmitted.mockResolvedValue(undefined);

    await expect(runSubmit()).resolves.toBeUndefined();

    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ recordingId: RECORDING_ID, orphanedBatchJobId: BATCH_JOB_ID }),
      expect.any(String)
    );
    expect(trackServer).not.toHaveBeenCalledWith('transcript_capture_submitted', expect.anything());
  });

  it('⚠⚠ markTranscriptJobSubmitted THROWING logs the accepted-window residual at warn, then rethrows', async () => {
    findById.mockResolvedValue(row());
    submitTranscriptBatchJob.mockResolvedValue(BATCH_JOB_ID);
    const dbError = new Error('connection reset');
    markTranscriptJobSubmitted.mockRejectedValue(dbError);

    await expect(runSubmit()).rejects.toBe(dbError);

    expect(logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ recordingId: RECORDING_ID, orphanedBatchJobId: BATCH_JOB_ID }),
      expect.stringContaining('recording-cleanup-source will NOT withhold')
    );
  });

  it('a DailyApiError 400 (non-429) ⇒ UnrecoverableError, no CAS attempt', async () => {
    findById.mockResolvedValue(row());
    submitTranscriptBatchJob.mockRejectedValue(
      new DailyApiError('POST', '/batch-processor', 400, 'bad')
    );

    await expect(runSubmit()).rejects.toBeInstanceOf(MockUnrecoverableError);
    expect(markTranscriptJobSubmitted).not.toHaveBeenCalled();
  });

  it('a 429 rethrows UNWRAPPED — retryable', async () => {
    findById.mockResolvedValue(row());
    const rateLimited = new DailyApiError('POST', '/batch-processor', 429, 'slow down');
    submitTranscriptBatchJob.mockRejectedValue(rateLimited);

    await expect(runSubmit()).rejects.toBe(rateLimited);
  });

  it('a 5xx rethrows UNWRAPPED — retryable', async () => {
    findById.mockResolvedValue(row());
    const serverError = new DailyApiError('POST', '/batch-processor', 500, 'boom');
    submitTranscriptBatchJob.mockRejectedValue(serverError);

    await expect(runSubmit()).rejects.toBe(serverError);
  });

  it('DailyConfigError ⇒ UnrecoverableError', async () => {
    findById.mockResolvedValue(row());
    submitTranscriptBatchJob.mockRejectedValue(new DailyConfigError('DAILY_API_KEY is not set'));

    await expect(runSubmit()).rejects.toBeInstanceOf(MockUnrecoverableError);
  });

  it('⚠⚠ classifyFailureReason recovers a NON-"unknown" reason from a TranscriptCaptureUnrecoverableError (e.g. config_error)', async () => {
    findById.mockResolvedValue(row());
    submitTranscriptBatchJob.mockRejectedValue(new DailyConfigError('DAILY_API_KEY is not set'));
    // FIX ROUND 3 — a `submit`-stage terminal failure now goes through
    // `markTranscriptJobSubmitFailed`, not `markTranscriptJobFailed`.
    markTranscriptJobSubmitFailed.mockResolvedValue(undefined);

    let thrown: unknown;
    try {
      await wired.processor?.({ name: 'submit', data: { recordingId: RECORDING_ID } });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MockUnrecoverableError);

    wired.failedHandler?.(
      {
        name: 'submit',
        data: { recordingId: RECORDING_ID },
        opts: { attempts: 3 },
        attemptsMade: 3,
      },
      thrown as Error
    );

    await vi.waitFor(() =>
      expect(trackServer).toHaveBeenCalledWith(
        'transcript_capture_failed',
        expect.objectContaining({ reason: 'config_error' })
      )
    );
  });

  it('⚠ an unknown job name logs an error and does not throw — defensive, nothing else enqueues this name', async () => {
    await expect(
      wired.processor?.({ name: 'not-a-real-job-name', data: {} })
    ).resolves.toBeUndefined();

    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ jobName: 'not-a-real-job-name' }),
      expect.stringContaining('unknown job name')
    );
    expect(submitTranscriptBatchJob).not.toHaveBeenCalled();
    expect(getBatchJobTranscriptLink).not.toHaveBeenCalled();
  });
});

describe('transcript-capture — ingest handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    startTranscriptCaptureWorker();
    resolveMeetingEngagement.mockResolvedValue(resolvedEngagement());
    getBatchJobTranscriptLink.mockResolvedValue('https://example.test/signed-link');
    fetchBatchArtefactJson.mockResolvedValue({ results: {} });
    adaptDailyBatchTranscriptJson.mockReturnValue({
      language: 'en',
      durationSeconds: 90,
      participants: [],
      utterances: [
        { speakerLabel: 'speaker-0', start: 0, end: 1, transcript: 'hi', confidence: 0.9 },
      ],
      attribution: 'diarized',
    });
  });

  async function runIngest(recordingId = RECORDING_ID, batchJobId = BATCH_JOB_ID): Promise<void> {
    await wired.processor?.({ name: 'ingest', data: { recordingId, batchJobId } });
  }

  it('no live row ⇒ no-op', async () => {
    findById.mockResolvedValue(undefined);
    await runIngest();
    expect(getBatchJobTranscriptLink).not.toHaveBeenCalled();
  });

  it('⚠ an existing transcripts row for the capture id ⇒ no-op, NO access link minted', async () => {
    findById.mockResolvedValue(row());
    findByCaptureId.mockResolvedValue({ id: 'transcript-1' });

    await runIngest();

    expect(findByCaptureId).toHaveBeenCalledWith(`daily-batch:${BATCH_JOB_ID}`);
    expect(getBatchJobTranscriptLink).not.toHaveBeenCalled();
  });

  it.each([
    ['no_engagement_context', 'no_engagement_context'],
    ['ambiguous_context', 'ambiguous_context'],
    ['engagement_missing', 'engagement_missing'],
    ['meeting_not_found', 'meeting_missing'],
  ])(
    'defensive: engagement outcome %s ⇒ skipped reason %s, no link minted',
    async (outcome, reason) => {
      findById.mockResolvedValue(row());
      findByCaptureId.mockResolvedValue(undefined);
      resolveMeetingEngagement.mockResolvedValue({ outcome });

      await runIngest();

      expect(getBatchJobTranscriptLink).not.toHaveBeenCalled();
      expect(trackServer).toHaveBeenCalledWith(
        'transcript_capture_skipped',
        expect.objectContaining({ reason })
      );
    }
  );

  it('happy path: link minted, artefact fetched, adapted, pipeline enqueued', async () => {
    findById.mockResolvedValue(row());
    findByCaptureId.mockResolvedValue(undefined);

    await runIngest();

    expect(getBatchJobTranscriptLink).toHaveBeenCalledWith(BATCH_JOB_ID, 'json');
    expect(fetchBatchArtefactJson).toHaveBeenCalledWith('https://example.test/signed-link');
    expect(adaptDailyBatchTranscriptJson).toHaveBeenCalledWith({ results: {} });
    expect(enqueueTranscriptPipeline).toHaveBeenCalledWith({
      captureId: `daily-batch:${BATCH_JOB_ID}`,
      engagementId: ENGAGEMENT_ID,
      meetingId: MEETING_ID,
      vendor: 'daily_deepgram',
      payload: expect.objectContaining({ attribution: 'diarized' }),
      durationMs: 90_000,
    });
  });

  it('⚠ the access link is minted on EVERY attempt — two invocations mint twice', async () => {
    findById.mockResolvedValue(row());
    findByCaptureId.mockResolvedValue(undefined);

    await runIngest();
    await runIngest();

    expect(getBatchJobTranscriptLink).toHaveBeenCalledTimes(2);
  });

  it('⚠ the link never reaches a logger', async () => {
    findById.mockResolvedValue(row());
    findByCaptureId.mockResolvedValue(undefined);
    getBatchJobTranscriptLink.mockResolvedValue('https://example.test/SECRET_SIGNED_LINK');

    await runIngest();

    const allLoggedFields = [
      ...logInfo.mock.calls,
      ...logWarn.mock.calls,
      ...logError.mock.calls,
    ].flat();
    expect(allLoggedFields.length).toBeGreaterThan(0);
    for (const field of allLoggedFields) {
      expect(JSON.stringify(field)).not.toContain('SECRET_SIGNED_LINK');
    }
  });

  it('access-link 400 (not finished) rethrows UNWRAPPED — retryable', async () => {
    findById.mockResolvedValue(row());
    findByCaptureId.mockResolvedValue(undefined);
    const notFinished = new DailyApiError(
      'GET',
      '/batch-processor/x/access-link',
      400,
      'not finished'
    );
    getBatchJobTranscriptLink.mockRejectedValue(notFinished);

    await expect(runIngest()).rejects.toBe(notFinished);
  });

  it('access-link 404 (unknown job) ⇒ UnrecoverableError', async () => {
    findById.mockResolvedValue(row());
    findByCaptureId.mockResolvedValue(undefined);
    getBatchJobTranscriptLink.mockRejectedValue(
      new DailyApiError('GET', '/batch-processor/x/access-link', 404, 'not found')
    );

    await expect(runIngest()).rejects.toBeInstanceOf(MockUnrecoverableError);
  });

  it('artefact fetch size cap (BatchArtefactTooLargeError) ⇒ UnrecoverableError', async () => {
    findById.mockResolvedValue(row());
    findByCaptureId.mockResolvedValue(undefined);
    fetchBatchArtefactJson.mockRejectedValue(new BatchArtefactTooLargeError(25 * 1024 * 1024));

    await expect(runIngest()).rejects.toBeInstanceOf(MockUnrecoverableError);
  });

  it('artefact fetch non-2xx rethrows UNWRAPPED — retryable', async () => {
    findById.mockResolvedValue(row());
    findByCaptureId.mockResolvedValue(undefined);
    const serverError = new DailyApiError('GET', '/artefact', 500, 'boom');
    fetchBatchArtefactJson.mockRejectedValue(serverError);

    await expect(runIngest()).rejects.toBe(serverError);
  });

  it('⚠⚠ unparseable artefact (SyntaxError from fetchBatchArtefactJson) ⇒ UnrecoverableError', async () => {
    findById.mockResolvedValue(row());
    findByCaptureId.mockResolvedValue(undefined);
    fetchBatchArtefactJson.mockRejectedValue(new SyntaxError('Unexpected token in JSON'));

    await expect(runIngest()).rejects.toBeInstanceOf(MockUnrecoverableError);
  });

  it('⚠⚠ adaptDailyBatchTranscriptJson throwing ⇒ UnrecoverableError, reason artefact_unreadable', async () => {
    findById.mockResolvedValue(row());
    findByCaptureId.mockResolvedValue(undefined);
    adaptDailyBatchTranscriptJson.mockImplementation(() => {
      throw new Error('cannot interpret body');
    });

    await expect(runIngest()).rejects.toBeInstanceOf(MockUnrecoverableError);
    expect(enqueueTranscriptPipeline).not.toHaveBeenCalled();
  });

  it('a null durationSeconds ⇒ durationMs: null, never coerced', async () => {
    findById.mockResolvedValue(row());
    findByCaptureId.mockResolvedValue(undefined);
    adaptDailyBatchTranscriptJson.mockReturnValue({
      language: 'en',
      durationSeconds: null,
      participants: [],
      utterances: [
        { speakerLabel: 'speaker-0', start: 0, end: 1, transcript: 'hi', confidence: 0.9 },
      ],
      attribution: 'diarized',
    });

    await runIngest();

    expect(enqueueTranscriptPipeline).toHaveBeenCalledWith(
      expect.objectContaining({ durationMs: null })
    );
  });

  // ── FIX ROUND 1 (M1) — an empty transcript must never reach the pipeline ────────────────

  it('⚠⚠ M1 — zero utterances ⇒ skipped reason empty_transcript, NEVER enqueueTranscriptPipeline', async () => {
    findById.mockResolvedValue(row());
    findByCaptureId.mockResolvedValue(undefined);
    adaptDailyBatchTranscriptJson.mockReturnValue({
      language: 'en',
      durationSeconds: 61,
      participants: [],
      utterances: [],
      attribution: 'diarized',
    });

    await runIngest();

    expect(enqueueTranscriptPipeline).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        recordingId: RECORDING_ID,
        meetingId: MEETING_ID,
        reason: 'empty_transcript',
      }),
      expect.stringContaining('zero utterances')
    );
    expect(trackServer).toHaveBeenCalledWith(
      'transcript_capture_skipped',
      expect.objectContaining({
        meeting_id: MEETING_ID,
        recording_id: RECORDING_ID,
        reason: 'empty_transcript',
        distinct_id: MEETING_ID,
      })
    );
  });

  it('⚠ M1 — a NON-empty utterances list still enqueues (the guard is on length, not presence)', async () => {
    findById.mockResolvedValue(row());
    findByCaptureId.mockResolvedValue(undefined);

    await runIngest();

    expect(enqueueTranscriptPipeline).toHaveBeenCalled();
    expect(trackServer).not.toHaveBeenCalledWith(
      'transcript_capture_skipped',
      expect.objectContaining({ reason: 'empty_transcript' })
    );
  });

  // ── FIX ROUND 1 — the payload-warn-byte threshold and dispatch edge cases ──────────────

  it('⚠ ADAPTED_PAYLOAD_WARN_BYTES — an adapted payload over the threshold logs a warn', async () => {
    findById.mockResolvedValue(row());
    findByCaptureId.mockResolvedValue(undefined);
    const hugeText = 'x'.repeat(ADAPTED_PAYLOAD_WARN_BYTES + 1);
    adaptDailyBatchTranscriptJson.mockReturnValue({
      language: 'en',
      durationSeconds: 90,
      participants: [],
      utterances: [
        { speakerLabel: 'speaker-0', start: 0, end: 1, transcript: hugeText, confidence: 0.9 },
      ],
      attribution: 'diarized',
    });

    await runIngest();

    expect(logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ recordingId: RECORDING_ID }),
      expect.stringContaining('over the warn threshold')
    );
    expect(enqueueTranscriptPipeline).toHaveBeenCalled();
  });
});

describe('transcript-capture — worker.on("failed")', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    startTranscriptCaptureWorker();
    // M8 — `reportCaptureFailure` now stamps a durable mark on every terminal failure; default
    // BOTH writers to a benign resolve so tests that don't care about the DB write still reach
    // their `trackServer` assertions. FIX ROUND 3 split the single write in two: `batch_submit`
    // goes through `markTranscriptJobSubmitFailed`, every other stage keeps
    // `markTranscriptJobFailed`.
    markTranscriptJobFailed.mockResolvedValue(undefined);
    markTranscriptJobSubmitFailed.mockResolvedValue(undefined);
  });

  it('is a no-op when there is no job', () => {
    expect(() => wired.failedHandler?.(null, new Error('x'))).not.toThrow();
  });

  it('waits for BullMQ to retry while attempts remain (submit)', () => {
    wired.failedHandler?.(
      {
        name: 'submit',
        data: { recordingId: RECORDING_ID },
        opts: { attempts: 3 },
        attemptsMade: 1,
      },
      new Error('boom')
    );
    expect(logError).not.toHaveBeenCalled();
  });

  it('⚠ terminal SUBMIT failure emits TRANSCRIPT_CAPTURE_FAILED with stage batch_submit, meeting_id from the ROW', async () => {
    findById.mockResolvedValue(row());

    wired.failedHandler?.(
      {
        name: 'submit',
        data: { recordingId: RECORDING_ID },
        opts: { attempts: 3 },
        attemptsMade: 3,
      },
      new Error('daily down')
    );

    await vi.waitFor(() =>
      expect(trackServer).toHaveBeenCalledWith(
        'transcript_capture_failed',
        expect.objectContaining({
          meeting_id: MEETING_ID,
          recording_id: RECORDING_ID,
          stage: 'batch_submit',
          reason: 'unknown',
        })
      )
    );
    // ⚠⚠ FIX ROUND 3 — a `batch_submit` terminal failure is stamped through
    // `markTranscriptJobSubmitFailed` (failure_reason ONLY, no `at` — it never touches
    // `finished_at`), NEVER `markTranscriptJobFailed`. Calling the latter here would have
    // stamped `finished_at` for a segment that never had a vendor job at all — the dead end
    // this fix round closed. M8's original guarantee (a durable, sanitized mark so an ops audit
    // can tell "this segment's capture failed" apart from "never got this far") still holds,
    // just through the split-safe write.
    expect(markTranscriptJobSubmitFailed).toHaveBeenCalledWith({
      id: RECORDING_ID,
      reason: 'daily down',
    });
    expect(markTranscriptJobFailed).not.toHaveBeenCalled();
  });

  it('⚠ terminal INGEST failure emits TRANSCRIPT_CAPTURE_FAILED with stage artefact_fetch, meeting_id from the ROW (never recordingId)', async () => {
    findById.mockResolvedValue(row());

    wired.failedHandler?.(
      {
        name: 'ingest',
        data: { recordingId: RECORDING_ID, batchJobId: BATCH_JOB_ID },
        opts: { attempts: 5 },
        attemptsMade: 5,
      },
      new Error('artefact fetch failed')
    );

    await vi.waitFor(() =>
      expect(trackServer).toHaveBeenCalledWith(
        'transcript_capture_failed',
        expect.objectContaining({
          meeting_id: MEETING_ID,
          recording_id: RECORDING_ID,
          stage: 'artefact_fetch',
        })
      )
    );
    // ⚠ FIX ROUND 3 — every stage EXCEPT `batch_submit` still goes through
    // `markTranscriptJobFailed` (unchanged), never the new `batch_submit`-only mutator.
    expect(markTranscriptJobFailed).toHaveBeenCalledWith({
      id: RECORDING_ID,
      reason: 'artefact fetch failed',
      at: expect.any(Date),
    });
    expect(markTranscriptJobSubmitFailed).not.toHaveBeenCalled();
  });

  it('⚠⚠ M8 — the reason is SANITIZED before it is stamped on the row (a URL never reaches the DB write)', async () => {
    findById.mockResolvedValue(row());
    const leaky = new Error(
      'GET https://s3.amazonaws.com/daily-batch/artefact?X-Amz-Signature=SECRET failed'
    );

    wired.failedHandler?.(
      {
        name: 'ingest',
        data: { recordingId: RECORDING_ID, batchJobId: BATCH_JOB_ID },
        opts: { attempts: 5 },
        attemptsMade: 5,
      },
      leaky
    );

    await vi.waitFor(() => expect(markTranscriptJobFailed).toHaveBeenCalled());
    const [call] = markTranscriptJobFailed.mock.calls[0] as [{ reason: string }];
    expect(call.reason).not.toContain('X-Amz-Signature=SECRET');
    expect(call.reason).toContain('[redacted-url]');
  });

  it('⚠⚠ skips transcript_capture_failed (does not fall back to recordingId) when the row cannot be resolved', async () => {
    findById.mockResolvedValue(undefined);

    wired.failedHandler?.(
      {
        name: 'submit',
        data: { recordingId: RECORDING_ID },
        opts: { attempts: 3 },
        attemptsMade: 3,
      },
      new Error('boom')
    );

    await vi.waitFor(() =>
      expect(logError).toHaveBeenCalledWith(
        expect.objectContaining({ recordingId: RECORDING_ID }),
        expect.stringContaining('could not be resolved')
      )
    );
    expect(trackServer).not.toHaveBeenCalledWith('transcript_capture_failed', expect.anything());
    // M8 — the stamp is attempted on `recordingId` alone, BEFORE the row lookup is even
    // checked, mirroring `recording-ingest.ts`'s `reportIngestFailure`. FIX ROUND 3 — this is
    // a `submit`-stage (`batch_submit`) failure, so the split-safe mutator runs, never the one
    // that would stamp `finished_at`.
    expect(markTranscriptJobSubmitFailed).toHaveBeenCalledWith({
      id: RECORDING_ID,
      reason: 'boom',
    });
    expect(markTranscriptJobFailed).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

const queueAdd = vi.hoisted(() => vi.fn());
const findByCaptureId = vi.hoisted(() => vi.fn());
// BAL-550 — the resume arm's read, keyed on transcriptId. ADDED, not a change to any existing
// arm: no existing test names `findById`.
const findById = vi.hoisted(() => vi.fn());
const markFailed = vi.hoisted(() => vi.fn());
const runTranscriptPipeline = vi.hoisted(() => vi.fn());
const resumeTranscriptRecap = vi.hoisted(() => vi.fn());
const createLlmClient = vi.hoisted(() => vi.fn(() => ({ client: true })));
const trackServer = vi.hoisted(() => vi.fn());
const logError = vi.hoisted(() => vi.fn());

// Capture the processor + `failed` handler the worker wires up, so the tests can drive them
// directly (the mocked Worker never runs a real queue).
const wired = vi.hoisted(
  () =>
    ({ processor: undefined, failedHandler: undefined }) as {
      processor?: (job: unknown) => Promise<void>;
      failedHandler?: (job: unknown, err: Error) => void;
    }
);

// A `function` (not arrow) so `new Worker(...)` treats it as a constructor and uses its
// returned object (vitest requires `function`/`class` for constructable mocks).
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

// Mirror the real `TranscriptStageError` (carries a `.stage` + a `.cause`) so the `instanceof`
// + `err.cause instanceof …` branches in the handler resolve.
const MockStageError = vi.hoisted(
  () =>
    class extends Error {
      stage: string;
      constructor(message: string, stage: string, cause?: unknown) {
        super(message);
        this.stage = stage;
        this.cause = cause;
      }
    }
);

// Mirror the real `LlmOutputTruncatedError` (the deterministic-truncation cause).
const MockTruncatedError = vi.hoisted(
  () =>
    class extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'LlmOutputTruncatedError';
      }
    }
);

// Mirror BullMQ's `UnrecoverableError` (a real class so `UnrecoverableTranscriptStageError extends
// UnrecoverableError` loads and `instanceof` resolves).
const MockUnrecoverableError = vi.hoisted(
  () =>
    class extends Error {
      constructor(message?: string) {
        super(message);
        this.name = 'UnrecoverableError';
      }
    }
);

vi.mock('../lib/queue.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/queue.js')>()),
  getQueue: () => ({ add: queueAdd }),
}));
vi.mock('../lib/redis.js', () => ({ createRedisConnection: vi.fn(() => ({ conn: true })) }));
vi.mock('bullmq', () => ({ Worker: WorkerMock, UnrecoverableError: MockUnrecoverableError }));
vi.mock('../services/transcript/pipeline.js', () => ({
  runTranscriptPipeline,
  resumeTranscriptRecap,
  TranscriptStageError: MockStageError,
}));
vi.mock('../services/transcript/llm/anthropic-client.js', () => ({
  createLlmClient,
  LlmOutputTruncatedError: MockTruncatedError,
}));
vi.mock('@balo/db', () => ({
  transcriptsRepository: { findByCaptureId, findById, markFailed },
}));
vi.mock('@balo/analytics/server', () => ({
  trackServer,
  TRANSCRIPT_SERVER_EVENTS: {
    TRANSCRIPT_READY: 'transcript_ready',
    SUMMARY_READY: 'summary_ready',
    BOT_JOIN_FAILED: 'bot_join_failed',
    TRANSCRIPT_FAILED: 'transcript_failed',
  },
}));
vi.mock('@balo/shared/logging', () => ({ createLogger: () => ({ error: logError }) }));

import {
  enqueueTranscriptPipeline,
  enqueueTranscriptRecapResume,
  startTranscriptPipelineWorker,
  UnrecoverableTranscriptStageError,
  TRANSCRIPT_PIPELINE_QUEUE,
} from './transcript-pipeline.js';
import { dailyMultiSpeaker } from '../services/transcript/normalizers/__fixtures__/daily-deepgram.js';

describe('transcript-pipeline job', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('enqueueTranscriptPipeline adds a job with the stable jobId + retry/backoff', async () => {
    await enqueueTranscriptPipeline({
      captureId: 'cap-abc',
      engagementId: 'eng1',
      // BAL-418: `transcripts.meeting_id` is a NOT NULL FK → `meetings.id`, so this is required.
      meetingId: '11111111-1111-4111-8111-111111111111',
      vendor: 'daily_deepgram',
      payload: dailyMultiSpeaker,
      durationMs: 12500,
    });

    expect(queueAdd).toHaveBeenCalledWith(
      'run',
      expect.objectContaining({
        captureId: 'cap-abc',
        engagementId: 'eng1',
        vendor: 'daily_deepgram',
      }),
      {
        jobId: 'transcript-pipeline--cap-abc',
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        // BAL-531 fix round (F4) — the full VendorTranscriptPayload rides on `job.data` above,
        // and this enqueue now succeeds for the first time (it used to throw on the
        // `daily-batch:` shape). `removeOnComplete: true` + a small `removeOnFail` count — set
        // on THIS queue only, via per-call options, not `lib/queue.ts`'s shared defaults —
        // bound how many verbatim consultation transcripts can sit in Redis at once.
        removeOnComplete: true,
        removeOnFail: { count: 10 },
      }
    );
  });

  it('exposes the queue name', () => {
    expect(TRANSCRIPT_PIPELINE_QUEUE).toBe('transcript-pipeline');
  });

  it('BAL-531 — a real-shape captureId (embedding the daily-batch: prefix) yields a colon-free jobId', async () => {
    // The regression this closes: `transcript-capture.ts` builds `captureId` as
    // `` `daily-batch:${batchJobId}` `` — the ':cap-abc' fixture above can never fail, because
    // it never contained a colon in the first place. This is the real production shape.
    await enqueueTranscriptPipeline({
      captureId: 'daily-batch:9f1c0a2e-1234-4a1b-8c3d-abcdefabcdef',
      engagementId: 'eng1',
      meetingId: '11111111-1111-4111-8111-111111111111',
      vendor: 'daily_deepgram',
      payload: dailyMultiSpeaker,
      durationMs: 12500,
    });

    const [, , opts] = queueAdd.mock.calls[0] as [unknown, unknown, { jobId: string }];
    expect(opts.jobId).not.toContain(':');
    expect(opts.jobId).toBe(
      'transcript-pipeline--daily-batch_c9f1c0a2e-1234-4a1b-8c3d-abcdefabcdef'
    );
  });

  it('startTranscriptPipelineWorker constructs a Worker on the queue with concurrency 5', () => {
    startTranscriptPipelineWorker();
    expect(WorkerMock).toHaveBeenCalledWith(
      'transcript-pipeline',
      expect.any(Function),
      expect.objectContaining({ concurrency: 5 })
    );
  });

  it('the worker processor runs the pipeline with the job data and a fresh llm client', async () => {
    startTranscriptPipelineWorker();
    await wired.processor?.({ data: { captureId: 'cap-1', engagementId: 'e1' } });
    expect(runTranscriptPipeline).toHaveBeenCalledWith(
      { captureId: 'cap-1', engagementId: 'e1' },
      expect.objectContaining({ llm: expect.anything() })
    );
  });

  it('the failed handler is a no-op when there is no job', () => {
    startTranscriptPipelineWorker();
    expect(() => wired.failedHandler?.(null, new Error('x'))).not.toThrow();
    expect(findByCaptureId).not.toHaveBeenCalled();
  });

  it('the failed handler waits for BullMQ to retry while attempts remain', () => {
    startTranscriptPipelineWorker();
    wired.failedHandler?.(
      { data: { captureId: 'cap-2' }, opts: { attempts: 3 }, attemptsMade: 1 },
      new Error('boom')
    );
    expect(findByCaptureId).not.toHaveBeenCalled();
    // The failure event fires only on the exhausted branch, never on an interim retry.
    expect(trackServer).not.toHaveBeenCalled();
  });

  it('marks the transcript failed and emits transcript_failed once retries are exhausted', async () => {
    findByCaptureId.mockResolvedValue({ id: 't-1' });
    startTranscriptPipelineWorker();
    wired.failedHandler?.(
      {
        data: { captureId: 'cap-3', vendor: 'daily_deepgram' },
        opts: { attempts: 3 },
        attemptsMade: 3,
      },
      new MockStageError('cleanup failed', 'cleanup')
    );
    await vi.waitFor(() =>
      expect(markFailed).toHaveBeenCalledWith('t-1', 'cleanup', 'cleanup failed')
    );
    expect(trackServer).toHaveBeenCalledWith('transcript_failed', {
      stage: 'cleanup',
      vendor: 'daily_deepgram',
      distinct_id: 'system:transcript-pipeline',
    });
  });

  it('uses the "unknown" stage for a non-stage error and no-ops when no transcript row exists', async () => {
    findByCaptureId.mockResolvedValue(undefined);
    startTranscriptPipelineWorker();
    wired.failedHandler?.(
      { data: { captureId: 'cap-4' }, opts: {}, attemptsMade: 3 },
      new Error('generic')
    );
    await vi.waitFor(() => expect(findByCaptureId).toHaveBeenCalledWith('cap-4'));
    expect(markFailed).not.toHaveBeenCalled();
  });

  it('swallows a repository error while marking failed on exhausted retries', async () => {
    findByCaptureId.mockRejectedValue(new Error('db down'));
    startTranscriptPipelineWorker();
    expect(() =>
      wired.failedHandler?.(
        { data: { captureId: 'cap-5' }, opts: { attempts: 3 }, attemptsMade: 3 },
        new Error('generic')
      )
    ).not.toThrow();
    await vi.waitFor(() => expect(findByCaptureId).toHaveBeenCalledWith('cap-5'));
    expect(markFailed).not.toHaveBeenCalled();
  });

  it('wraps a deterministic truncation as UnrecoverableError → terminal even at attemptsMade=1', async () => {
    findByCaptureId.mockResolvedValue({ id: 't-2' });
    // The pipeline surfaces a truncation-caused stage error; the processor must rethrow it as an
    // UnrecoverableError so BullMQ does NOT retry (no re-spend of a full Sonnet cleanup pass).
    const stageErr = new MockStageError(
      'cleanup failed (truncated)',
      'cleanup',
      new MockTruncatedError('truncated at cap')
    );
    // `…Once`, not a persistent rejection: `beforeEach`'s `vi.clearAllMocks()` clears call
    // history but NOT implementations, so a persistent one leaks into every later test in this
    // file — it broke BAL-550's worker-routing case, which needs this mock to resolve.
    runTranscriptPipeline.mockRejectedValueOnce(stageErr);
    startTranscriptPipelineWorker();

    let thrown: unknown;
    try {
      await wired.processor?.({ data: { captureId: 'cap-6', vendor: 'daily_deepgram' } });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(MockUnrecoverableError);
    expect(thrown).toBeInstanceOf(UnrecoverableTranscriptStageError);
    expect((thrown as UnrecoverableTranscriptStageError).stage).toBe('cleanup');
    // The original error is preserved as `cause` so the truncation stack survives to Sentry.
    expect((thrown as UnrecoverableTranscriptStageError).cause).toBe(stageErr);
    expect((stageErr as { cause?: unknown }).cause).toBeInstanceOf(MockTruncatedError);

    // on('failed') fires at attemptsMade=1 (attempts remain) but the error is unrecoverable →
    // treated as terminal: markFailed + transcript_failed, NOT skipped as an interim retry.
    wired.failedHandler?.(
      {
        data: { captureId: 'cap-6', vendor: 'daily_deepgram' },
        opts: { attempts: 3 },
        attemptsMade: 1,
      },
      thrown as Error
    );
    await vi.waitFor(() =>
      expect(markFailed).toHaveBeenCalledWith('t-2', 'cleanup', 'cleanup failed (truncated)')
    );
    expect(trackServer).toHaveBeenCalledWith('transcript_failed', {
      stage: 'cleanup',
      vendor: 'daily_deepgram',
      distinct_id: 'system:transcript-pipeline',
    });
  });

  it('logs an error at startup when the prod key is missing (worker still constructs, no throw)', () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalKey = process.env.ANTHROPIC_API_KEY;
    process.env.NODE_ENV = 'production';
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(() => startTranscriptPipelineWorker()).not.toThrow();
      expect(logError).toHaveBeenCalledWith(
        expect.stringContaining('ANTHROPIC_API_KEY is not set in production')
      );
      expect(WorkerMock).toHaveBeenCalled();
    } finally {
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNodeEnv;
      }
      if (originalKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = originalKey;
      }
    }
  });

  // ── BAL-550 (D2, D5) — the admin re-drive's resume job ──────────────────────
  describe('enqueueTranscriptRecapResume', () => {
    it('adds a job with the DISJOINT jobId (re-stated parts, never a wrapped id)', async () => {
      await enqueueTranscriptRecapResume({ transcriptId: 'tr-1', auditEventId: 'audit-1' });

      expect(queueAdd).toHaveBeenCalledWith(
        'resume',
        { resume: true, transcriptId: 'tr-1', auditEventId: 'audit-1' },
        {
          jobId: 'transcript-pipeline--tr-1--redrive-audit-1',
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: true,
          removeOnFail: { count: 10 },
        }
      );
    });

    it('the resulting jobId is disjoint from the capture-id shape', async () => {
      await enqueueTranscriptRecapResume({ transcriptId: 'cap-abc', auditEventId: 'audit-1' });
      const [, , opts] = queueAdd.mock.calls[0] as [unknown, unknown, { jobId: string }];
      // The capture enqueue for the SAME id would be 'transcript-pipeline--cap-abc' — never
      // equal to the resume shape, so a retained failed capture job cannot swallow a re-drive.
      expect(opts.jobId).not.toBe('transcript-pipeline--cap-abc');
    });
  });

  describe('worker routing — compiler-narrowed on job.data', () => {
    it('a resume payload routes to resumeTranscriptRecap, never runTranscriptPipeline', async () => {
      startTranscriptPipelineWorker();
      await wired.processor?.({
        data: { resume: true, transcriptId: 'tr-1', auditEventId: 'audit-1' },
      });
      expect(resumeTranscriptRecap).toHaveBeenCalledWith(
        { resume: true, transcriptId: 'tr-1', auditEventId: 'audit-1' },
        expect.objectContaining({ llm: expect.anything() })
      );
      expect(runTranscriptPipeline).not.toHaveBeenCalled();
    });

    it('a capture payload (no `resume` key) still routes to runTranscriptPipeline unchanged', async () => {
      startTranscriptPipelineWorker();
      await wired.processor?.({ data: { captureId: 'cap-1', engagementId: 'e1' } });
      expect(runTranscriptPipeline).toHaveBeenCalledWith(
        { captureId: 'cap-1', engagementId: 'e1' },
        expect.objectContaining({ llm: expect.anything() })
      );
      expect(resumeTranscriptRecap).not.toHaveBeenCalled();
    });
  });

  describe('the resume arm terminal-failure handler', () => {
    it('marks the transcript failed (keyed on transcriptId) and emits transcript_failed with the row vendor', async () => {
      findById.mockResolvedValue({ id: 't-9', vendor: 'daily_deepgram' });
      startTranscriptPipelineWorker();
      wired.failedHandler?.(
        {
          data: { resume: true, transcriptId: 't-9', auditEventId: 'audit-9' },
          opts: { attempts: 3 },
          attemptsMade: 3,
        },
        new MockStageError('summarize failed', 'summarize')
      );
      await vi.waitFor(() =>
        expect(markFailed).toHaveBeenCalledWith('t-9', 'summarize', 'summarize failed')
      );
      expect(trackServer).toHaveBeenCalledWith('transcript_failed', {
        stage: 'summarize',
        vendor: 'daily_deepgram',
        distinct_id: 'system:transcript-pipeline',
      });
      // Never the capture-arm read for a resume payload.
      expect(findByCaptureId).not.toHaveBeenCalled();
    });

    it('no-ops (no analytic) when the transcript row cannot be resolved', async () => {
      findById.mockResolvedValue(undefined);
      startTranscriptPipelineWorker();
      wired.failedHandler?.(
        {
          data: { resume: true, transcriptId: 't-missing', auditEventId: 'audit-9' },
          opts: { attempts: 3 },
          attemptsMade: 3,
        },
        new Error('generic')
      );
      await vi.waitFor(() => expect(findById).toHaveBeenCalledWith('t-missing'));
      expect(markFailed).not.toHaveBeenCalled();
      expect(trackServer).not.toHaveBeenCalled();
    });
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

const queueAdd = vi.hoisted(() => vi.fn());
const findByCaptureId = vi.hoisted(() => vi.fn());
const markFailed = vi.hoisted(() => vi.fn());
const runTranscriptPipeline = vi.hoisted(() => vi.fn());
const createLlmClient = vi.hoisted(() => vi.fn(() => ({ client: true })));

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

// Mirror the real `TranscriptStageError` (carries a `.stage`) so the `instanceof` branch resolves.
const MockStageError = vi.hoisted(
  () =>
    class extends Error {
      stage: string;
      constructor(message: string, stage: string) {
        super(message);
        this.stage = stage;
      }
    }
);

vi.mock('../lib/queue.js', () => ({ getQueue: () => ({ add: queueAdd }) }));
vi.mock('../lib/redis.js', () => ({ createRedisConnection: vi.fn(() => ({ conn: true })) }));
vi.mock('bullmq', () => ({ Worker: WorkerMock }));
vi.mock('../services/transcript/pipeline.js', () => ({
  runTranscriptPipeline,
  TranscriptStageError: MockStageError,
}));
vi.mock('../services/transcript/llm/anthropic-client.js', () => ({ createLlmClient }));
vi.mock('@balo/db', () => ({
  transcriptsRepository: { findByCaptureId, markFailed },
}));
vi.mock('@balo/shared/logging', () => ({ createLogger: () => ({ error: vi.fn() }) }));

import {
  enqueueTranscriptPipeline,
  startTranscriptPipelineWorker,
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
      meetingId: null,
      vendor: 'daily_deepgram',
      payload: dailyMultiSpeaker,
      recordingRef: null,
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
      }
    );
  });

  it('exposes the queue name', () => {
    expect(TRANSCRIPT_PIPELINE_QUEUE).toBe('transcript-pipeline');
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
  });

  it('marks the transcript failed with the erroring stage once retries are exhausted', async () => {
    findByCaptureId.mockResolvedValue({ id: 't-1' });
    startTranscriptPipelineWorker();
    wired.failedHandler?.(
      { data: { captureId: 'cap-3' }, opts: { attempts: 3 }, attemptsMade: 3 },
      new MockStageError('cleanup failed', 'cleanup')
    );
    await vi.waitFor(() =>
      expect(markFailed).toHaveBeenCalledWith('t-1', 'cleanup', 'cleanup failed')
    );
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
});

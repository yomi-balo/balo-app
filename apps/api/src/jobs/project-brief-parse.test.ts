import { describe, it, expect, vi, beforeEach } from 'vitest';

const queueAdd = vi.hoisted(() => vi.fn());
const markFailed = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const runProjectBriefParse = vi.hoisted(() => vi.fn());
const createAiClient = vi.hoisted(() => vi.fn(() => ({ client: true })));

const wired = vi.hoisted(
  () =>
    ({ processor: undefined, failedHandler: undefined }) as {
      processor?: (job: unknown) => Promise<void>;
      failedHandler?: (job: unknown, err: Error) => void;
    }
);

const WorkerMock = vi.hoisted(() =>
  vi.fn(function (_queue: string, processor: (job: unknown) => Promise<void>) {
    wired.processor = processor;
    return {
      on: (event: string, handler: (job: unknown, err: Error) => void) => {
        if (event === 'failed') wired.failedHandler = handler;
      },
    };
  })
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

const MockProjectBriefParseError = vi.hoisted(
  () =>
    class extends Error {
      reason: string;
      constructor(reason: string, message: string) {
        super(message);
        this.reason = reason;
        this.name = 'ProjectBriefParseError';
      }
    }
);

const MockNoObjectGeneratedError = vi.hoisted(
  () =>
    class extends Error {
      constructor(message?: string) {
        super(message);
        this.name = 'NoObjectGeneratedError';
      }
    }
);
const MockTypeValidationError = vi.hoisted(
  () =>
    class extends Error {
      constructor(message?: string) {
        super(message);
        this.name = 'TypeValidationError';
      }
    }
);

vi.mock('bullmq', () => ({ Worker: WorkerMock, UnrecoverableError: MockUnrecoverableError }));
vi.mock('ai', () => ({
  NoObjectGeneratedError: MockNoObjectGeneratedError,
  TypeValidationError: MockTypeValidationError,
}));
vi.mock('../lib/redis.js', () => ({ createRedisConnection: vi.fn(() => ({ conn: true })) }));
vi.mock('../lib/queue.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/queue.js')>()),
  getQueue: () => ({ add: queueAdd }),
}));
vi.mock('../services/ai/index.js', () => ({ createAiClient }));
vi.mock('../services/project-brief/parse.js', () => ({
  runProjectBriefParse,
  ProjectBriefParseError: MockProjectBriefParseError,
}));
vi.mock('@balo/db', () => ({
  projectBriefParsesRepository: { markFailed },
}));
vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  enqueueProjectBriefParse,
  startProjectBriefParseWorker,
  PROJECT_BRIEF_PARSE_QUEUE,
} from './project-brief-parse.js';

describe('enqueueProjectBriefParse', () => {
  beforeEach(() => vi.clearAllMocks());

  /**
   * ⚠ THE FULL LITERAL, NOT `stringContaining` (fix round F20). A `stringContaining
   * ('project-brief-parse')` pin passes for ANY id that merely mentions the queue — including one
   * that dropped the parseId entirely, which is precisely the defect that matters here: an id
   * that is not per-WRITE dedups against a retained completed job and silently drops a
   * regenerate (memory `reference_bullmq_jobid_must_be_per_write_not_per_state`).
   *
   * MUTATION-PROVED: changing the builder call to `buildJobId('project-brief-parse')` (parseId
   * dropped) turns this red; reverting turns it green. The `stringContaining` form stayed green
   * through both.
   *
   * The expected value is written out by hand rather than computed with `buildJobId`, so a
   * change to the ESCAPE SCHEME also has to be looked at here (`lib/queue.test.ts` owns the
   * scheme itself; this owns what this queue's ids look like).
   */
  it('adds the job with the exact per-write jobId, the ID-ONLY payload, and 2 attempts', async () => {
    await enqueueProjectBriefParse({ parseId: 'parse-1' });
    expect(queueAdd).toHaveBeenCalledWith(
      'parse',
      { parseId: 'parse-1' },
      expect.objectContaining({
        jobId: 'project-brief-parse--parse-1',
        attempts: 2,
        removeOnComplete: true,
      })
    );
  });

  it('a DIFFERENT parseId yields a DIFFERENT jobId — the per-write property, stated directly', async () => {
    await enqueueProjectBriefParse({ parseId: '33333333-3333-3333-3333-333333333333' });
    expect(queueAdd).toHaveBeenCalledWith(
      'parse',
      { parseId: '33333333-3333-3333-3333-333333333333' },
      expect.objectContaining({
        jobId: 'project-brief-parse--33333333-3333-3333-3333-333333333333',
      })
    );
  });
});

describe('startProjectBriefParseWorker', () => {
  beforeEach(() => vi.clearAllMocks());

  it('registers a worker on the queue with concurrency 3', () => {
    startProjectBriefParseWorker();
    expect(WorkerMock).toHaveBeenCalledWith(
      PROJECT_BRIEF_PARSE_QUEUE,
      expect.any(Function),
      expect.objectContaining({ concurrency: 3 })
    );
  });

  it('a ProjectBriefParseError from the processor is re-thrown as UnrecoverableError', async () => {
    runProjectBriefParse.mockRejectedValue(new MockProjectBriefParseError('too_large', 'nope'));
    startProjectBriefParseWorker();
    await expect(wired.processor?.({ data: { parseId: 'p1' } })).rejects.toBeInstanceOf(
      MockUnrecoverableError
    );
  });

  it('a plain (invalid-output) error from the processor is NOT wrapped — left retryable', async () => {
    runProjectBriefParse.mockRejectedValue(new MockNoObjectGeneratedError('bad object'));
    startProjectBriefParseWorker();
    await expect(wired.processor?.({ data: { parseId: 'p1' } })).rejects.not.toBeInstanceOf(
      MockUnrecoverableError
    );
  });

  it('on terminal failure (UnrecoverableError), marks the row failed with the classified reason', () => {
    startProjectBriefParseWorker();
    const job = { data: { parseId: 'p1' }, attemptsMade: 1, opts: { attempts: 2 } };
    wired.failedHandler?.(job, new MockUnrecoverableError('nope'));
    expect(markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ parseId: 'p1', failureReason: 'unknown' })
    );
  });

  it('on terminal failure with a ProjectBriefParseError cause, marks the row with its reason', async () => {
    // ⚠ Drives this the way BullMQ actually would: whatever the PROCESSOR throws (the wrapped
    // UnrecoverableProjectBriefError, which carries the classified reason across the
    // UnrecoverableError boundary) is exactly what 'failed' receives — never the raw
    // ProjectBriefParseError the processor caught.
    runProjectBriefParse.mockRejectedValue(new MockProjectBriefParseError('too_large', 'nope'));
    startProjectBriefParseWorker();
    const job = { data: { parseId: 'p2' }, attemptsMade: 1, opts: { attempts: 2 } };

    let thrown: unknown;
    try {
      await wired.processor?.(job);
    } catch (err) {
      thrown = err;
    }

    wired.failedHandler?.(job, thrown as Error);
    expect(markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ parseId: 'p2', failureReason: 'too_large' })
    );
  });

  it('on terminal failure with a NoObjectGeneratedError cause, marks the row `invalid_output`', () => {
    startProjectBriefParseWorker();
    const job = { data: { parseId: 'p3' }, attemptsMade: 2, opts: { attempts: 2 } };
    wired.failedHandler?.(job, new MockNoObjectGeneratedError('bad'));
    expect(markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ parseId: 'p3', failureReason: 'invalid_output' })
    );
  });

  it('does NOT mark failed when attempts remain and the error is not unrecoverable', () => {
    startProjectBriefParseWorker();
    const job = { data: { parseId: 'p4' }, attemptsMade: 1, opts: { attempts: 2 } };
    wired.failedHandler?.(job, new MockNoObjectGeneratedError('bad'));
    expect(markFailed).not.toHaveBeenCalled();
  });
});

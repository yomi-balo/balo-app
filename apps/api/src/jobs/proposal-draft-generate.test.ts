import { describe, it, expect, vi, beforeEach } from 'vitest';

const queueAdd = vi.hoisted(() => vi.fn());
const markFailed = vi.hoisted(() => vi.fn());
const trackServer = vi.hoisted(() => vi.fn());
const logError = vi.hoisted(() => vi.fn());
const runProposalDraftGeneration = vi.hoisted(() => vi.fn());
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
const MockProposalDraftGenerationError = vi.hoisted(
  () =>
    class extends Error {
      reason: string;
      constructor(reason: string, message: string) {
        super(message);
        this.reason = reason;
        this.name = 'ProposalDraftGenerationError';
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
vi.mock('../services/proposal-draft/generate.js', () => ({
  runProposalDraftGeneration,
  ProposalDraftGenerationError: MockProposalDraftGenerationError,
}));
vi.mock('@balo/db', () => ({
  proposalDraftGenerationsRepository: { markFailed },
}));
vi.mock('@balo/analytics/server', () => ({
  trackServer,
  PROJECT_SERVER_EVENTS: { PROPOSAL_DRAFT_GENERATED: 'project_proposal_draft_generated' },
}));
vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: logError, debug: vi.fn() }),
}));

import {
  enqueueProposalDraftGenerate,
  startProposalDraftGenerateWorker,
  PROPOSAL_DRAFT_GENERATE_QUEUE,
} from './proposal-draft-generate.js';

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('enqueueProposalDraftGenerate', () => {
  beforeEach(() => vi.clearAllMocks());

  // The full literal, not stringContaining: an id that dropped the generationId would dedup
  // against a retained job. Written out by hand so a change to the escape scheme is looked at.
  it('adds the job with the exact jobId, the id-only payload, and 2 attempts', async () => {
    await enqueueProposalDraftGenerate({ generationId: 'gen-1' });
    expect(queueAdd).toHaveBeenCalledWith(
      'generate',
      { generationId: 'gen-1' },
      expect.objectContaining({
        jobId: 'proposal-draft-generate--gen-1',
        attempts: 2,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: true,
      })
    );
  });

  it('a different generationId yields a different jobId', async () => {
    await enqueueProposalDraftGenerate({ generationId: 'gen-2' });
    expect(queueAdd).toHaveBeenCalledWith(
      'generate',
      { generationId: 'gen-2' },
      expect.objectContaining({ jobId: 'proposal-draft-generate--gen-2' })
    );
  });
});

describe('startProposalDraftGenerateWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    markFailed.mockResolvedValue(undefined);
  });

  it('registers a worker on the queue with concurrency 3', () => {
    startProposalDraftGenerateWorker();
    expect(PROPOSAL_DRAFT_GENERATE_QUEUE).toBe('proposal-draft-generate');
    expect(WorkerMock).toHaveBeenCalledWith(
      'proposal-draft-generate',
      expect.any(Function),
      expect.objectContaining({ concurrency: 3 })
    );
  });

  it('runs the generation for the job with an AI client', async () => {
    runProposalDraftGeneration.mockResolvedValue(undefined);
    startProposalDraftGenerateWorker();
    await wired.processor?.({ data: { generationId: 'g1' } });
    expect(runProposalDraftGeneration).toHaveBeenCalledWith('g1', { ai: { client: true } });
  });

  it('re-throws a ProposalDraftGenerationError as UnrecoverableError', async () => {
    runProposalDraftGeneration.mockRejectedValue(
      new MockProposalDraftGenerationError('truncated', 'nope')
    );
    startProposalDraftGenerateWorker();
    await expect(wired.processor?.({ data: { generationId: 'g1' } })).rejects.toBeInstanceOf(
      MockUnrecoverableError
    );
  });

  it('leaves a plain invalid-output error retryable', async () => {
    runProposalDraftGeneration.mockRejectedValue(new MockNoObjectGeneratedError('bad'));
    startProposalDraftGenerateWorker();
    await expect(wired.processor?.({ data: { generationId: 'g1' } })).rejects.not.toBeInstanceOf(
      MockUnrecoverableError
    );
  });

  it('does nothing on a failure while attempts remain', () => {
    startProposalDraftGenerateWorker();
    const job = { data: { generationId: 'g1' }, attemptsMade: 1, opts: { attempts: 2 } };
    wired.failedHandler?.(job, new MockNoObjectGeneratedError('bad'));
    expect(markFailed).not.toHaveBeenCalled();
    expect(trackServer).not.toHaveBeenCalled();
  });

  it('ignores a failed event with no job', () => {
    startProposalDraftGenerateWorker();
    wired.failedHandler?.(undefined, new Error('x'));
    expect(markFailed).not.toHaveBeenCalled();
  });

  it('carries the classified reason through the UnrecoverableError boundary into markFailed', async () => {
    runProposalDraftGeneration.mockRejectedValue(
      new MockProposalDraftGenerationError('source_unavailable', 'gone')
    );
    startProposalDraftGenerateWorker();
    const job = { data: { generationId: 'g2' }, attemptsMade: 1, opts: { attempts: 2 } };

    let thrown: unknown;
    try {
      await wired.processor?.(job);
    } catch (error) {
      thrown = error;
    }
    wired.failedHandler?.(job, thrown as Error);
    await flush();

    expect(markFailed).toHaveBeenCalledWith({
      generationId: 'g2',
      failureReason: 'source_unavailable',
    });
  });

  it.each([
    ['NoObjectGeneratedError', new MockNoObjectGeneratedError('bad')],
    ['TypeValidationError', new MockTypeValidationError('bad')],
  ])('marks a terminal %s as invalid_output', async (_name, error) => {
    startProposalDraftGenerateWorker();
    const job = { data: { generationId: 'g3' }, attemptsMade: 2, opts: { attempts: 2 } };
    wired.failedHandler?.(job, error);
    await flush();
    expect(markFailed).toHaveBeenCalledWith({
      generationId: 'g3',
      failureReason: 'invalid_output',
    });
  });

  it('marks any other terminal error as unknown', async () => {
    startProposalDraftGenerateWorker();
    const job = { data: { generationId: 'g4' }, attemptsMade: 1, opts: { attempts: 2 } };
    wired.failedHandler?.(job, new MockUnrecoverableError('nope'));
    await flush();
    expect(markFailed).toHaveBeenCalledWith({ generationId: 'g4', failureReason: 'unknown' });
  });

  it('fires GENERATED failed only when the markFailed CAS won', async () => {
    markFailed.mockResolvedValue({
      relationshipId: 'rel-1',
      requestedByUserId: 'user-1',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      completedAt: new Date('2026-01-01T00:01:05.000Z'),
    });
    startProposalDraftGenerateWorker();
    const job = { data: { generationId: 'g5' }, attemptsMade: 2, opts: { attempts: 2 } };
    wired.failedHandler?.(job, new MockNoObjectGeneratedError('bad'));
    await flush();

    expect(trackServer).toHaveBeenCalledWith('project_proposal_draft_generated', {
      relationship_id: 'rel-1',
      status: 'failed',
      latency_ms: 65_000,
      milestone_count: 0,
      distinct_id: 'user-1',
    });
  });

  it('fires no analytics when the row was already terminal (CAS lost)', async () => {
    markFailed.mockResolvedValue(undefined);
    startProposalDraftGenerateWorker();
    const job = { data: { generationId: 'g6' }, attemptsMade: 2, opts: { attempts: 2 } };
    wired.failedHandler?.(job, new MockNoObjectGeneratedError('bad'));
    await flush();
    expect(trackServer).not.toHaveBeenCalled();
  });

  it('logs a persist failure with the err serializer key and the generation id only', async () => {
    const persistError = new Error('db down');
    markFailed.mockRejectedValue(persistError);
    startProposalDraftGenerateWorker();
    const job = { data: { generationId: 'g7' }, attemptsMade: 2, opts: { attempts: 2 } };
    wired.failedHandler?.(job, new MockNoObjectGeneratedError('bad'));
    await flush();
    expect(logError).toHaveBeenCalledWith(
      { err: persistError, generationId: 'g7' },
      'Proposal draft — failed to persist the terminal failure'
    );
  });
});

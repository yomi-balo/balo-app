import { describe, it, expect, vi, beforeEach } from 'vitest';

const queueAdd = vi.hoisted(() => vi.fn());
const findById = vi.hoisted(() => vi.fn());
const markIngesting = vi.hoisted(() => vi.fn());
const markFailed = vi.hoisted(() => vi.fn());
const getRecordingAccessLink = vi.hoisted(() => vi.fn());
const createSignedAssetFromUrl = vi.hoisted(() => vi.fn());
const trackServer = vi.hoisted(() => vi.fn());
const logError = vi.hoisted(() => vi.fn());
const logInfo = vi.hoisted(() => vi.fn());

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
  meetingRecordingsRepository: { findById, markIngesting, markFailed },
}));
vi.mock('@balo/analytics/server', () => ({
  trackServer,
  RECORDING_SERVER_EVENTS: {
    RECORDING_STARTED: 'recording_started',
    RECORDING_READY: 'recording_ready',
    RECORDING_FAILED: 'recording_failed',
  },
}));
vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ error: logError, info: logInfo }),
}));
vi.mock('../services/daily/recordings.js', () => ({ getRecordingAccessLink }));
vi.mock('../services/mux/assets.js', () => ({ createSignedAssetFromUrl }));

import {
  enqueueRecordingIngest,
  startRecordingIngestWorker,
  RECORDING_INGEST_QUEUE,
} from './recording-ingest.js';
import { MuxConfigError } from '../services/mux/errors.js';
import { DailyApiError } from '../services/daily/errors.js';

const RECORDING_ID = 'rec-1';
const MEETING_ID = '11111111-1111-4111-8111-111111111111';
const DAILY_RECORDING_ID = 'daily-rec-1';
const DOWNLOAD_LINK = 'https://daily-download.example/SECRET_TOKEN';

function sourceReadyRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: RECORDING_ID,
    meetingId: MEETING_ID,
    status: 'source_ready',
    dailyRecordingId: DAILY_RECORDING_ID,
    muxAssetId: null,
    ...overrides,
  };
}

describe('recording-ingest job — enqueue', () => {
  beforeEach(() => vi.clearAllMocks());

  it('enqueues with jobId keyed on the recordingId (not the Daily recording id)', async () => {
    await enqueueRecordingIngest({ recordingId: RECORDING_ID });

    expect(queueAdd).toHaveBeenCalledWith(
      'ingest',
      { recordingId: RECORDING_ID },
      {
        jobId: `recording-ingest--${RECORDING_ID}`,
        attempts: 5,
        backoff: { type: 'exponential', delay: 10_000 },
      }
    );
  });

  it('exposes the queue name', () => {
    expect(RECORDING_INGEST_QUEUE).toBe('recording-ingest');
  });
});

describe('recording-ingest job — handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    startRecordingIngestWorker();
  });

  async function run(recordingId = RECORDING_ID): Promise<void> {
    await wired.processor?.({ data: { recordingId } });
  }

  it('no-ops when the row is absent', async () => {
    findById.mockResolvedValue(undefined);
    await run();
    expect(getRecordingAccessLink).not.toHaveBeenCalled();
  });

  it('mux_asset_id already stamped ⇒ no Mux call', async () => {
    findById.mockResolvedValue(sourceReadyRow({ muxAssetId: 'existing-asset' }));
    await run();
    expect(getRecordingAccessLink).not.toHaveBeenCalled();
    expect(createSignedAssetFromUrl).not.toHaveBeenCalled();
  });

  it('status already `ready` ⇒ no Mux call', async () => {
    findById.mockResolvedValue(sourceReadyRow({ status: 'ready' }));
    await run();
    expect(getRecordingAccessLink).not.toHaveBeenCalled();
  });

  it('a status other than source_ready ⇒ UnrecoverableError', async () => {
    findById.mockResolvedValue(sourceReadyRow({ status: 'recording' }));
    await expect(run()).rejects.toBeInstanceOf(MockUnrecoverableError);
  });

  it('daily_recording_id null ⇒ UnrecoverableError', async () => {
    findById.mockResolvedValue(sourceReadyRow({ dailyRecordingId: null }));
    await expect(run()).rejects.toBeInstanceOf(MockUnrecoverableError);
  });

  it('⚠⚠ mints the access link INSIDE the job — happy path calls Daily then Mux then stamps', async () => {
    findById.mockResolvedValue(sourceReadyRow());
    getRecordingAccessLink.mockResolvedValue({
      downloadLink: DOWNLOAD_LINK,
      expiresAt: new Date('2026-01-01T00:10:00.000Z'),
    });
    createSignedAssetFromUrl.mockResolvedValue({ id: 'mux-asset-1' });
    markIngesting.mockResolvedValue(
      sourceReadyRow({ status: 'ingesting', muxAssetId: 'mux-asset-1' })
    );

    await run();

    expect(getRecordingAccessLink).toHaveBeenCalledWith(DAILY_RECORDING_ID);
    expect(createSignedAssetFromUrl).toHaveBeenCalledWith({
      url: DOWNLOAD_LINK,
      passthrough: RECORDING_ID,
    });
    expect(markIngesting).toHaveBeenCalledWith({ id: RECORDING_ID, muxAssetId: 'mux-asset-1' });
  });

  it('⚠ the download link never reaches a logger', async () => {
    findById.mockResolvedValue(sourceReadyRow());
    getRecordingAccessLink.mockResolvedValue({
      downloadLink: DOWNLOAD_LINK,
      expiresAt: new Date('2026-01-01T00:10:00.000Z'),
    });
    createSignedAssetFromUrl.mockResolvedValue({ id: 'mux-asset-1' });
    markIngesting.mockResolvedValue(sourceReadyRow({ status: 'ingesting' }));

    await run();

    const allLoggedFields = [...logInfo.mock.calls, ...logError.mock.calls].flat();
    // ⚠⚠ FIX ROUND 1 (F9-3) — WITHOUT THIS, THE LOOP BELOW HAS ZERO ASSERTIONS AND THE TEST
    // PASSES VACUOUSLY if nothing is logged at all (e.g. every log call were deleted). The
    // happy path logs at least "access link minted" (with `expiresAt`, never `downloadLink`),
    // so this must be non-empty.
    expect(allLoggedFields.length).toBeGreaterThan(0);
    for (const field of allLoggedFields) {
      expect(JSON.stringify(field)).not.toContain(DOWNLOAD_LINK);
    }
  });

  it('⚠⚠ markIngesting → undefined logs the orphan asset id at error (not lost — resolved by passthrough)', async () => {
    findById.mockResolvedValue(sourceReadyRow());
    getRecordingAccessLink.mockResolvedValue({
      downloadLink: DOWNLOAD_LINK,
      expiresAt: new Date(),
    });
    createSignedAssetFromUrl.mockResolvedValue({ id: 'mux-asset-orphan' });
    markIngesting.mockResolvedValue(undefined);

    await run();

    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ orphanedMuxAssetId: 'mux-asset-orphan' }),
      expect.any(String)
    );
  });

  it('re-mints the access link on every attempt (per-attempt, not once)', async () => {
    findById.mockResolvedValue(sourceReadyRow());
    getRecordingAccessLink.mockResolvedValue({
      downloadLink: DOWNLOAD_LINK,
      expiresAt: new Date(),
    });
    createSignedAssetFromUrl.mockResolvedValue({ id: 'mux-asset-1' });
    markIngesting.mockResolvedValue(sourceReadyRow({ status: 'ingesting' }));

    await run();
    await run();

    expect(getRecordingAccessLink).toHaveBeenCalledTimes(2);
  });

  // ── FIX ROUND 1 (F7) — `isRetryableMuxError` now DRIVES control flow ───────────────────────

  it('⚠⚠ MuxConfigError terminates IMMEDIATELY as UnrecoverableError — never retried as transient', async () => {
    findById.mockResolvedValue(sourceReadyRow());
    getRecordingAccessLink.mockResolvedValue({
      downloadLink: DOWNLOAD_LINK,
      expiresAt: new Date(),
    });
    createSignedAssetFromUrl.mockRejectedValue(new MuxConfigError('MUX_TOKEN_ID is not set'));

    await expect(run()).rejects.toBeInstanceOf(MockUnrecoverableError);
  });

  it('⚠⚠ a definite non-retryable Mux error (4xx, not 429) terminates immediately', async () => {
    findById.mockResolvedValue(sourceReadyRow());
    getRecordingAccessLink.mockResolvedValue({
      downloadLink: DOWNLOAD_LINK,
      expiresAt: new Date(),
    });
    createSignedAssetFromUrl.mockRejectedValue(
      Object.assign(new Error('bad request'), { status: 400 })
    );

    await expect(run()).rejects.toBeInstanceOf(MockUnrecoverableError);
  });

  it('⚠ the access-link fetch (Daily) is ALSO wrapped — not just the Mux create call', async () => {
    findById.mockResolvedValue(sourceReadyRow());
    getRecordingAccessLink.mockRejectedValue(
      new DailyApiError('GET', '/recordings/x/access-link', 404, 'not found')
    );

    await expect(run()).rejects.toBeInstanceOf(MockUnrecoverableError);
    expect(createSignedAssetFromUrl).not.toHaveBeenCalled();
  });

  it('a retryable-shaped error (5xx) rethrows UNWRAPPED, so BullMQ keeps retrying it', async () => {
    findById.mockResolvedValue(sourceReadyRow());
    getRecordingAccessLink.mockResolvedValue({
      downloadLink: DOWNLOAD_LINK,
      expiresAt: new Date(),
    });
    const transient = Object.assign(new Error('server error'), { status: 503 });
    createSignedAssetFromUrl.mockRejectedValue(transient);

    // ⚠ NOT wrapped — `.rejects.toBe` (identity), proving this path never reaches
    // `IngestUnrecoverableError` and BullMQ's normal attempt-counting retry still applies.
    await expect(run()).rejects.toBe(transient);
  });
});

describe('recording-ingest job — worker.on("failed")', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    startRecordingIngestWorker();
  });

  it('is a no-op when there is no job', () => {
    expect(() => wired.failedHandler?.(null, new Error('x'))).not.toThrow();
  });

  it('waits for BullMQ to retry while attempts remain', () => {
    wired.failedHandler?.(
      { data: { recordingId: RECORDING_ID }, opts: { attempts: 5 }, attemptsMade: 1 },
      new Error('boom')
    );
    expect(markFailed).not.toHaveBeenCalled();
  });

  it('⚠ terminal failure stamps stage "mux_ingest" and emits recording_failed, keyed on meetingId', async () => {
    findById.mockResolvedValue({ id: RECORDING_ID, meetingId: MEETING_ID });
    markFailed.mockResolvedValue(undefined);

    wired.failedHandler?.(
      { data: { recordingId: RECORDING_ID }, opts: { attempts: 5 }, attemptsMade: 5 },
      new Error('mux down')
    );

    await vi.waitFor(() =>
      expect(markFailed).toHaveBeenCalledWith(
        expect.objectContaining({ id: RECORDING_ID, stage: 'mux_ingest' })
      )
    );
    expect(trackServer).toHaveBeenCalledWith(
      'recording_failed',
      expect.objectContaining({ meeting_id: MEETING_ID, stage: 'mux_ingest' })
    );
  });

  it('⚠ never asks Daily to delete the source on failure (D4)', async () => {
    findById.mockResolvedValue({ id: RECORDING_ID, meetingId: MEETING_ID });
    markFailed.mockResolvedValue(undefined);

    wired.failedHandler?.(
      { data: { recordingId: RECORDING_ID }, opts: { attempts: 5 }, attemptsMade: 5 },
      new Error('mux down')
    );

    await vi.waitFor(() => expect(markFailed).toHaveBeenCalled());
    // No Daily deleteRecording import exists in this module at all — structural proof, not a
    // mock assertion, since `services/daily/recordings.js` is mocked with ONLY the two
    // functions this module actually imports.
  });

  /**
   * ⚠⚠ FIX ROUND 1 (F4) — a rejection message CONTAINING the Daily signed download link must
   * reach neither `meeting_recordings.failure_reason` nor the logger. `Mux.APIError`'s message
   * shape (`${status} ${JSON.stringify(errorBody)}`) can echo the offending `inputs[0].url`.
   */
  it('⚠⚠ a rejection message containing the download link reaches neither sink', async () => {
    findById.mockResolvedValue({ id: RECORDING_ID, meetingId: MEETING_ID });
    markFailed.mockResolvedValue(undefined);
    const leaky = new Error(`invalid_parameters: inputs[0].url is invalid: ${DOWNLOAD_LINK}`);

    wired.failedHandler?.(
      { data: { recordingId: RECORDING_ID }, opts: { attempts: 5 }, attemptsMade: 5 },
      leaky
    );

    await vi.waitFor(() => expect(markFailed).toHaveBeenCalled());
    const markFailedCall = markFailed.mock.calls[0]?.[0] as { reason?: string } | undefined;
    expect(markFailedCall?.reason).not.toContain(DOWNLOAD_LINK);
    expect(markFailedCall?.reason).not.toContain('SECRET_TOKEN');

    const allLoggedFields = [...logInfo.mock.calls, ...logError.mock.calls].flat();
    expect(allLoggedFields.length).toBeGreaterThan(0);
    for (const field of allLoggedFields) {
      expect(JSON.stringify(field)).not.toContain(DOWNLOAD_LINK);
    }
  });

  /**
   * ⚠⚠ FIX ROUND 1 (F12) — `row?.meetingId ?? recordingId` used to send
   * `meeting_recordings.id` as PostHog's `meeting_id` AND `distinct_id` when the row could not
   * be resolved, corrupting the metric §11 exists to answer. The row is unresolvable here
   * (`findById` returns `undefined`) — `recording_failed` must NOT fire, and the failure must
   * still be logged.
   */
  it('⚠⚠ skips recording_failed (does not fall back to recordingId) when the row cannot be resolved', async () => {
    findById.mockResolvedValue(undefined);
    markFailed.mockResolvedValue(undefined);

    wired.failedHandler?.(
      { data: { recordingId: RECORDING_ID }, opts: { attempts: 5 }, attemptsMade: 5 },
      new Error('mux down')
    );

    await vi.waitFor(() =>
      expect(logError).toHaveBeenCalledWith(
        expect.objectContaining({ recordingId: RECORDING_ID }),
        expect.stringContaining('could not be resolved')
      )
    );
    expect(trackServer).not.toHaveBeenCalled();
  });
});

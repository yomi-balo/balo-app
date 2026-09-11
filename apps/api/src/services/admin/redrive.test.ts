import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockDbTransaction,
  mockFindByIdRecording,
  mockReopenForIngestRedrive,
  mockFindByIdTranscript,
  mockClaimRecapResume,
  mockAuditRecord,
  mockEnqueueRecordingIngest,
  mockEnqueueTranscriptRecapResume,
  mockWarn,
  mockError,
  mockInfo,
  callOrder,
} = vi.hoisted(() => ({
  mockDbTransaction: vi.fn(),
  mockFindByIdRecording: vi.fn(),
  mockReopenForIngestRedrive: vi.fn(),
  mockFindByIdTranscript: vi.fn(),
  mockClaimRecapResume: vi.fn(),
  mockAuditRecord: vi.fn(),
  mockEnqueueRecordingIngest: vi.fn(),
  mockEnqueueTranscriptRecapResume: vi.fn(),
  mockWarn: vi.fn(),
  mockError: vi.fn(),
  mockInfo: vi.fn(),
  callOrder: [] as string[],
}));

vi.mock('@balo/db', () => ({
  db: { transaction: mockDbTransaction },
  meetingRecordingsRepository: {
    findById: mockFindByIdRecording,
    reopenForIngestRedrive: mockReopenForIngestRedrive,
  },
  transcriptsRepository: {
    findById: mockFindByIdTranscript,
    claimRecapResume: mockClaimRecapResume,
  },
  auditEventsRepository: { record: mockAuditRecord },
}));
vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ info: mockInfo, warn: mockWarn, error: mockError }),
}));
vi.mock('../../jobs/recording-ingest.js', () => ({
  enqueueRecordingIngest: mockEnqueueRecordingIngest,
}));
vi.mock('../../jobs/transcript-pipeline.js', () => ({
  enqueueTranscriptRecapResume: mockEnqueueTranscriptRecapResume,
}));

import { performRedrive, REDRIVE_ENQUEUE_FAILED_MSG } from './redrive.js';

const RECORDING_ID = '11111111-1111-4111-8111-111111111111';
const MEETING_ID = '22222222-2222-4222-8222-222222222222';
const ACTOR_ID = 'user_1';

/** `db.transaction` mock: runs the callback against a fake `tx` and returns its result — the
 *  real per-statement mocks decide success/failure via their own return values. */
function wireTransaction(): void {
  mockDbTransaction.mockImplementation(async (cb: (tx: unknown) => unknown) => cb({}));
}

describe('performRedrive — recording-ingest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callOrder.length = 0;
    wireTransaction();
  });

  it('CAS refusal ⇒ not_redrivable, no audit row, no job', async () => {
    mockFindByIdRecording.mockResolvedValue({
      meetingId: MEETING_ID,
      failedStage: 'mux_ingest',
      failureReason: 'boom',
      muxAssetId: 'asset_1',
    });
    mockReopenForIngestRedrive.mockResolvedValue(undefined); // CAS matched nothing

    const result = await performRedrive({
      kind: 'recording-ingest',
      entityId: RECORDING_ID,
      actorUserId: ACTOR_ID,
    });

    expect(result).toEqual({ ok: false, code: 'not_redrivable' });
    expect(mockAuditRecord).not.toHaveBeenCalled();
    expect(mockEnqueueRecordingIngest).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith(
      { kind: 'recording-ingest', entityId: RECORDING_ID },
      'Re-drive refused — the row is no longer in a re-drivable state'
    );
  });

  it('the audit row PRECEDES the enqueue, and the transaction has settled before the enqueue', async () => {
    mockFindByIdRecording.mockResolvedValue({
      meetingId: MEETING_ID,
      failedStage: 'mux_ingest',
      failureReason: 'boom',
      muxAssetId: 'asset_1',
    });
    mockReopenForIngestRedrive.mockResolvedValue({ meetingId: MEETING_ID });
    mockAuditRecord.mockImplementation(async () => {
      callOrder.push('audit.record');
      return { id: 'audit-1' };
    });
    // `db.transaction` itself only resolves once its callback (which includes the audit write)
    // settles — recording this AFTER the callback runs proves the commit precedes the enqueue.
    mockDbTransaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
      const result = await cb({});
      callOrder.push('transaction.committed');
      return result;
    });
    mockEnqueueRecordingIngest.mockImplementation(async () => {
      callOrder.push('queue.add');
      return 'recording-ingest--rec-1--redrive-audit-1';
    });

    const result = await performRedrive({
      kind: 'recording-ingest',
      entityId: RECORDING_ID,
      actorUserId: ACTOR_ID,
    });

    expect(result).toEqual({
      ok: true,
      kind: 'recording-ingest',
      entityId: RECORDING_ID,
      auditEventId: 'audit-1',
      jobId: 'recording-ingest--rec-1--redrive-audit-1',
    });
    expect(callOrder).toEqual(['audit.record', 'transaction.committed', 'queue.add']);
    expect(mockEnqueueRecordingIngest).toHaveBeenCalledWith({
      recordingId: RECORDING_ID,
      jobIdSuffix: 'redrive-audit-1',
    });
  });

  it('DOUBLE-CLICK produces ONE job — the second call finds the row no longer failed', async () => {
    mockFindByIdRecording.mockResolvedValue({
      meetingId: MEETING_ID,
      failedStage: null,
      failureReason: null,
      muxAssetId: null,
    });
    mockReopenForIngestRedrive
      .mockResolvedValueOnce({ meetingId: MEETING_ID }) // first call: CAS succeeds
      .mockResolvedValueOnce(undefined); // second call: row no longer 'failed'
    mockAuditRecord.mockResolvedValue({ id: 'audit-1' });
    mockEnqueueRecordingIngest.mockResolvedValue('recording-ingest--rec-1--redrive-audit-1');

    const first = await performRedrive({
      kind: 'recording-ingest',
      entityId: RECORDING_ID,
      actorUserId: ACTOR_ID,
    });
    const second = await performRedrive({
      kind: 'recording-ingest',
      entityId: RECORDING_ID,
      actorUserId: ACTOR_ID,
    });

    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, code: 'not_redrivable' });
    expect(mockEnqueueRecordingIngest).toHaveBeenCalledTimes(1);
    expect(mockAuditRecord).toHaveBeenCalledTimes(1);
  });

  it('records the metadata: prior stage/reason and the cleared mux asset id, off the PRE-read', async () => {
    mockFindByIdRecording.mockResolvedValue({
      meetingId: MEETING_ID,
      failedStage: 'mux_ingest',
      failureReason: 'boom',
      muxAssetId: 'asset_1',
    });
    mockReopenForIngestRedrive.mockResolvedValue({ meetingId: MEETING_ID });
    mockAuditRecord.mockResolvedValue({ id: 'audit-1' });
    mockEnqueueRecordingIngest.mockResolvedValue('jobid');

    await performRedrive({
      kind: 'recording-ingest',
      entityId: RECORDING_ID,
      actorUserId: ACTOR_ID,
    });

    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: ACTOR_ID,
        action: 'admin.redrive.recording-ingest',
        entityType: 'recording',
        entityId: RECORDING_ID,
        metadata: {
          meeting_id: MEETING_ID,
          prior_status: 'failed',
          prior_failed_stage: 'mux_ingest',
          prior_failure_reason: 'boom',
          cleared_mux_asset_id: 'asset_1',
        },
      }),
      expect.anything()
    );
  });

  it('enqueue throw ⇒ enqueue_failed with the auditEventId, logged verbatim', async () => {
    mockFindByIdRecording.mockResolvedValue({
      meetingId: MEETING_ID,
      failedStage: null,
      failureReason: null,
      muxAssetId: null,
    });
    mockReopenForIngestRedrive.mockResolvedValue({ meetingId: MEETING_ID });
    mockAuditRecord.mockResolvedValue({ id: 'audit-1' });
    mockEnqueueRecordingIngest.mockRejectedValue(new Error('redis down'));

    const result = await performRedrive({
      kind: 'recording-ingest',
      entityId: RECORDING_ID,
      actorUserId: ACTOR_ID,
    });

    expect(result).toEqual({ ok: false, code: 'enqueue_failed', auditEventId: 'audit-1' });
    expect(mockError).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'recording-ingest',
        entityId: RECORDING_ID,
        auditEventId: 'audit-1',
      }),
      REDRIVE_ENQUEUE_FAILED_MSG
    );
  });
});

describe('performRedrive — transcript-pipeline', () => {
  const TRANSCRIPT_ID = '33333333-3333-4333-8333-333333333333';

  beforeEach(() => {
    vi.clearAllMocks();
    wireTransaction();
  });

  it('CAS refusal ⇒ not_redrivable, no audit row, no job', async () => {
    mockFindByIdTranscript.mockResolvedValue({
      meetingId: MEETING_ID,
      failedStage: 'summarize',
      failureReason: 'LLM timeout',
    });
    mockClaimRecapResume.mockResolvedValue(undefined);

    const result = await performRedrive({
      kind: 'transcript-pipeline',
      entityId: TRANSCRIPT_ID,
      actorUserId: ACTOR_ID,
    });

    expect(result).toEqual({ ok: false, code: 'not_redrivable' });
    expect(mockAuditRecord).not.toHaveBeenCalled();
    expect(mockEnqueueTranscriptRecapResume).not.toHaveBeenCalled();
  });

  it('success — audit row (no cleared_mux_asset_id key), then the resume enqueue', async () => {
    // The PRE-read carries the failure; the CAS's own `RETURNING` is the POST-update row and
    // has already NULLed both columns — returning them here proves the audit row is fed by the
    // pre-read and not by the claim.
    mockFindByIdTranscript.mockResolvedValue({
      meetingId: MEETING_ID,
      failedStage: 'summarize',
      failureReason: 'LLM timeout',
    });
    mockClaimRecapResume.mockResolvedValue({
      meetingId: MEETING_ID,
      failedStage: null,
      failureReason: null,
    });
    mockAuditRecord.mockResolvedValue({ id: 'audit-2' });
    mockEnqueueTranscriptRecapResume.mockResolvedValue(
      'transcript-pipeline--tr-1--redrive-audit-2'
    );

    const result = await performRedrive({
      kind: 'transcript-pipeline',
      entityId: TRANSCRIPT_ID,
      actorUserId: ACTOR_ID,
    });

    expect(result).toEqual({
      ok: true,
      kind: 'transcript-pipeline',
      entityId: TRANSCRIPT_ID,
      auditEventId: 'audit-2',
      jobId: 'transcript-pipeline--tr-1--redrive-audit-2',
    });
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.redrive.transcript-pipeline',
        entityType: 'transcript',
        metadata: {
          meeting_id: MEETING_ID,
          prior_status: 'failed',
          prior_failed_stage: 'summarize',
          prior_failure_reason: 'LLM timeout',
        },
      }),
      expect.anything()
    );
    expect(mockEnqueueTranscriptRecapResume).toHaveBeenCalledWith({
      transcriptId: TRANSCRIPT_ID,
      auditEventId: 'audit-2',
    });
  });
});

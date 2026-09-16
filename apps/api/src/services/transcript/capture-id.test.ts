import { describe, it, expect } from 'vitest';
import {
  DAILY_BATCH_CAPTURE_ID_PREFIX,
  dailyBatchCaptureId,
  dailyBatchJobIdFromCaptureId,
} from './capture-id.js';

describe('capture-id (BAL-517 shared daily-batch: convention)', () => {
  it('pins the prefix literal that jobs/transcript-capture.ts:388 depends on', () => {
    expect(DAILY_BATCH_CAPTURE_ID_PREFIX).toBe('daily-batch:');
  });

  it('dailyBatchCaptureId builds the exact string the capture job wrote inline before this PR', () => {
    expect(dailyBatchCaptureId('batch-job-1')).toBe('daily-batch:batch-job-1');
  });

  it('round-trips: dailyBatchJobIdFromCaptureId(dailyBatchCaptureId(x)) === x', () => {
    expect(dailyBatchJobIdFromCaptureId(dailyBatchCaptureId('abc-123'))).toBe('abc-123');
  });

  it('returns null for a capture id with the wrong prefix', () => {
    expect(dailyBatchJobIdFromCaptureId('cap1')).toBeNull();
    expect(dailyBatchJobIdFromCaptureId('recall:xyz')).toBeNull();
  });

  it('returns null for an empty remainder after the prefix', () => {
    expect(dailyBatchJobIdFromCaptureId('daily-batch:')).toBeNull();
  });
});

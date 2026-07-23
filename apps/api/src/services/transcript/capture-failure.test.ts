import { describe, it, expect, vi, beforeEach } from 'vitest';
import { trackServer } from '@balo/analytics/server';
import { recordCaptureFailure } from './capture-failure.js';

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }),
}));

vi.mock('@balo/analytics/server', () => ({
  trackServer: vi.fn(),
  TRANSCRIPT_SERVER_EVENTS: {
    BOT_JOIN_FAILED: 'bot_join_failed',
    TRANSCRIPT_READY: 'transcript_ready',
    SUMMARY_READY: 'summary_ready',
  },
}));

describe('recordCaptureFailure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('emits bot_join_failed with venue balo_video for daily_deepgram', () => {
    recordCaptureFailure({ vendor: 'daily_deepgram', reason: 'bot_denied' });
    expect(vi.mocked(trackServer)).toHaveBeenCalledWith('bot_join_failed', {
      venue: 'balo_video',
      reason: 'bot_denied',
      distinct_id: 'system:transcript-pipeline',
    });
  });

  it('maps recall to venue external', () => {
    recordCaptureFailure({ vendor: 'recall', reason: 'timeout' });
    expect(vi.mocked(trackServer)).toHaveBeenCalledWith('bot_join_failed', {
      venue: 'external',
      reason: 'timeout',
      distinct_id: 'system:transcript-pipeline',
    });
  });
});

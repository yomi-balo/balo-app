import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const mockLogError = vi.fn();
vi.mock('@/lib/logging', () => ({
  log: {
    error: (...args: unknown[]) => mockLogError(...args),
  },
}));

import { toDeclineTrackStage } from './decline-track-stage';

describe('toDeclineTrackStage', () => {
  beforeEach(() => {
    mockLogError.mockClear();
  });

  it.each(['invited', 'eoi_submitted', 'proposal_requested', 'proposal_submitted'] as const)(
    'passes %s through unchanged, silently',
    (status) => {
      expect(toDeclineTrackStage(status)).toBe(status);
      expect(mockLogError).not.toHaveBeenCalled();
    }
  );

  it.each(['accepted', 'declined'] as const)(
    'does NOT throw on the terminal status %s — the write has already committed',
    (status) => {
      // The whole point of the fix-round change: a post-commit throw here would decline the
      // track and then lose its notification. Degrade + log instead.
      expect(() => toDeclineTrackStage(status)).not.toThrow();
      expect(toDeclineTrackStage(status)).toBe('invited');
      expect(mockLogError).toHaveBeenCalledWith(
        'declineTrack returned an unexpected previousStatus',
        expect.objectContaining({ previousStatus: status })
      );
    }
  );
});

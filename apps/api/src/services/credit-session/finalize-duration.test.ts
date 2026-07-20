import { describe, it, expect, beforeEach, vi } from 'vitest';

const {
  mockFindById,
  mockApplyExternalDuration,
  mockEndSessionAsSystem,
  ExternalDurationConflictError,
} = vi.hoisted(() => {
  class ExternalDurationConflictError extends Error {
    constructor(public readonly sessionId: string) {
      super('conflict');
      this.name = 'ExternalDurationConflictError';
    }
  }
  return {
    mockFindById: vi.fn(),
    mockApplyExternalDuration: vi.fn(),
    mockEndSessionAsSystem: vi.fn(),
    ExternalDurationConflictError,
  };
});

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@balo/db', () => ({
  creditSessionsRepository: {
    findById: mockFindById,
    applyExternalDuration: mockApplyExternalDuration,
  },
  ExternalDurationConflictError,
}));
vi.mock('./end-session.js', () => ({ endSessionAsSystem: mockEndSessionAsSystem }));

import { finalizeExternalDuration } from './finalize-duration.js';

const EXTERNAL_PENDING = {
  id: 'session_1',
  durationSource: 'external',
  billingFinalizedAt: null,
  settlementStatus: 'not_required',
  overdraftSettledMinor: null,
};

describe('finalizeExternalDuration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindById.mockResolvedValue(EXTERNAL_PENDING);
    mockApplyExternalDuration.mockResolvedValue(EXTERNAL_PENDING);
    mockEndSessionAsSystem.mockResolvedValue({
      settlementStatus: 'processing',
      overdraftSettledMinor: 1000,
    });
  });

  it('draws the confirmed minutes then reuses endSessionAsSystem with the finalization path', async () => {
    const result = await finalizeExternalDuration({
      sessionId: 'session_1',
      minutes: 30,
      path: 'confirmed',
    });
    expect(mockApplyExternalDuration).toHaveBeenCalledWith('session_1', 30);
    expect(mockEndSessionAsSystem).toHaveBeenCalledWith('session_1', {
      finalizationPath: 'confirmed',
    });
    expect(result).toEqual({ settlementStatus: 'processing', overdraftSettledMinor: 1000 });
  });

  it('is a no-op replay when the session already finalized', async () => {
    mockFindById.mockResolvedValue({
      ...EXTERNAL_PENDING,
      billingFinalizedAt: new Date(),
      settlementStatus: 'settled',
      overdraftSettledMinor: 500,
    });
    const result = await finalizeExternalDuration({
      sessionId: 'session_1',
      minutes: 30,
      path: 'confirmed',
    });
    expect(mockApplyExternalDuration).not.toHaveBeenCalled();
    expect(mockEndSessionAsSystem).not.toHaveBeenCalled();
    expect(result).toEqual({ settlementStatus: 'settled', overdraftSettledMinor: 500 });
  });

  it('is a no-op when the session is not external (a live-capture session)', async () => {
    mockFindById.mockResolvedValue({ ...EXTERNAL_PENDING, durationSource: 'live_capture' });
    await finalizeExternalDuration({ sessionId: 'session_1', minutes: 30, path: 'auto_confirmed' });
    expect(mockApplyExternalDuration).not.toHaveBeenCalled();
    expect(mockEndSessionAsSystem).not.toHaveBeenCalled();
  });

  it('is a no-op when the session is not found', async () => {
    mockFindById.mockResolvedValue(undefined);
    const result = await finalizeExternalDuration({
      sessionId: 'nope',
      minutes: 10,
      path: 'disputed',
    });
    expect(result).toEqual({ settlementStatus: 'not_required', overdraftSettledMinor: 0 });
    expect(mockApplyExternalDuration).not.toHaveBeenCalled();
  });

  it('rethrows an ExternalDurationConflictError (a disagreeing second confirmation) → route maps 409', async () => {
    mockApplyExternalDuration.mockRejectedValue(new ExternalDurationConflictError('session_1'));
    await expect(
      finalizeExternalDuration({ sessionId: 'session_1', minutes: 45, path: 'disputed' })
    ).rejects.toBeInstanceOf(ExternalDurationConflictError);
    expect(mockEndSessionAsSystem).not.toHaveBeenCalled();
  });
});

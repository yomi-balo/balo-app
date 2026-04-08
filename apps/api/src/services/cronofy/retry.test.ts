import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ──────────────────────────────────────────────

const {
  mockGetValidAccessToken,
  mockForceRefreshToken,
  mockUpdateConnectionStatus,
  mockClearAvailabilityCache,
} = vi.hoisted(() => ({
  mockGetValidAccessToken: vi.fn(),
  mockForceRefreshToken: vi.fn(),
  mockUpdateConnectionStatus: vi.fn(),
  mockClearAvailabilityCache: vi.fn(),
}));

vi.mock('./token-manager.js', () => ({
  getValidAccessToken: mockGetValidAccessToken,
  forceRefreshToken: mockForceRefreshToken,
}));

vi.mock('@balo/db', () => ({
  calendarRepository: {
    updateConnectionStatus: mockUpdateConnectionStatus,
    clearAvailabilityCache: mockClearAvailabilityCache,
  },
}));

import { withCronofyRetry } from './retry';
import { CalendarAuthError } from './errors';

describe('withCronofyRetry', () => {
  const expertProfileId = 'expert-123';

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetValidAccessToken.mockResolvedValue('valid-token');
  });

  it('passes the access token to the operation and returns the result', async () => {
    const operation = vi.fn().mockResolvedValue('result-data');

    const result = await withCronofyRetry(expertProfileId, operation);

    expect(result).toBe('result-data');
    expect(operation).toHaveBeenCalledWith('valid-token');
    expect(mockForceRefreshToken).not.toHaveBeenCalled();
  });

  it('retries with fresh token on 401 (non-invalid_grant)', async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce({ status: 401, error: 'expired_token' })
      .mockResolvedValueOnce('retry-success');
    mockForceRefreshToken.mockResolvedValue('fresh-token');

    const result = await withCronofyRetry(expertProfileId, operation);

    expect(result).toBe('retry-success');
    expect(operation).toHaveBeenCalledTimes(2);
    expect(operation).toHaveBeenNthCalledWith(1, 'valid-token');
    expect(operation).toHaveBeenNthCalledWith(2, 'fresh-token');
    expect(mockForceRefreshToken).toHaveBeenCalledWith(expertProfileId);
  });

  it('marks auth_error and throws CalendarAuthError on 401 + invalid_grant', async () => {
    const operation = vi.fn().mockRejectedValue({ status: 401, error: 'invalid_grant' });

    await expect(withCronofyRetry(expertProfileId, operation)).rejects.toThrow(CalendarAuthError);
    expect(mockUpdateConnectionStatus).toHaveBeenCalledWith(expertProfileId, 'auth_error');
    expect(mockClearAvailabilityCache).toHaveBeenCalledWith(expertProfileId);
    expect(mockForceRefreshToken).not.toHaveBeenCalled();
  });

  it('re-throws non-401 errors without retrying', async () => {
    const error = new Error('Network failure');
    const operation = vi.fn().mockRejectedValue(error);

    await expect(withCronofyRetry(expertProfileId, operation)).rejects.toBe(error);
    expect(mockForceRefreshToken).not.toHaveBeenCalled();
    expect(mockUpdateConnectionStatus).not.toHaveBeenCalled();
  });

  it('re-throws errors with status but not 401', async () => {
    const error = { status: 500, message: 'Server error' };
    const operation = vi.fn().mockRejectedValue(error);

    await expect(withCronofyRetry(expertProfileId, operation)).rejects.toBe(error);
    expect(mockForceRefreshToken).not.toHaveBeenCalled();
  });
});

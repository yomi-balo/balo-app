import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mockFindRate = vi.fn();
vi.mock('@balo/db', () => ({
  expertsRepository: { findRateCentsById: (...args: unknown[]) => mockFindRate(...args) },
}));

const mockWarn = vi.fn();
vi.mock('@/lib/logging', () => ({
  log: { warn: (...args: unknown[]) => mockWarn(...args) },
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

import { readCallNowRateLine } from './call-now-rate-line';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('readCallNowRateLine', () => {
  it('quotes the marked-up client rate as From pricing with the 15-minute minimum', async () => {
    mockFindRate.mockResolvedValue({ rateCents: 10000 });
    await expect(readCallNowRateLine('ep-1')).resolves.toBe(
      'From A$125.00/min · 15-minute minimum'
    );
    expect(mockFindRate).toHaveBeenCalledWith('ep-1');
  });

  it.each([
    ['no expert row', undefined],
    ['no rate', { rateCents: null }],
    ['a zero rate', { rateCents: 0 }],
  ])('returns null for %s', async (_label, row) => {
    mockFindRate.mockResolvedValue(row);
    await expect(readCallNowRateLine('ep-1')).resolves.toBeNull();
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('returns null and warns when the read fails', async () => {
    mockFindRate.mockRejectedValue(new Error('db down'));
    await expect(readCallNowRateLine('ep-1')).resolves.toBeNull();
    expect(mockWarn).toHaveBeenCalledWith('Call now rate read failed — no rate shown', {
      expertProfileId: 'ep-1',
      error: 'db down',
    });
  });
});

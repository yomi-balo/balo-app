import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logging', () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { readUpNextData } from './read-up-next-data';
import { log } from '@/lib/logging';
import type { UpNextRowView } from './up-next-view-types';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('readUpNextData', () => {
  it('wraps a successful read of rows as { kind: "ready" }', async () => {
    const rows: UpNextRowView[] = [];
    const result = await readUpNextData(() => Promise.resolve(rows), { userId: 'u-1' });
    expect(result).toEqual({ kind: 'ready', rows });
  });

  it('a null read (R1 omit) passes through as null, with no log', async () => {
    const result = await readUpNextData(() => Promise.resolve(null), { userId: 'u-1' });
    expect(result).toBeNull();
    expect(log.error).not.toHaveBeenCalled();
  });

  it('a thrown error is caught, logged with context, and rendered as the error state', async () => {
    const result = await readUpNextData(() => Promise.reject(new Error('db unavailable')), {
      userId: 'u-1',
      companyId: 'co-1',
    });
    expect(result).toEqual({ kind: 'error' });
    expect(log.error).toHaveBeenCalledWith(
      'Dashboard up next read failed',
      expect.objectContaining({ userId: 'u-1', companyId: 'co-1', error: 'db unavailable' })
    );
  });

  it('a non-Error throw is stringified', async () => {
    const result = await readUpNextData(() => Promise.reject('boom'), { userId: 'u-1' });
    expect(result).toEqual({ kind: 'error' });
    expect(log.error).toHaveBeenCalledWith(
      'Dashboard up next read failed',
      expect.objectContaining({ error: 'boom' })
    );
  });
});

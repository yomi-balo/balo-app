import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

// `readLiveUserRow` is wrapped in React's `cache()`, which needs a request scope to run. In unit
// tests there is no such scope, so make `cache` a pass-through — the same precedent
// `derive-workspaces.test.ts` sets.
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, cache: <T>(fn: T): T => fn };
});

const mockFindForSessionSync = vi.fn();
vi.mock('@balo/db', () => ({
  usersRepository: {
    findForSessionSync: (...args: unknown[]) => mockFindForSessionSync(...args),
  },
}));

import { readLiveUserRow } from './live-user';

describe('readLiveUserRow (BAL-568)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delegates to usersRepository.findForSessionSync with the same id', async () => {
    const row = { status: 'active', deletedAt: null, platformRole: 'user' };
    mockFindForSessionSync.mockResolvedValue(row);

    await expect(readLiveUserRow('user-1')).resolves.toBe(row);
    expect(mockFindForSessionSync).toHaveBeenCalledTimes(1);
    expect(mockFindForSessionSync).toHaveBeenCalledWith('user-1');
  });

  it('returns null unchanged for an id that matches no row', async () => {
    mockFindForSessionSync.mockResolvedValue(null);
    await expect(readLiveUserRow('nobody')).resolves.toBeNull();
  });

  it('⚠ does NOT swallow a repository failure — the caller owns the fail-closed decision', async () => {
    mockFindForSessionSync.mockRejectedValue(new Error('connection terminated'));
    await expect(readLiveUserRow('user-1')).rejects.toThrow('connection terminated');
  });
});

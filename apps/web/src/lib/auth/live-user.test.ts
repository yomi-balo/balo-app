import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

// ⚠⚠ THIS FILE DELIBERATELY DOES **NOT** MOCK `react`'s `cache`. Every sibling suite stubs it to a
// pass-through so the module under test is reachable; here the real import is kept, so the module
// is exercised exactly as shipped. ⚠ Under THIS project that import is React's CLIENT build, where
// `cache` is itself a pass-through — so nothing here can observe what `React.cache()` does. The
// suite that can is `./live-user.react-server.test.ts`, under the `react-server` project.

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

  /**
   * ⚠⚠ WHAT THIS PINS — AND, EQUALLY IMPORTANT, WHAT IT DOES NOT (corrected 2026-09-19, fix
   * round 3 H2, after an earlier version of this docblock claimed the larger thing).
   *
   * **It pins that `readLiveUserRow` adds no memo of its OWN.** This suite runs under the default
   * vitest project, which resolves `react` with no `react-server` condition — so `cache` here is
   * the CLIENT build's pass-through, and two calls reaching the repository twice says something
   * about this module and nothing about React.
   *
   * **It does NOT pin React's behaviour**, and cannot: the assertion below would hold whether or
   * not production deduped. That claim lives in `./live-user.react-server.test.ts`, which runs
   * under the `react-server` build and drives a real Flight render, so it can measure both halves
   * — two reads OUTSIDE a render, ONE inside one. Keep the two files' claims distinct; the whole
   * reason this ticket needed a third fix round is that a test was credited with more than it
   * could see.
   *
   * ⚠ IF THIS EVER GOES RED, DO NOT "FIX" IT BY LOOSENING THE COUNT: it would mean this module
   * grew a memo of its own, which is a behaviour change to make deliberately.
   */
  it('⚠ adds no memo of its own — two calls are TWO reads (client build)', async () => {
    mockFindForSessionSync.mockResolvedValue({ status: 'active', deletedAt: null });

    await readLiveUserRow('user-1');
    await readLiveUserRow('user-1');

    expect(mockFindForSessionSync).toHaveBeenCalledTimes(2);
  });

  it('⚠ the two reads are the SAME argument — this is not an argument-key miss', async () => {
    mockFindForSessionSync.mockResolvedValue({ status: 'active', deletedAt: null });

    await readLiveUserRow('user-1');
    await readLiveUserRow('user-1');

    // Both calls carried the identical key, so any memo keyed on the argument — this module's own,
    // had it grown one — WOULD have collapsed them. (What it does NOT show is why React's wrapper
    // did not: under this project's client build `cache` memoizes nothing at all. The missing
    // render scope is isolated as the cause in `./live-user.react-server.test.ts` instead, where
    // the identical pair of calls DOES collapse once it is made inside a render.)
    expect(mockFindForSessionSync.mock.calls).toEqual([['user-1'], ['user-1']]);
  });
});

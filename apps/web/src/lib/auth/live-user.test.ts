import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

// ⚠⚠ THIS FILE DELIBERATELY DOES **NOT** MOCK `react`'s `cache`. Every sibling suite stubs it to a
// pass-through so the module under test is reachable; here the REAL wrapper is the subject, because
// the thing being pinned is what `React.cache()` does — and does not do — outside a render pass.
// Stubbing it would simulate the very behaviour these assertions exist to check.

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
   * ⚠⚠ THE DOCUMENTED-BEHAVIOUR PIN, AND THE REASON IT IS A TEST RATHER THAN A COMMENT.
   *
   * `React.cache()` memoizes **only during a server-component render pass**. A Server Action runs
   * BEFORE Next starts that render; a Route Handler never runs inside one. So on those two paths
   * the wrapper does nothing and every seam call is its own query — which is why the 22
   * platform-gated staff actions pay TWO primary-key reads (the liveness gate, then
   * `actorHoldsPlatformCapability`).
   *
   * That cost was RULED ACCEPTABLE (user, 2026-09-19). What was not acceptable was the docblock
   * claiming a dedupe that does not happen there — the second time in this ticket a comment
   * vouched for an invariant that did not hold. Hence an assertion rather than more prose.
   *
   * ⚠ IF THIS EVER GOES RED, DO NOT "FIX" IT BY LOOSENING THE COUNT. A future React/Next that
   * deduped outside a render would be good news — update `live-user.ts`'s docblock (and
   * `live-row-single-reader.test.ts`'s header) to match the new reality, and change this number
   * deliberately.
   */
  it('⚠ does NOT dedupe outside a render pass — two calls are TWO reads', async () => {
    mockFindForSessionSync.mockResolvedValue({ status: 'active', deletedAt: null });

    await readLiveUserRow('user-1');
    await readLiveUserRow('user-1');

    expect(mockFindForSessionSync).toHaveBeenCalledTimes(2);
  });

  it('⚠ the two reads are the SAME argument — this is not an argument-key miss', async () => {
    mockFindForSessionSync.mockResolvedValue({ status: 'active', deletedAt: null });

    await readLiveUserRow('user-1');
    await readLiveUserRow('user-1');

    // Both calls carried the identical key, so a memo keyed on the argument WOULD have collapsed
    // them. It did not, which isolates the cause to the missing render scope rather than to a
    // cache-key mismatch.
    expect(mockFindForSessionSync.mock.calls).toEqual([['user-1'], ['user-1']]);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockCallSessionApi } = vi.hoisted(() => ({ mockCallSessionApi: vi.fn() }));

vi.mock('@/lib/credit/api-client', () => ({
  callSessionApi: mockCallSessionApi,
}));

import { fetchSessionMoneyBlock } from './session-money-block';

describe('fetchSessionMoneyBlock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the block on a 2xx and requests the money-block route with GET', async () => {
    const block = {
      lens: 'client',
      state: 'finalized',
      sessionId: 'session_1',
      amountAudMinor: 15_000,
    };
    mockCallSessionApi.mockResolvedValue({ ok: true, status: 200, data: block });

    const result = await fetchSessionMoneyBlock('session_1');

    expect(result).toEqual(block);
    expect(mockCallSessionApi).toHaveBeenCalledWith('/sessions/session_1/money-block', 'GET');
  });

  it('returns null on a non-2xx (e.g. 404 hides existence)', async () => {
    mockCallSessionApi.mockResolvedValue({ ok: false, status: 404, error: 'session_not_found' });
    expect(await fetchSessionMoneyBlock('session_1')).toBeNull();
  });

  it('returns null on a transport error (never leaks internals to the fragment)', async () => {
    mockCallSessionApi.mockResolvedValue({ ok: false, status: 0, error: 'Something went wrong.' });
    expect(await fetchSessionMoneyBlock('session_1')).toBeNull();
  });
});

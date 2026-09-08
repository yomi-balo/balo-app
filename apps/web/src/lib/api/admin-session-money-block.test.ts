import { describe, it, expect, vi, beforeEach } from 'vitest';
import { log } from '@/lib/logging';

const { mockCallSessionApi } = vi.hoisted(() => ({ mockCallSessionApi: vi.fn() }));

vi.mock('@/lib/credit/api-client', () => ({
  callSessionApi: mockCallSessionApi,
}));

import { fetchAdminSessionMoneyBlock } from './admin-session-money-block';

describe('fetchAdminSessionMoneyBlock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('200 → ok: true with the block, and hits the admin route', async () => {
    const block = { lens: 'admin', state: 'finalized', sessionId: 'session_1' };
    mockCallSessionApi.mockResolvedValue({ ok: true, status: 200, data: block });

    const result = await fetchAdminSessionMoneyBlock('session_1');

    expect(result).toEqual({ ok: true, block });
    expect(mockCallSessionApi).toHaveBeenCalledWith('/admin/sessions/session_1/money-block', 'GET');
  });

  it('403 → forbidden, and logs a warning (never an error)', async () => {
    mockCallSessionApi.mockResolvedValue({ ok: false, status: 403, error: 'forbidden' });
    const result = await fetchAdminSessionMoneyBlock('session_1');
    expect(result).toEqual({ ok: false, reason: 'forbidden' });
    expect(log.warn).toHaveBeenCalledWith('Admin money block denied to a staff viewer', {
      sessionId: 'session_1',
    });
  });

  it('404 → not_found', async () => {
    mockCallSessionApi.mockResolvedValue({ ok: false, status: 404, error: 'session_not_found' });
    expect(await fetchAdminSessionMoneyBlock('session_1')).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });

  it('500 → unavailable', async () => {
    mockCallSessionApi.mockResolvedValue({ ok: false, status: 500, error: 'boom' });
    expect(await fetchAdminSessionMoneyBlock('session_1')).toEqual({
      ok: false,
      reason: 'unavailable',
    });
  });

  it('transport error (status 0) → unavailable', async () => {
    mockCallSessionApi.mockResolvedValue({ ok: false, status: 0, error: 'Something went wrong.' });
    expect(await fetchAdminSessionMoneyBlock('session_1')).toEqual({
      ok: false,
      reason: 'unavailable',
    });
  });

  it('401 → unavailable (not forbidden — that is reserved for the capability 403)', async () => {
    mockCallSessionApi.mockResolvedValue({ ok: false, status: 401, error: 'unauthorized' });
    expect(await fetchAdminSessionMoneyBlock('session_1')).toEqual({
      ok: false,
      reason: 'unavailable',
    });
  });
});

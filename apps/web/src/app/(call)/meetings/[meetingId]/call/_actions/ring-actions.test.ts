import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRequireOnboardedUser, mockGetCallNowRing, mockPostStopRing, mockLog } = vi.hoisted(
  () => ({
    mockRequireOnboardedUser: vi.fn(),
    mockGetCallNowRing: vi.fn(),
    mockPostStopRing: vi.fn(),
    mockLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  })
);

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth/session', () => ({ requireOnboardedUser: mockRequireOnboardedUser }));
vi.mock('@/lib/call-now/call-now-api-client', () => ({
  getCallNowRing: mockGetCallNowRing,
  postStopRing: mockPostStopRing,
}));
vi.mock('@/lib/logging', () => ({ log: mockLog }));

import { readCallNowRingAction } from './read-call-now-ring';
import { stopCallNowRingAction } from './stop-call-now-ring';

const RING_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const USER_ID = '11111111-2222-4333-8444-555555555555';
const EXPIRES = '2026-11-19T10:00:45.000Z';

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireOnboardedUser.mockResolvedValue({ id: USER_ID });
});

describe('readCallNowRingAction', () => {
  it('returns the ring status and its expiry', async () => {
    mockGetCallNowRing.mockResolvedValue({
      ok: true,
      data: { status: 'ringing', expiresAt: EXPIRES },
    });

    await expect(readCallNowRingAction({ ringId: RING_ID })).resolves.toEqual({
      ok: true,
      status: 'ringing',
      expiresAtIso: EXPIRES,
    });
    expect(mockGetCallNowRing).toHaveBeenCalledWith(RING_ID);
  });

  it('gates on an onboarded user', async () => {
    mockRequireOnboardedUser.mockRejectedValue(new Error('Unauthorized'));

    await expect(readCallNowRingAction({ ringId: RING_ID })).rejects.toThrow('Unauthorized');
    expect(mockGetCallNowRing).not.toHaveBeenCalled();
  });

  it('refuses a non-uuid ring id without calling the api, and without asking for a retry', async () => {
    await expect(readCallNowRingAction({ ringId: 'nope' })).resolves.toEqual({
      ok: false,
      transient: false,
    });
    expect(mockGetCallNowRing).not.toHaveBeenCalled();
  });

  it.each([
    [0, true],
    [429, true],
    [500, true],
    [503, true],
    [404, false],
    [401, false],
  ])('a %i failure is transient=%s', async (status, transient) => {
    mockGetCallNowRing.mockResolvedValue({ ok: false, status, code: 'x' });

    await expect(readCallNowRingAction({ ringId: RING_ID })).resolves.toEqual({
      ok: false,
      transient,
    });
  });

  it('warns on a transient failure only', async () => {
    mockGetCallNowRing.mockResolvedValue({ ok: false, status: 503, code: 'x' });
    await readCallNowRingAction({ ringId: RING_ID });
    expect(mockLog.warn).toHaveBeenCalledTimes(1);

    mockLog.warn.mockClear();
    mockGetCallNowRing.mockResolvedValue({ ok: false, status: 404, code: 'ring_not_found' });
    await readCallNowRingAction({ ringId: RING_ID });
    expect(mockLog.warn).not.toHaveBeenCalled();
  });
});

describe('impersonated sessions (BAL-651)', () => {
  const IMPERSONATED = { id: USER_ID, isImpersonating: true, impersonatorUserId: 'admin-1' };

  it('⚠ the ring read refuses an impersonated session without calling the api', async () => {
    mockRequireOnboardedUser.mockResolvedValue(IMPERSONATED);

    await expect(readCallNowRingAction({ ringId: RING_ID })).resolves.toEqual({
      ok: false,
      transient: false,
    });
    expect(mockGetCallNowRing).not.toHaveBeenCalled();
    expect(mockLog.warn).toHaveBeenCalledWith(
      'Call now ring read refused — impersonated session',
      expect.objectContaining({ ringId: RING_ID, userId: USER_ID })
    );
  });

  it('⚠ the stop refuses an impersonated session without calling the api', async () => {
    mockRequireOnboardedUser.mockResolvedValue(IMPERSONATED);

    await expect(stopCallNowRingAction({ ringId: RING_ID })).resolves.toEqual({ ok: false });
    expect(mockPostStopRing).not.toHaveBeenCalled();
    expect(mockLog.warn).toHaveBeenCalledWith(
      'Call now stop refused — impersonated session',
      expect.objectContaining({ ringId: RING_ID, userId: USER_ID })
    );
  });
});

describe('stopCallNowRingAction', () => {
  it('returns the status the ring really has and logs the stop', async () => {
    mockPostStopRing.mockResolvedValue({ ok: true, data: { status: 'stopped' } });

    await expect(stopCallNowRingAction({ ringId: RING_ID })).resolves.toEqual({
      ok: true,
      status: 'stopped',
    });
    expect(mockPostStopRing).toHaveBeenCalledWith(RING_ID);
    expect(mockLog.info).toHaveBeenCalledWith('Call now stopped', {
      ringId: RING_ID,
      status: 'stopped',
    });
  });

  it('⚠ a stop that lost a race to a connect comes back connected, unchanged', async () => {
    mockPostStopRing.mockResolvedValue({ ok: true, data: { status: 'connected' } });

    await expect(stopCallNowRingAction({ ringId: RING_ID })).resolves.toEqual({
      ok: true,
      status: 'connected',
    });
  });

  it('gates on an onboarded user', async () => {
    mockRequireOnboardedUser.mockRejectedValue(new Error('Unauthorized'));

    await expect(stopCallNowRingAction({ ringId: RING_ID })).rejects.toThrow('Unauthorized');
    expect(mockPostStopRing).not.toHaveBeenCalled();
  });

  it('refuses a non-uuid ring id without calling the api', async () => {
    await expect(stopCallNowRingAction({ ringId: 'nope' })).resolves.toEqual({ ok: false });
    expect(mockPostStopRing).not.toHaveBeenCalled();
  });

  it('logs and answers not-ok on an api refusal', async () => {
    mockPostStopRing.mockResolvedValue({ ok: false, status: 404, code: 'ring_not_found' });

    await expect(stopCallNowRingAction({ ringId: RING_ID })).resolves.toEqual({ ok: false });
    expect(mockLog.warn).toHaveBeenCalledWith('Call now stop refused', {
      ringId: RING_ID,
      userId: USER_ID,
      status: 404,
      code: 'ring_not_found',
    });
  });
});

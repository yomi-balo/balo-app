import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRequireOnboardedUser, mockCredentialLive, mockPostDecline, mockLog } = vi.hoisted(
  () => ({
    mockRequireOnboardedUser: vi.fn(),
    mockCredentialLive: vi.fn(),
    mockPostDecline: vi.fn(),
    mockLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  })
);

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth/session', () => ({ requireOnboardedUser: mockRequireOnboardedUser }));
vi.mock('@/lib/api/balo-api-client', () => ({ viewerApiCredentialIsLive: mockCredentialLive }));
vi.mock('../call-now-api-client', () => ({ postDeclineRing: mockPostDecline }));
vi.mock('@/lib/logging', () => ({ log: mockLog }));

import { declineCallNowRingAction } from './decline-call-now-ring';

const RING_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireOnboardedUser.mockResolvedValue({ id: 'user-1' });
  mockCredentialLive.mockResolvedValue(true);
  mockPostDecline.mockResolvedValue({ ok: true, data: { status: 'declined' } });
});

describe('declineCallNowRingAction', () => {
  it('declines the ring and reports ok', async () => {
    await expect(declineCallNowRingAction({ ringId: RING_ID })).resolves.toEqual({ ok: true });
    expect(mockPostDecline).toHaveBeenCalledWith(RING_ID);
    expect(mockLog.info).toHaveBeenCalledWith('Call now declined', { ringId: RING_ID });
  });

  it('rejects a malformed ring id before any hop', async () => {
    await expect(declineCallNowRingAction({ ringId: 'nope' })).resolves.toEqual({ ok: false });
    expect(mockPostDecline).not.toHaveBeenCalled();
  });

  it('refuses an impersonated session before the credential check', async () => {
    mockRequireOnboardedUser.mockResolvedValue({
      id: 'user-1',
      isImpersonating: true,
      impersonatorUserId: 'staff-1',
    });

    await expect(declineCallNowRingAction({ ringId: RING_ID })).resolves.toEqual({ ok: false });
    expect(mockCredentialLive).not.toHaveBeenCalled();
    expect(mockPostDecline).not.toHaveBeenCalled();
    expect(mockLog.warn).toHaveBeenCalled();
  });

  it('refuses when the viewer credential has expired', async () => {
    mockCredentialLive.mockResolvedValue(false);

    await expect(declineCallNowRingAction({ ringId: RING_ID })).resolves.toEqual({ ok: false });
    expect(mockPostDecline).not.toHaveBeenCalled();
  });

  it('reports a refused decline as not ok and logs it', async () => {
    mockPostDecline.mockResolvedValue({ ok: false, status: 404, code: 'ring_not_found' });

    await expect(declineCallNowRingAction({ ringId: RING_ID })).resolves.toEqual({ ok: false });
    expect(mockLog.warn).toHaveBeenCalledWith(
      'Call now decline refused',
      expect.objectContaining({ status: 404 })
    );
  });

  it('logs and reports not ok when the hop throws', async () => {
    mockPostDecline.mockRejectedValue(new Error('boom'));

    await expect(declineCallNowRingAction({ ringId: RING_ID })).resolves.toEqual({ ok: false });
    expect(mockLog.error).toHaveBeenCalledWith(
      'Call now decline failed',
      expect.objectContaining({ error: 'boom' })
    );
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const { mockRedirect, mockResolveRingLandingPath, mockCheckSessionDrift, mockIsRingId } =
  vi.hoisted(() => ({
    mockRedirect: vi.fn(),
    mockResolveRingLandingPath: vi.fn(),
    mockCheckSessionDrift: vi.fn(),
    mockIsRingId: vi.fn(),
  }));

vi.mock('@/lib/auth/session-sync', () => ({ checkSessionDrift: mockCheckSessionDrift }));

vi.mock('next/navigation', () => ({ redirect: mockRedirect }));
vi.mock('@/lib/call-now/resolve-ring-landing', () => ({
  resolveRingLandingPath: mockResolveRingLandingPath,
  isRingId: mockIsRingId,
}));

import CallNowLandingPage, { metadata } from './page';

const RING_ID = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  vi.clearAllMocks();
  mockIsRingId.mockReturnValue(true);
  mockCheckSessionDrift.mockResolvedValue({ action: 'none' });
  mockRedirect.mockImplementation(() => {
    throw new Error('NEXT_REDIRECT');
  });
});

describe('CallNowLandingPage', () => {
  it('awaits params and redirects to the resolved path', async () => {
    mockResolveRingLandingPath.mockResolvedValue('/meetings/m-1/call');

    await expect(
      CallNowLandingPage({ params: Promise.resolve({ ringId: RING_ID }) })
    ).rejects.toThrow('NEXT_REDIRECT');

    expect(mockResolveRingLandingPath).toHaveBeenCalledWith(RING_ID);
    expect(mockRedirect).toHaveBeenCalledWith('/meetings/m-1/call');
  });

  it('sends a drifted session through session-sync and back to the ring, without reading it', async () => {
    mockCheckSessionDrift.mockResolvedValue({ action: 'sync-needed' });

    await expect(
      CallNowLandingPage({ params: Promise.resolve({ ringId: RING_ID }) })
    ).rejects.toThrow('NEXT_REDIRECT');

    expect(mockRedirect).toHaveBeenCalledTimes(1);
    expect(mockRedirect).toHaveBeenCalledWith(
      `/api/auth/session-sync?returnTo=${encodeURIComponent(`/call-now/${RING_ID}`)}`
    );
    expect(mockResolveRingLandingPath).not.toHaveBeenCalled();
  });

  it('sends a malformed ring id to the case list before any drift check or ring read', async () => {
    mockIsRingId.mockReturnValue(false);
    mockCheckSessionDrift.mockResolvedValue({ action: 'sync-needed' });

    await expect(
      CallNowLandingPage({ params: Promise.resolve({ ringId: '../x?y=1' }) })
    ).rejects.toThrow('NEXT_REDIRECT');

    expect(mockIsRingId).toHaveBeenCalledWith('../x?y=1');
    expect(mockRedirect).toHaveBeenCalledTimes(1);
    expect(mockRedirect).toHaveBeenCalledWith('/cases');
    expect(mockCheckSessionDrift).not.toHaveBeenCalled();
    expect(mockResolveRingLandingPath).not.toHaveBeenCalled();
  });

  it('is never indexed', () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });
});

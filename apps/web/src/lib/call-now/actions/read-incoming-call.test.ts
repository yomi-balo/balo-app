import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetCurrentUser, mockLoad } = vi.hoisted(() => ({
  mockGetCurrentUser: vi.fn(),
  mockLoad: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth', () => ({ getCurrentUser: mockGetCurrentUser }));
vi.mock('../load-incoming-call', () => ({ loadIncomingCall: mockLoad }));

import { readIncomingCallAction } from './read-incoming-call';

const VIEW = { ringId: 'ring-1' };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCurrentUser.mockResolvedValue({ id: 'user-1', onboardingCompleted: true });
  mockLoad.mockResolvedValue(VIEW);
});

describe('readIncomingCallAction', () => {
  it('loads the ring for an onboarded viewer', async () => {
    await expect(readIncomingCallAction()).resolves.toBe(VIEW);
    expect(mockLoad).toHaveBeenCalledWith('user-1');
  });

  it('is null for a signed-out viewer, without throwing', async () => {
    mockGetCurrentUser.mockResolvedValue(null);

    await expect(readIncomingCallAction()).resolves.toBeNull();
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it('is null before onboarding is complete', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', onboardingCompleted: false });

    await expect(readIncomingCallAction()).resolves.toBeNull();
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it('is null for an impersonated session', async () => {
    mockGetCurrentUser.mockResolvedValue({
      id: 'user-1',
      onboardingCompleted: true,
      isImpersonating: true,
    });

    await expect(readIncomingCallAction()).resolves.toBeNull();
    expect(mockLoad).not.toHaveBeenCalled();
  });
});

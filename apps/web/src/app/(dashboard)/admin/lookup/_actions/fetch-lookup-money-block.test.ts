import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionUser } from '@/lib/auth/session';

const { mockRequireOnboardedUser, mockFetchAdminSessionMoneyBlock } = vi.hoisted(() => ({
  mockRequireOnboardedUser: vi.fn(),
  mockFetchAdminSessionMoneyBlock: vi.fn(),
}));

vi.mock('@/lib/auth/session', () => ({ requireOnboardedUser: mockRequireOnboardedUser }));
vi.mock('@/lib/api/admin-session-money-block', () => ({
  fetchAdminSessionMoneyBlock: mockFetchAdminSessionMoneyBlock,
}));

import { fetchLookupMoneyBlockAction } from './fetch-lookup-money-block';

function user(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: 'user-x',
    email: 'x@example.com',
    firstName: 'X',
    lastName: 'Y',
    avatarUrl: null,
    activeMode: 'client',
    onboardingCompleted: true,
    platformRole: 'admin',
    companyId: 'company-1',
    companyName: 'Northwind Industrial',
    companyRole: 'owner',
    ...overrides,
  };
}

const VALID_SESSION_ID = '3f9a1b2c-1234-4abc-89ab-1234567890ab';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('fetchLookupMoneyBlockAction', () => {
  it('a non-staff viewer gets forbidden and the hop is never called', async () => {
    mockRequireOnboardedUser.mockResolvedValue(user({ platformRole: 'user' }));
    const result = await fetchLookupMoneyBlockAction(VALID_SESSION_ID);
    expect(result).toEqual({ ok: false, reason: 'forbidden' });
    expect(mockFetchAdminSessionMoneyBlock).not.toHaveBeenCalled();
  });

  it('rejects a non-uuid sessionId as not_found, without calling the hop', async () => {
    mockRequireOnboardedUser.mockResolvedValue(user({ platformRole: 'admin' }));
    const result = await fetchLookupMoneyBlockAction('not-a-uuid');
    expect(result).toEqual({ ok: false, reason: 'not_found' });
    expect(mockFetchAdminSessionMoneyBlock).not.toHaveBeenCalled();
  });

  it('a staff viewer with a valid id passes through to the hop', async () => {
    mockRequireOnboardedUser.mockResolvedValue(user({ platformRole: 'admin' }));
    mockFetchAdminSessionMoneyBlock.mockResolvedValue({
      ok: true,
      block: { lens: 'admin', state: 'finalized', sessionId: VALID_SESSION_ID },
    });

    const result = await fetchLookupMoneyBlockAction(VALID_SESSION_ID);

    expect(mockFetchAdminSessionMoneyBlock).toHaveBeenCalledWith(VALID_SESSION_ID);
    expect(result).toEqual({
      ok: true,
      block: { lens: 'admin', state: 'finalized', sessionId: VALID_SESSION_ID },
    });
  });

  it('propagates an unauthenticated requireOnboardedUser rejection', async () => {
    mockRequireOnboardedUser.mockRejectedValue(new Error('Unauthorized'));
    await expect(fetchLookupMoneyBlockAction(VALID_SESSION_ID)).rejects.toThrow('Unauthorized');
    expect(mockFetchAdminSessionMoneyBlock).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockFindWithCompany, mockGetMemberRole, mockFindWalletByCompany, mockRepoOpen } =
  vi.hoisted(() => ({
    mockFindWithCompany: vi.fn(),
    mockGetMemberRole: vi.fn(),
    mockFindWalletByCompany: vi.fn(),
    mockRepoOpen: vi.fn(),
  }));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@balo/db', () => ({
  usersRepository: { findWithCompany: mockFindWithCompany },
  partyMembershipsRepository: { getMemberRole: mockGetMemberRole },
  creditWalletsRepository: { findByCompanyId: mockFindWalletByCompany },
  creditSessionsRepository: { open: mockRepoOpen },
}));

import { openSession } from './open-session.js';

const INPUT = { initiatingMemberId: 'user_1', expertProfileId: 'expert_1', estimatedMinutes: 30 };

describe('openSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindWithCompany.mockResolvedValue({
      companyMemberships: [{ company: { id: 'company_1' }, role: 'member' }],
    });
    mockGetMemberRole.mockResolvedValue('member');
    mockFindWalletByCompany.mockResolvedValue({ id: 'wallet_1' });
    mockRepoOpen.mockResolvedValue({ ok: true, session: { id: 'session_1', holdId: 'hold_1' } });
  });

  it('opens a pending session on the happy path', async () => {
    const result = await openSession(INPUT);
    expect(result).toEqual({
      ok: true,
      sessionId: 'session_1',
      status: 'pending',
      holdId: 'hold_1',
    });
    expect(mockRepoOpen).toHaveBeenCalledWith({
      walletId: 'wallet_1',
      companyId: 'company_1',
      expertProfileId: 'expert_1',
      initiatingMemberId: 'user_1',
      estimatedMinutes: 30,
    });
  });

  it('fails closed (forbidden) when the user has no company membership', async () => {
    mockFindWithCompany.mockResolvedValue({ companyMemberships: [] });
    const result = await openSession(INPUT);
    expect(result).toEqual({ ok: false, code: 'forbidden' });
    expect(mockRepoOpen).not.toHaveBeenCalled();
  });

  it('fails closed (forbidden) when the member role is unresolved (non-company member)', async () => {
    mockGetMemberRole.mockResolvedValue(undefined);
    const result = await openSession(INPUT);
    expect(result).toEqual({ ok: false, code: 'forbidden' });
    expect(mockRepoOpen).not.toHaveBeenCalled();
  });

  it('returns wallet_missing when the company has no wallet', async () => {
    mockFindWalletByCompany.mockResolvedValue(undefined);
    const result = await openSession(INPUT);
    expect(result).toEqual({ ok: false, code: 'wallet_missing' });
    expect(mockRepoOpen).not.toHaveBeenCalled();
  });

  it('passes through a repo gate rejection code', async () => {
    mockRepoOpen.mockResolvedValue({ ok: false, code: 'insufficient_no_mandate' });
    const result = await openSession(INPUT);
    expect(result).toEqual({ ok: false, code: 'insufficient_no_mandate' });
  });

  it('passes through the account_hold rejection', async () => {
    mockRepoOpen.mockResolvedValue({ ok: false, code: 'account_hold' });
    const result = await openSession(INPUT);
    expect(result).toEqual({ ok: false, code: 'account_hold' });
  });
});

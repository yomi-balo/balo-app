import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockFindWithCompany, mockFindWalletByCompany, mockRepoOpen } = vi.hoisted(() => ({
  mockFindWithCompany: vi.fn(),
  mockFindWalletByCompany: vi.fn(),
  mockRepoOpen: vi.fn(),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
// NOTE: `@balo/shared/authz` is intentionally NOT mocked — the service uses the real, pure
// `roleHasCapability` map (owner/admin/member/expert hold CONSUME_CREDITS; 'finance'/unknown don't).
vi.mock('@balo/db', () => ({
  usersRepository: { findWithCompany: mockFindWithCompany },
  creditWalletsRepository: { findByCompanyId: mockFindWalletByCompany },
  creditSessionsRepository: { open: mockRepoOpen },
}));

import { openSession } from './open-session.js';

const INPUT = { initiatingMemberId: 'user_1', expertProfileId: 'expert_1', estimatedMinutes: 30 };

/** A single eligible `member` membership on `company_1` (name + null logo). */
function singleEligible(): { companyMemberships: unknown[] } {
  return {
    companyMemberships: [
      { company: { id: 'company_1', name: 'Acme', logoUrl: null }, role: 'member' },
    ],
  };
}

describe('openSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindWithCompany.mockResolvedValue(singleEligible());
    mockFindWalletByCompany.mockResolvedValue({ id: 'wallet_1' });
    mockRepoOpen.mockResolvedValue({ ok: true, session: { id: 'session_1', holdId: 'hold_1' } });
  });

  it('opens a pending session on the happy path (single eligible, no companyId)', async () => {
    const result = await openSession(INPUT);
    expect(result).toEqual({
      ok: true,
      sessionId: 'session_1',
      status: 'pending',
      holdId: 'hold_1',
    });
    expect(mockFindWalletByCompany).toHaveBeenCalledWith('company_1');
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
    expect(mockFindWalletByCompany).not.toHaveBeenCalled();
    expect(mockRepoOpen).not.toHaveBeenCalled();
  });

  it('fails closed (forbidden) when the only membership role lacks CONSUME_CREDITS', async () => {
    mockFindWithCompany.mockResolvedValue({
      companyMemberships: [
        { company: { id: 'company_1', name: 'Acme', logoUrl: null }, role: 'finance' },
      ],
    });
    const result = await openSession(INPUT);
    expect(result).toEqual({ ok: false, code: 'forbidden' });
    expect(mockFindWalletByCompany).not.toHaveBeenCalled();
    expect(mockRepoOpen).not.toHaveBeenCalled();
  });

  it('honours a provided companyId that is in the eligible set', async () => {
    mockFindWithCompany.mockResolvedValue({
      companyMemberships: [
        { company: { id: 'company_1', name: 'Acme', logoUrl: null }, role: 'member' },
        {
          company: { id: 'company_2', name: 'Globex', logoUrl: 'https://logo/globex.png' },
          role: 'admin',
        },
      ],
    });
    const result = await openSession({ ...INPUT, companyId: 'company_2' });
    expect(result).toEqual({
      ok: true,
      sessionId: 'session_1',
      status: 'pending',
      holdId: 'hold_1',
    });
    expect(mockFindWalletByCompany).toHaveBeenCalledWith('company_2');
    expect(mockRepoOpen).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 'company_2', walletId: 'wallet_1' })
    );
  });

  it('fails closed (forbidden) when the provided companyId is not a membership (IDOR)', async () => {
    const result = await openSession({ ...INPUT, companyId: 'company_999' });
    expect(result).toEqual({ ok: false, code: 'forbidden' });
    expect(mockFindWalletByCompany).not.toHaveBeenCalled();
    expect(mockRepoOpen).not.toHaveBeenCalled();
  });

  it('fails closed (forbidden) when the provided companyId is a membership but role-filtered out', async () => {
    mockFindWithCompany.mockResolvedValue({
      companyMemberships: [
        { company: { id: 'company_1', name: 'Acme', logoUrl: null }, role: 'member' },
        { company: { id: 'company_2', name: 'Globex', logoUrl: null }, role: 'finance' },
      ],
    });
    const result = await openSession({ ...INPUT, companyId: 'company_2' });
    expect(result).toEqual({ ok: false, code: 'forbidden' });
    expect(mockFindWalletByCompany).not.toHaveBeenCalled();
    expect(mockRepoOpen).not.toHaveBeenCalled();
  });

  it('returns company_selection_required when >1 eligible and no companyId', async () => {
    mockFindWithCompany.mockResolvedValue({
      companyMemberships: [
        { company: { id: 'company_1', name: 'Acme', logoUrl: null }, role: 'owner' },
        {
          company: { id: 'company_2', name: 'Globex', logoUrl: 'https://logo/globex.png' },
          role: 'member',
        },
      ],
    });
    const result = await openSession(INPUT);
    expect(result).toEqual({
      ok: false,
      code: 'company_selection_required',
      companies: [
        { id: 'company_1', name: 'Acme', logoUrl: null },
        { id: 'company_2', name: 'Globex', logoUrl: 'https://logo/globex.png' },
      ],
    });
    expect(mockFindWalletByCompany).not.toHaveBeenCalled();
    expect(mockRepoOpen).not.toHaveBeenCalled();
  });

  it('projects companies narrowly (exactly id/name/logoUrl — no company internals leak)', async () => {
    mockFindWithCompany.mockResolvedValue({
      companyMemberships: [
        {
          company: {
            id: 'company_1',
            name: 'Acme',
            logoUrl: null,
            isPersonal: true,
            creditBalance: 99_999,
            stripeCustomerId: 'cus_secret',
          },
          role: 'owner',
        },
        {
          company: {
            id: 'company_2',
            name: 'Globex',
            logoUrl: 'https://logo/globex.png',
            isPersonal: false,
            creditBalance: 500,
          },
          role: 'member',
        },
      ],
    });
    const result = await openSession(INPUT);
    if (result.ok || result.code !== 'company_selection_required') {
      throw new Error('expected company_selection_required');
    }
    for (const company of result.companies) {
      expect(Object.keys(company).sort()).toEqual(['id', 'logoUrl', 'name']);
    }
    const [first] = result.companies;
    expect(first?.logoUrl).toBeNull();
  });

  it('returns wallet_missing when the chosen company has no wallet', async () => {
    mockFindWalletByCompany.mockResolvedValue(undefined);
    const result = await openSession(INPUT);
    expect(result).toEqual({ ok: false, code: 'wallet_missing' });
    expect(mockRepoOpen).not.toHaveBeenCalled();
  });

  it('passes through a repo gate rejection code (insufficient_no_mandate)', async () => {
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

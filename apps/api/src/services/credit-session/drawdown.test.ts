import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockAuthorize, mockFindWallet, mockResolveBillingAdminName } = vi.hoisted(() => ({
  mockAuthorize: vi.fn(),
  mockFindWallet: vi.fn(),
  mockResolveBillingAdminName: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  creditWalletsRepository: { findById: mockFindWallet },
  partyMembershipsRepository: { resolveBillingAdminName: mockResolveBillingAdminName },
}));
vi.mock('./authorize-session-actor.js', () => ({ authorizeSessionActor: mockAuthorize }));

import { getSessionDrawdownState } from './drawdown.js';

const NOW = new Date('2026-07-16T12:00:00.000Z');
const SESSION = {
  id: 'session_1',
  status: 'active',
  connectedAt: new Date(NOW.getTime() - 42 * 60_000),
  clientRateMinorPerMinute: 100,
  effectiveCeilingMinor: 15_000,
  graceBoundMinutes: 30,
  graceEnteredAt: null,
  companyId: 'company_1',
  walletId: 'wallet_1',
};
const HEALTHY_WALLET = {
  balanceMinor: 50_000,
  mandateStatus: 'active',
  stripeCustomerId: 'cus_1',
  stripePaymentMethodId: 'pm_1',
};

describe('getSessionDrawdownState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: an owner (MANAGE_BILLING → client lens).
    mockAuthorize.mockResolvedValue({ ok: true, session: SESSION, role: 'owner' });
    mockFindWallet.mockResolvedValue(HEALTHY_WALLET);
  });

  it('gates the read on membership only (authorizes with no required capability)', async () => {
    await getSessionDrawdownState('session_1', 'viewer_1', NOW);
    expect(mockAuthorize).toHaveBeenCalledWith({ sessionId: 'session_1', userId: 'viewer_1' });
  });

  it('returns undefined when the session is not found (authorization not_found)', async () => {
    mockAuthorize.mockResolvedValue({ ok: false, code: 'not_found' });
    expect(await getSessionDrawdownState('s', 'u', NOW)).toBeUndefined();
    expect(mockFindWallet).not.toHaveBeenCalled();
  });

  it('DENIES a non-member of the session company (forbidden → undefined, no wallet read)', async () => {
    mockAuthorize.mockResolvedValue({ ok: false, code: 'forbidden' });
    expect(await getSessionDrawdownState('session_1', 'stranger', NOW)).toBeUndefined();
    expect(mockFindWallet).not.toHaveBeenCalled();
  });

  it('returns undefined when the wallet is not found', async () => {
    mockFindWallet.mockResolvedValue(undefined);
    expect(await getSessionDrawdownState('session_1', 'owner_user', NOW)).toBeUndefined();
  });

  it('resolves the CLIENT lens for a MANAGE_BILLING holder', async () => {
    const state = await getSessionDrawdownState('session_1', 'owner_user', NOW);
    expect(state?.lens).toBe('client');
    expect(state?.key).toBe('healthy');
    expect(state?.mandatePresent).toBe(true);
    expect(mockResolveBillingAdminName).not.toHaveBeenCalled();
  });

  it('resolves the MEMBER lens + admin name for a base member', async () => {
    mockAuthorize.mockResolvedValue({ ok: true, session: SESSION, role: 'member' }); // no MANAGE_BILLING
    mockResolveBillingAdminName.mockResolvedValue('Sam Lee');
    const state = await getSessionDrawdownState('session_1', 'member_user', NOW);
    expect(state?.lens).toBe('member');
    expect(state?.adminName).toBe('Sam Lee');
    expect(mockResolveBillingAdminName).toHaveBeenCalledWith('company_1');
  });

  it('member lens with no billing admin leaves adminName undefined (falls back in copy)', async () => {
    mockAuthorize.mockResolvedValue({ ok: true, session: SESSION, role: 'member' });
    mockResolveBillingAdminName.mockResolvedValue(undefined);
    const state = await getSessionDrawdownState('session_1', 'member_user', NOW);
    expect(state?.lens).toBe('member');
    expect(state?.adminName).toBeUndefined();
  });

  it('reflects a no-mandate wallet as mandatePresent false', async () => {
    mockFindWallet.mockResolvedValue({
      balanceMinor: 500,
      mandateStatus: 'none',
      stripeCustomerId: null,
      stripePaymentMethodId: null,
    });
    const state = await getSessionDrawdownState('session_1', 'owner_user', NOW);
    expect(state?.mandatePresent).toBe(false);
    expect(state?.key).toBe('low');
  });
});

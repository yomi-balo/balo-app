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
// BAL-412 (D5) — pin the floor so this suite is independent of any real env override.
vi.mock('../../config/billing-floor.js', () => ({
  resolveBillingFloorMinutes: () => 15,
}));

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
  // BAL-412 (D6) — 42 min drawn is past the 15-min floor, so every existing assertion below
  // stays byte-identical (the correction is a no-op past the floor).
  connectedMinutes: 42,
};
const HEALTHY_WALLET = {
  balanceMinor: 50_000,
  mandateStatus: 'active',
  stripeCustomerId: 'cus_1',
  stripePaymentMethodId: 'pm_1',
  lowBalanceMode: 'keep_going',
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
    expect(state?.graceAvailable).toBe(true);
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

  it('reflects a no-mandate wallet as graceAvailable false', async () => {
    mockFindWallet.mockResolvedValue({
      balanceMinor: 500,
      mandateStatus: 'none',
      stripeCustomerId: null,
      stripePaymentMethodId: null,
      lowBalanceMode: 'keep_going',
    });
    const state = await getSessionDrawdownState('session_1', 'owner_user', NOW);
    expect(state?.graceAvailable).toBe(false);
    expect(state?.key).toBe('low');
  });

  it('⚠ BAL-523: a live mandate on a notify_only wallet is graceAvailable FALSE — the panel must not promise a continuation the meter refuses', async () => {
    mockFindWallet.mockResolvedValue({
      balanceMinor: 500, // drives the session to the `low` key, same shape as the no-mandate case
      mandateStatus: 'active',
      stripeCustomerId: 'cus_1',
      stripePaymentMethodId: 'pm_1',
      lowBalanceMode: 'notify_only',
    });
    const state = await getSessionDrawdownState('session_1', 'owner_user', NOW);
    expect(state?.key).toBe('low');
    expect(state?.graceAvailable).toBe(false);
    expect(state?.cta?.secondaryLabel).toBeUndefined();
    expect(state?.body).not.toMatch(/keep going/i);
  });

  it('BAL-412 (D5/D6) — threads the floor + minutesAlreadyDrawn early in a session', async () => {
    mockAuthorize.mockResolvedValue({
      ok: true,
      session: { ...SESSION, connectedMinutes: 2 },
      role: 'owner',
    });
    mockFindWallet.mockResolvedValue({ ...HEALTHY_WALLET, balanceMinor: 2_000 });
    // rate=100, floor=15, drawn=2, balance=2000 ⇒ discretionary runway = 7 (not 20).
    const state = await getSessionDrawdownState('session_1', 'owner_user', NOW);
    expect(state?.key).toBe('low');
    expect(state?.minutesRemaining).toBe(7);
  });
});

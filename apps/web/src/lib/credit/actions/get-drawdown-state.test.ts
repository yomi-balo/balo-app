import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  cookies: vi.fn(() => ({ get: vi.fn() })),
  headers: vi.fn(() => new Headers()),
}));

const mockFindForClientView = vi.fn();
const mockFindWalletById = vi.fn();
const mockGetMemberRole = vi.fn();
const mockResolveBillingAdminName = vi.fn();

vi.mock('@balo/db', () => ({
  creditSessionsRepository: {
    findForClientView: (...a: unknown[]) => mockFindForClientView(...a),
  },
  creditWalletsRepository: {
    findById: (...a: unknown[]) => mockFindWalletById(...a),
  },
  partyMembershipsRepository: {
    getMemberRole: (...a: unknown[]) => mockGetMemberRole(...a),
    resolveBillingAdminName: (...a: unknown[]) => mockResolveBillingAdminName(...a),
  },
}));

const mockGetCurrentUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  getCurrentUser: (...a: unknown[]) => mockGetCurrentUser(...a),
}));

vi.mock('@/lib/authz', () => ({
  // Only owner/admin hold MANAGE_BILLING (mirrors the pure @balo/shared/authz map).
  roleHasCapability: (role: string, cap: string) =>
    (role === 'owner' || role === 'admin') && cap === 'manage_billing',
  CAPABILITIES: { MANAGE_BILLING: 'manage_billing' },
}));

import { getSessionDrawdownState } from './get-drawdown-state';

const SESSION_ID = 'c0000000-0000-4000-8000-000000000002';
const NOW = new Date('2026-07-16T12:00:00.000Z');

/** A live, healthy client session view (100 minutes of A$4.50/min runway). */
function sessionView(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SESSION_ID,
    walletId: 'wal-1',
    companyId: 'co-1',
    expertProfileId: 'exp-1',
    status: 'active',
    settlementStatus: 'not_required',
    clientRateMinorPerMinute: 450,
    effectiveCeilingMinor: 15000,
    graceBoundMinutes: 30,
    connectedAt: new Date('2026-07-16T11:00:00.000Z'),
    graceEnteredAt: null,
    ...overrides,
  };
}

function walletRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'wal-1',
    balanceMinor: 45000,
    mandateStatus: 'active',
    stripeCustomerId: 'cus_1',
    stripePaymentMethodId: 'pm_1',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
  mockFindForClientView.mockResolvedValue(sessionView());
  mockFindWalletById.mockResolvedValue(walletRow());
  mockGetMemberRole.mockResolvedValue('owner'); // MANAGE_BILLING → client lens
});

describe('getSessionDrawdownState', () => {
  it('returns null when there is no signed-in viewer', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    expect(await getSessionDrawdownState(SESSION_ID, NOW)).toBeNull();
    expect(mockFindForClientView).not.toHaveBeenCalled();
  });

  it('returns null when the session is not found', async () => {
    mockFindForClientView.mockResolvedValue(undefined);
    expect(await getSessionDrawdownState(SESSION_ID, NOW)).toBeNull();
  });

  it('returns null when the wallet is not found', async () => {
    mockFindWalletById.mockResolvedValue(undefined);
    expect(await getSessionDrawdownState(SESSION_ID, NOW)).toBeNull();
  });

  it('DENIES (null) a viewer who is not a live member of the session company', async () => {
    mockGetMemberRole.mockResolvedValue(undefined);
    expect(await getSessionDrawdownState(SESSION_ID, NOW)).toBeNull();
    expect(mockGetMemberRole).toHaveBeenCalledWith('company', 'co-1', 'user-1');
    // The billing-admin name is never resolved for a denied viewer.
    expect(mockResolveBillingAdminName).not.toHaveBeenCalled();
  });

  it('resolves the CLIENT lens for a MANAGE_BILLING member (no admin lookup)', async () => {
    const state = await getSessionDrawdownState(SESSION_ID, NOW);

    expect(mockGetMemberRole).toHaveBeenCalledWith('company', 'co-1', 'user-1');
    expect(state?.lens).toBe('client');
    expect(state?.adminName).toBeUndefined();
    expect(mockResolveBillingAdminName).not.toHaveBeenCalled();
    expect(state?.key).toBe('healthy');
  });

  it('resolves the MEMBER lens for a base member and names the billing admin', async () => {
    mockGetMemberRole.mockResolvedValue('member');
    mockResolveBillingAdminName.mockResolvedValue('Sam Lee');

    const state = await getSessionDrawdownState(SESSION_ID, NOW);

    expect(state?.lens).toBe('member');
    expect(state?.adminName).toBe('Sam Lee');
    expect(mockResolveBillingAdminName).toHaveBeenCalledWith('co-1');
  });

  it('leaves adminName undefined on the member lens when no billing admin exists', async () => {
    mockGetMemberRole.mockResolvedValue('member');
    mockResolveBillingAdminName.mockResolvedValue(undefined);

    const state = await getSessionDrawdownState(SESSION_ID, NOW);

    expect(state?.lens).toBe('member');
    expect(state?.adminName).toBeUndefined();
  });

  it('treats a wallet without both Stripe secrets as mandate-absent', async () => {
    mockFindWalletById.mockResolvedValue(walletRow({ stripePaymentMethodId: null }));

    const state = await getSessionDrawdownState(SESSION_ID, NOW);

    expect(state?.mandatePresent).toBe(false);
  });

  it('never leaks the word "overdraft" into any derived copy', async () => {
    mockGetMemberRole.mockResolvedValue('member');
    mockResolveBillingAdminName.mockResolvedValue(undefined);
    // Drain to a negative balance in grace so the "keeping you going" copy is exercised.
    mockFindForClientView.mockResolvedValue(
      sessionView({ status: 'grace', graceEnteredAt: new Date('2026-07-16T11:58:00.000Z') })
    );
    mockFindWalletById.mockResolvedValue(walletRow({ balanceMinor: -2000 }));

    const state = await getSessionDrawdownState(SESSION_ID, NOW);

    const blob = JSON.stringify(state).toLowerCase();
    expect(blob).not.toContain('overdraft');
    expect(state?.key).toBe('grace');
  });
});

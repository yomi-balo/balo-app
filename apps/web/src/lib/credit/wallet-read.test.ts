import { describe, it, expect, vi, beforeEach } from 'vitest';

// @balo/db repositories, the authz seam, the pricing staleness check, and the buyer-currency
// resolution are all mocked so the read logic is exercised in isolation (no DB, no session).
const mockHasCapability = vi.fn();
vi.mock('@/lib/authz', () => ({
  hasCapability: (...a: unknown[]) => mockHasCapability(...a),
  CAPABILITIES: { MANAGE_BILLING: 'billing.manage' },
}));

const mockFindByCompanyId = vi.fn();
const mockGetLatest = vi.fn();
const mockListBillingUserIds = vi.fn();
const mockFindById = vi.fn();
vi.mock('@balo/db', () => ({
  creditWalletsRepository: { findByCompanyId: (...a: unknown[]) => mockFindByCompanyId(...a) },
  fxDisplayRatesRepository: { getLatest: (...a: unknown[]) => mockGetLatest(...a) },
  partyMembershipsRepository: {
    listBillingUserIds: (...a: unknown[]) => mockListBillingUserIds(...a),
  },
  usersRepository: { findById: (...a: unknown[]) => mockFindById(...a) },
}));

const mockIsFxRateStale = vi.fn();
vi.mock('@balo/shared/pricing', () => ({
  isFxRateStale: (...a: unknown[]) => mockIsFxRateStale(...a),
}));

const mockResolveBuyerCurrency = vi.fn();
const mockResolveDisplayQuote = vi.fn();
vi.mock('@/lib/credit/display-fx', () => ({
  resolveBuyerCurrency: () => mockResolveBuyerCurrency(),
  resolveDisplayQuote: (...a: unknown[]) => mockResolveDisplayQuote(...a),
}));

import { loadDashboardWalletData, resolveDisplayFx, resolveBillingAdminLabel } from './wallet-read';

beforeEach(() => {
  vi.clearAllMocks();
  // Defaults: AUD buyer (no indicative FX), no wallet, no billing users, member (no capability).
  mockResolveBuyerCurrency.mockReturnValue('AUD');
  mockResolveDisplayQuote.mockReturnValue(null);
  mockHasCapability.mockResolvedValue(false);
  mockFindByCompanyId.mockResolvedValue(undefined);
  mockListBillingUserIds.mockResolvedValue([]);
});

describe('resolveDisplayFx', () => {
  it('returns a snapshot for a fresh, finite, positive rate', async () => {
    mockGetLatest.mockResolvedValue({ asOf: new Date(), rate: '0.642' });
    mockIsFxRateStale.mockReturnValue(false);
    expect(await resolveDisplayFx('USD')).toEqual({ currency: 'USD', audToQuote: 0.642 });
  });

  it('returns null when the rate row is missing', async () => {
    mockGetLatest.mockResolvedValue(undefined);
    expect(await resolveDisplayFx('USD')).toBeNull();
  });

  it('returns null when the rate is stale (indistinguishable from missing)', async () => {
    mockGetLatest.mockResolvedValue({ asOf: new Date(0), rate: '0.642' });
    mockIsFxRateStale.mockReturnValue(true);
    expect(await resolveDisplayFx('USD')).toBeNull();
  });

  it('returns null for a non-finite or non-positive rate', async () => {
    mockIsFxRateStale.mockReturnValue(false);
    mockGetLatest.mockResolvedValue({ asOf: new Date(), rate: 'not-a-number' });
    expect(await resolveDisplayFx('EUR')).toBeNull();
    mockGetLatest.mockResolvedValue({ asOf: new Date(), rate: '0' });
    expect(await resolveDisplayFx('EUR')).toBeNull();
  });
});

describe('resolveBillingAdminLabel', () => {
  it('resolves the first billing holder full name', async () => {
    mockListBillingUserIds.mockResolvedValue(['u-1']);
    mockFindById.mockResolvedValue({ firstName: 'Dana', lastName: 'Ng' });
    expect(await resolveBillingAdminLabel('co-1')).toBe('Dana Ng');
  });

  it('falls back to a warm generic when there is no billing holder', async () => {
    mockListBillingUserIds.mockResolvedValue([]);
    expect(await resolveBillingAdminLabel('co-1')).toBe('your billing admin');
  });

  it('falls back to a warm generic when the holder has no name', async () => {
    mockListBillingUserIds.mockResolvedValue(['u-1']);
    mockFindById.mockResolvedValue({ firstName: null, lastName: null });
    expect(await resolveBillingAdminLabel('co-1')).toBe('your billing admin');
  });
});

describe('loadDashboardWalletData', () => {
  it('returns the holder branch with fx passed through when the actor can manage billing', async () => {
    mockHasCapability.mockResolvedValue(true);
    mockResolveDisplayQuote.mockReturnValue('USD');
    mockFindByCompanyId.mockResolvedValue({ balanceMinor: 34_700 });
    mockGetLatest.mockResolvedValue({ asOf: new Date(), rate: '0.642' });
    mockIsFxRateStale.mockReturnValue(false);

    const data = await loadDashboardWalletData({ id: 'u-1' }, 'co-1');

    expect(data).toEqual({
      kind: 'holder',
      balanceMinor: 34_700,
      fx: { currency: 'USD', audToQuote: 0.642 },
    });
    expect(mockHasCapability).toHaveBeenCalledWith({ id: 'u-1' }, 'billing.manage', {
      companyId: 'co-1',
    });
  });

  it('holder gets fx=null for an AUD buyer (the inert default today)', async () => {
    mockHasCapability.mockResolvedValue(true);
    mockFindByCompanyId.mockResolvedValue({ balanceMinor: 12_000 });

    const data = await loadDashboardWalletData({ id: 'u-1' }, 'co-1');

    expect(data).toEqual({ kind: 'holder', balanceMinor: 12_000, fx: null });
    // AUD buyer ⇒ null quote ⇒ the FX row is never fetched.
    expect(mockGetLatest).not.toHaveBeenCalled();
  });

  it('defaults balanceMinor to 0 when no wallet is provisioned', async () => {
    mockHasCapability.mockResolvedValue(true);
    mockFindByCompanyId.mockResolvedValue(undefined);

    const data = await loadDashboardWalletData({ id: 'u-1' }, 'co-1');

    expect(data).toEqual({ kind: 'holder', balanceMinor: 0, fx: null });
  });

  it('returns the member branch with the resolved admin label when the actor cannot manage billing', async () => {
    mockHasCapability.mockResolvedValue(false);
    mockFindByCompanyId.mockResolvedValue({ balanceMinor: 1_820 });
    mockListBillingUserIds.mockResolvedValue(['admin-1']);
    mockFindById.mockResolvedValue({ firstName: 'Sam', lastName: null });

    const data = await loadDashboardWalletData({ id: 'u-9' }, 'co-1');

    expect(data).toEqual({ kind: 'member', balanceMinor: 1_820, adminLabel: 'Sam' });
  });

  it('member branch falls back to the generic admin label when unresolved', async () => {
    mockHasCapability.mockResolvedValue(false);
    mockFindByCompanyId.mockResolvedValue(undefined);
    mockListBillingUserIds.mockResolvedValue([]);

    const data = await loadDashboardWalletData({ id: 'u-9' }, 'co-1');

    expect(data).toEqual({ kind: 'member', balanceMinor: 0, adminLabel: 'your billing admin' });
  });
});

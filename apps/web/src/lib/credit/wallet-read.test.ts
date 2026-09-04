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
const mockFindBillingIdentityById = vi.fn();
const mockGetMemberRole = vi.fn();
const mockFindDisplayById = vi.fn();
vi.mock('@balo/db', () => ({
  creditWalletsRepository: { findByCompanyId: (...a: unknown[]) => mockFindByCompanyId(...a) },
  fxDisplayRatesRepository: { getLatest: (...a: unknown[]) => mockGetLatest(...a) },
  partyMembershipsRepository: {
    listBillingUserIds: (...a: unknown[]) => mockListBillingUserIds(...a),
    getMemberRole: (...a: unknown[]) => mockGetMemberRole(...a),
  },
  usersRepository: {
    findById: (...a: unknown[]) => mockFindById(...a),
    findDisplayById: (...a: unknown[]) => mockFindDisplayById(...a),
  },
  companiesRepository: {
    findBillingIdentityById: (...a: unknown[]) => mockFindBillingIdentityById(...a),
  },
}));

const mockIsFxRateStale = vi.fn();
vi.mock('@balo/shared/pricing', () => ({
  isFxRateStale: (...a: unknown[]) => mockIsFxRateStale(...a),
  DEFAULT_TOPUP_RELOAD_MINOR: 10_000,
  DEFAULT_TOPUP_THRESHOLD_MINOR: 2_000,
}));

const mockResolveBuyerCurrency = vi.fn();
const mockResolveDisplayQuote = vi.fn();
vi.mock('@/lib/credit/display-fx', () => ({
  resolveBuyerCurrency: () => mockResolveBuyerCurrency(),
  resolveDisplayQuote: (...a: unknown[]) => mockResolveDisplayQuote(...a),
}));

import type { CreditWallet } from '@balo/db';
import {
  loadDashboardWalletData,
  loadTopBarWalletData,
  loadBillingSettingsWallet,
  resolveDisplayFx,
  resolveBillingAdminLabel,
  projectSavedCard,
  projectWalletSnapshot,
  projectBillingEmail,
  UNPROVISIONED_WALLET,
} from './wallet-read';

beforeEach(() => {
  vi.clearAllMocks();
  // Defaults: AUD buyer (no indicative FX), no wallet, no billing users, member (no capability).
  mockResolveBuyerCurrency.mockReturnValue('AUD');
  mockResolveDisplayQuote.mockReturnValue(null);
  mockHasCapability.mockResolvedValue(false);
  mockFindByCompanyId.mockResolvedValue(undefined);
  mockListBillingUserIds.mockResolvedValue([]);
  mockFindBillingIdentityById.mockResolvedValue(undefined);
  mockGetMemberRole.mockResolvedValue('owner');
  mockFindDisplayById.mockResolvedValue(undefined);
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

describe('loadTopBarWalletData', () => {
  it('holder → the balance plus canTopUp: true', async () => {
    mockHasCapability.mockResolvedValue(true);
    mockFindByCompanyId.mockResolvedValue({ balanceMinor: 42_000 });

    const data = await loadTopBarWalletData('u-1', 'co-1');

    expect(data).toEqual({ balanceMinor: 42_000, canTopUp: true });
    expect(mockHasCapability).toHaveBeenCalledWith({ id: 'u-1' }, 'billing.manage', {
      companyId: 'co-1',
    });
  });

  it('member → the SAME balance, canTopUp: false (D8 — no narrower money-visibility policy)', async () => {
    mockHasCapability.mockResolvedValue(false);
    mockFindByCompanyId.mockResolvedValue({ balanceMinor: 1_820 });

    const data = await loadTopBarWalletData('u-9', 'co-1');

    expect(data).toEqual({ balanceMinor: 1_820, canTopUp: false });
  });

  it('defaults balanceMinor to 0 when no wallet is provisioned', async () => {
    mockHasCapability.mockResolvedValue(true);
    mockFindByCompanyId.mockResolvedValue(undefined);

    const data = await loadTopBarWalletData('u-1', 'co-1');

    expect(data).toEqual({ balanceMinor: 0, canTopUp: true });
  });

  it('never reads the billing-admin label or the indicative FX — the Q3 cost mitigation', async () => {
    mockHasCapability.mockResolvedValue(false);
    mockFindByCompanyId.mockResolvedValue({ balanceMinor: 1_820 });

    await loadTopBarWalletData('u-9', 'co-1');

    expect(mockListBillingUserIds).not.toHaveBeenCalled();
    expect(mockFindById).not.toHaveBeenCalled();
    expect(mockGetLatest).not.toHaveBeenCalled();
  });
});

describe('projectSavedCard', () => {
  const displayFields = {
    cardBrand: 'visa',
    cardLast4: '4242',
    cardExpMonth: 8,
    cardExpYear: 2028,
  };

  it('returns null when the display columns are present but the payment-method id is gone', () => {
    expect(
      projectSavedCard({
        ...displayFields,
        stripeCustomerId: 'cus_1',
        stripePaymentMethodId: null,
        mandateStatus: 'active',
      })
    ).toBeNull();
  });

  it('returns null when the customer id is gone', () => {
    expect(
      projectSavedCard({
        ...displayFields,
        stripeCustomerId: null,
        stripePaymentMethodId: 'pm_1',
        mandateStatus: 'active',
      })
    ).toBeNull();
  });

  it('returns null when any display column is null', () => {
    expect(
      projectSavedCard({
        ...displayFields,
        cardBrand: null,
        stripeCustomerId: 'cus_1',
        stripePaymentMethodId: 'pm_1',
        mandateStatus: 'active',
      })
    ).toBeNull();
  });

  it('maps mandateStatus to mandateActive: true only for "active"', () => {
    expect(
      projectSavedCard({
        ...displayFields,
        stripeCustomerId: 'cus_1',
        stripePaymentMethodId: 'pm_1',
        mandateStatus: 'active',
      })
    ).toEqual({ brand: 'visa', last4: '4242', expMonth: 8, expYear: 2028, mandateActive: true });
  });

  it('maps a pending/null mandateStatus to mandateActive: false', () => {
    expect(
      projectSavedCard({
        ...displayFields,
        stripeCustomerId: 'cus_1',
        stripePaymentMethodId: 'pm_1',
        mandateStatus: 'pending',
      })
    ).toEqual(expect.objectContaining({ mandateActive: false }));
    expect(
      projectSavedCard({
        ...displayFields,
        stripeCustomerId: 'cus_1',
        stripePaymentMethodId: 'pm_1',
        mandateStatus: null,
      })
    ).toEqual(expect.objectContaining({ mandateActive: false }));
  });
});

describe('projectWalletSnapshot', () => {
  it('projects the full wallet row into the serialisable snapshot', () => {
    const wallet = {
      id: 'wallet-1',
      balanceMinor: 5_000,
      lowBalanceMode: 'auto_topup',
      topupReloadMinor: 30_000,
      topupThresholdMinor: 5_000,
      cardBrand: 'visa',
      cardLast4: '4242',
      cardExpMonth: 8,
      cardExpYear: 2028,
      stripeCustomerId: 'cus_1',
      stripePaymentMethodId: 'pm_1',
      mandateStatus: 'active',
    } as unknown as CreditWallet;

    expect(projectWalletSnapshot(wallet)).toEqual({
      walletId: 'wallet-1',
      balanceMinor: 5_000,
      lowBalanceMode: 'auto_topup',
      savedCard: {
        brand: 'visa',
        last4: '4242',
        expMonth: 8,
        expYear: 2028,
        mandateActive: true,
      },
      topupReloadMinor: 30_000,
      topupThresholdMinor: 5_000,
    });
  });
});

describe('projectBillingEmail', () => {
  it('returns the pre-seed empty state when the company is undefined', () => {
    expect(projectBillingEmail(undefined, { name: null, isFormerMember: false })).toEqual({
      email: null,
      source: null,
      setAt: null,
      setByName: null,
      setByIsFormerMember: false,
    });
  });

  it('returns the pre-seed empty state when billingEmail is null', () => {
    expect(
      projectBillingEmail(
        {
          id: 'co-1',
          name: 'Northwind Industrial',
          isPersonal: false,
          billingEmail: null,
          billingEmailSource: null,
          billingEmailSetByUserId: null,
          billingEmailSetAt: null,
        },
        { name: null, isFormerMember: false }
      )
    ).toEqual({
      email: null,
      source: null,
      setAt: null,
      setByName: null,
      setByIsFormerMember: false,
    });
  });

  it('projects a seeded/set row with its resolved attribution', () => {
    const setAt = new Date('2026-08-01T00:00:00.000Z');
    expect(
      projectBillingEmail(
        {
          id: 'co-1',
          name: 'Northwind Industrial',
          isPersonal: false,
          billingEmail: 'dana@northwind.test',
          billingEmailSource: 'seeded',
          billingEmailSetByUserId: 'user-1',
          billingEmailSetAt: setAt,
        },
        { name: 'Dana Okoro', isFormerMember: true }
      )
    ).toEqual({
      email: 'dana@northwind.test',
      source: 'seeded',
      setAt: setAt.toISOString(),
      setByName: 'Dana Okoro',
      setByIsFormerMember: true,
    });
  });
});

describe('loadBillingSettingsWallet', () => {
  it('returns null for a member — no company read is issued', async () => {
    mockHasCapability.mockResolvedValue(false);
    mockFindByCompanyId.mockResolvedValue({ balanceMinor: 1_820 });

    const result = await loadBillingSettingsWallet({ id: 'u-9' }, 'co-1');

    expect(result).toBeNull();
    expect(mockFindBillingIdentityById).not.toHaveBeenCalled();
  });

  it('returns UNPROVISIONED_WALLET + the pre-seed billingEmail for a holder with no wallet row', async () => {
    mockHasCapability.mockResolvedValue(true);
    mockFindByCompanyId.mockResolvedValue(undefined);
    mockFindBillingIdentityById.mockResolvedValue(undefined);

    const result = await loadBillingSettingsWallet({ id: 'u-1' }, 'co-1');

    expect(result).toEqual({
      wallet: UNPROVISIONED_WALLET,
      billingEmail: {
        email: null,
        source: null,
        setAt: null,
        setByName: null,
        setByIsFormerMember: false,
      },
    });
  });

  it('returns the projected wallet snapshot + billingEmail for a holder with a wallet row', async () => {
    mockHasCapability.mockResolvedValue(true);
    mockFindByCompanyId.mockResolvedValue({
      id: 'wallet-1',
      balanceMinor: 12_000,
      lowBalanceMode: 'notify_only',
      topupReloadMinor: 30_000,
      topupThresholdMinor: 5_000,
      cardBrand: null,
      cardLast4: null,
      cardExpMonth: null,
      cardExpYear: null,
      stripeCustomerId: null,
      stripePaymentMethodId: null,
      mandateStatus: null,
    });
    const setAt = new Date('2026-08-05T00:00:00.000Z');
    mockFindBillingIdentityById.mockResolvedValue({
      id: 'co-1',
      name: 'Northwind Industrial',
      isPersonal: false,
      billingEmail: 'billing@northwind.test',
      billingEmailSource: 'set',
      billingEmailSetByUserId: 'user-1',
      billingEmailSetAt: setAt,
    });
    mockGetMemberRole.mockResolvedValue('owner');
    mockFindDisplayById.mockResolvedValue({ firstName: 'Dana', lastName: 'Okoro' });

    const result = await loadBillingSettingsWallet({ id: 'u-1' }, 'co-1');

    expect(result).toEqual({
      wallet: {
        walletId: 'wallet-1',
        balanceMinor: 12_000,
        lowBalanceMode: 'notify_only',
        savedCard: null,
        topupReloadMinor: 30_000,
        topupThresholdMinor: 5_000,
      },
      billingEmail: {
        email: 'billing@northwind.test',
        source: 'set',
        setAt: setAt.toISOString(),
        setByName: 'Dana Okoro',
        setByIsFormerMember: false,
      },
    });
  });

  it('setByIsFormerMember is true when getMemberRole resolves undefined (departed)', async () => {
    mockHasCapability.mockResolvedValue(true);
    mockFindByCompanyId.mockResolvedValue(undefined);
    mockFindBillingIdentityById.mockResolvedValue({
      id: 'co-1',
      name: 'Northwind Industrial',
      isPersonal: false,
      billingEmail: 'billing@northwind.test',
      billingEmailSource: 'set',
      billingEmailSetByUserId: 'user-1',
      billingEmailSetAt: new Date('2026-08-05T00:00:00.000Z'),
    });
    mockGetMemberRole.mockResolvedValue(undefined);
    mockFindDisplayById.mockResolvedValue({ firstName: 'Dana', lastName: 'Okoro' });

    const result = await loadBillingSettingsWallet({ id: 'u-1' }, 'co-1');

    expect(result?.billingEmail.setByIsFormerMember).toBe(true);
  });

  it('setByName is null when findDisplayById resolves undefined', async () => {
    mockHasCapability.mockResolvedValue(true);
    mockFindByCompanyId.mockResolvedValue(undefined);
    mockFindBillingIdentityById.mockResolvedValue({
      id: 'co-1',
      name: 'Northwind Industrial',
      isPersonal: false,
      billingEmail: 'billing@northwind.test',
      billingEmailSource: 'set',
      billingEmailSetByUserId: 'user-1',
      billingEmailSetAt: new Date('2026-08-05T00:00:00.000Z'),
    });
    mockGetMemberRole.mockResolvedValue('owner');
    mockFindDisplayById.mockResolvedValue(undefined);

    const result = await loadBillingSettingsWallet({ id: 'u-1' }, 'co-1');

    expect(result?.billingEmail.setByName).toBeNull();
  });

  it('issues no attribution reads at all when billingEmailSetByUserId is null', async () => {
    mockHasCapability.mockResolvedValue(true);
    mockFindByCompanyId.mockResolvedValue(undefined);
    mockFindBillingIdentityById.mockResolvedValue(undefined);

    await loadBillingSettingsWallet({ id: 'u-1' }, 'co-1');

    expect(mockGetMemberRole).not.toHaveBeenCalled();
    expect(mockFindDisplayById).not.toHaveBeenCalled();
  });
});

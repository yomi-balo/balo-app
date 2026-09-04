import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { log } from '@/lib/logging';
import type { DashboardWalletData } from '@/lib/credit/wallet-read';

const {
  mockRequireUser,
  mockLoadDashboardWalletData,
  mockLoadBillingSettingsWallet,
  mockNotFound,
  mockBuildNavContext,
} = vi.hoisted(() => ({
  mockRequireUser: vi.fn(),
  mockLoadDashboardWalletData: vi.fn(),
  mockLoadBillingSettingsWallet: vi.fn(),
  mockNotFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  mockBuildNavContext: vi.fn(),
}));

vi.mock('next/navigation', () => ({ notFound: mockNotFound }));
vi.mock('@/lib/auth/session', () => ({ requireUser: mockRequireUser }));
vi.mock('@/lib/navigation/nav-context', () => ({ buildNavContext: mockBuildNavContext }));
vi.mock('@/lib/credit/wallet-read', () => ({
  loadDashboardWalletData: mockLoadDashboardWalletData,
  loadBillingSettingsWallet: mockLoadBillingSettingsWallet,
}));
vi.mock('./_components/credits-summary', () => ({
  CreditsSummary: ({ data }: { data: DashboardWalletData }) => (
    <div
      data-testid="summary"
      data-kind={data.kind}
      data-balance={String(data.balanceMinor)}
      data-admin={data.kind === 'member' ? data.adminLabel : ''}
    />
  ),
}));
vi.mock('./_components/billing-settings-sections', () => ({
  BillingSettingsSections: ({ wallet }: { wallet: { walletId: string | null } }) => (
    <div data-testid="billing-settings-sections" data-wallet-id={String(wallet.walletId)} />
  ),
}));

import CreditsBillingPage from './page';

beforeEach(() => {
  vi.clearAllMocks();
  mockNotFound.mockImplementation(() => {
    throw new Error('NEXT_NOT_FOUND');
  });
  // Default to a company workspace; the expert case overrides it.
  mockBuildNavContext.mockResolvedValue({ workspaceType: 'company', capabilities: [] });
  mockLoadBillingSettingsWallet.mockResolvedValue(null);
});

describe('CreditsBillingPage', () => {
  it('refuses an unauthenticated actor via requireUser (the money-surface gate)', async () => {
    mockRequireUser.mockRejectedValue(new Error('Unauthorized'));
    await expect(CreditsBillingPage()).rejects.toThrow('Unauthorized');
    expect(mockLoadDashboardWalletData).not.toHaveBeenCalled();
  });

  it('notFound()s on an expert workspace, and never reads the wallet', async () => {
    // WalletWidget declares "HARD BOUNDARY: client-lens only". Without this gate an
    // expert-workspace actor who typed the URL would render it and make that comment false.
    mockRequireUser.mockResolvedValue({ id: 'user-9', companyId: 'company-9' });
    mockBuildNavContext.mockResolvedValue({ workspaceType: 'expert', capabilities: [] });

    await expect(CreditsBillingPage()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(mockLoadDashboardWalletData).not.toHaveBeenCalled();
  });

  it('renders the holder summary', async () => {
    mockRequireUser.mockResolvedValue({ id: 'user-1', companyId: 'company-1' });
    mockLoadDashboardWalletData.mockResolvedValue({
      kind: 'holder',
      balanceMinor: 25_000,
      fx: null,
    });

    const ui = await CreditsBillingPage();
    render(ui);

    const summary = screen.getByTestId('summary');
    expect(summary).toHaveAttribute('data-kind', 'holder');
    expect(summary).toHaveAttribute('data-balance', '25000');
    expect(mockLoadDashboardWalletData).toHaveBeenCalledWith({ id: 'user-1' }, 'company-1');
  });

  it('renders the member summary', async () => {
    mockRequireUser.mockResolvedValue({ id: 'user-2', companyId: 'company-2' });
    mockLoadDashboardWalletData.mockResolvedValue({
      kind: 'member',
      balanceMinor: 0,
      adminLabel: 'Dana Lee',
    });

    const ui = await CreditsBillingPage();
    render(ui);

    const summary = screen.getByTestId('summary');
    expect(summary).toHaveAttribute('data-kind', 'member');
    expect(summary).toHaveAttribute('data-admin', 'Dana Lee');
  });

  it('logs and rethrows when the helper throws', async () => {
    mockRequireUser.mockResolvedValue({ id: 'user-1', companyId: 'company-1' });
    mockLoadDashboardWalletData.mockRejectedValue(new Error('db down'));

    await expect(CreditsBillingPage()).rejects.toThrow('db down');
    expect(log.error).toHaveBeenCalledWith(
      'Failed to load credits & billing settings',
      expect.objectContaining({ userId: 'user-1', companyId: 'company-1' })
    );
  });

  it('logs and rethrows when the BAL-516 billing-settings read throws (same try/catch)', async () => {
    mockRequireUser.mockResolvedValue({ id: 'user-1', companyId: 'company-1' });
    mockLoadDashboardWalletData.mockResolvedValue({
      kind: 'holder',
      balanceMinor: 25_000,
      fx: null,
    });
    mockLoadBillingSettingsWallet.mockRejectedValue(new Error('read failed'));

    await expect(CreditsBillingPage()).rejects.toThrow('read failed');
    expect(log.error).toHaveBeenCalledWith(
      'Failed to load credits & billing settings',
      expect.objectContaining({ userId: 'user-1', companyId: 'company-1' })
    );
  });

  it('renders BillingSettingsSections for a MANAGE_BILLING holder, fetched alongside the summary read', async () => {
    mockRequireUser.mockResolvedValue({ id: 'user-1', companyId: 'company-1' });
    mockLoadDashboardWalletData.mockResolvedValue({
      kind: 'holder',
      balanceMinor: 25_000,
      fx: null,
    });
    mockLoadBillingSettingsWallet.mockResolvedValue({
      wallet: {
        walletId: 'wallet-1',
        balanceMinor: 25_000,
        lowBalanceMode: 'notify_only',
        savedCard: null,
        topupReloadMinor: 10_000,
        topupThresholdMinor: 2_000,
      },
      billingEmail: {
        email: null,
        source: null,
        setAt: null,
        setByName: null,
        setByIsFormerMember: false,
      },
    });

    const ui = await CreditsBillingPage();
    render(ui);

    const sections = screen.getByTestId('billing-settings-sections');
    expect(sections).toHaveAttribute('data-wallet-id', 'wallet-1');
    expect(mockLoadDashboardWalletData).toHaveBeenCalledWith({ id: 'user-1' }, 'company-1');
    expect(mockLoadBillingSettingsWallet).toHaveBeenCalledWith({ id: 'user-1' }, 'company-1');
  });

  it('keys BillingSettingsSections to the owning COMPANY, so a workspace switch (bare router.refresh() on this route) remounts it instead of reconciling in place (review NEW-1, fix round 2 G1)', async () => {
    mockRequireUser.mockResolvedValue({ id: 'user-1', companyId: 'company-1' });
    mockLoadDashboardWalletData.mockResolvedValue({
      kind: 'holder',
      balanceMinor: 25_000,
      fx: null,
    });
    mockLoadBillingSettingsWallet.mockResolvedValue({
      wallet: {
        walletId: 'wallet-1',
        balanceMinor: 25_000,
        lowBalanceMode: 'notify_only',
        savedCard: null,
        topupReloadMinor: 10_000,
        topupThresholdMinor: 2_000,
      },
      billingEmail: {
        email: null,
        source: null,
        setAt: null,
        setByName: null,
        setByIsFormerMember: false,
      },
    });

    const ui = await CreditsBillingPage();
    // `BillingSettingsSections`'s own coordinator model (seeded from `wallet` ONCE at mount, per
    // its docblock) is only safe under this key — without it, a different company's wallet
    // reconciles into the SAME mounted instance and the remove dialog can state the wrong
    // company's mode consequence (review NEW-1's proven failure). React strips `key` out of
    // `props`, so it must be read off the element itself, not rendered and inspected via the DOM.
    const [, sectionsElement] = (ui as { props: { children: unknown[] } }).props.children;
    expect((sectionsElement as { key: string | null }).key).toBe('company-1');
  });

  it('renders no BillingSettingsSections for a non-holder (loadBillingSettingsWallet → null) — absent, not an empty state', async () => {
    mockRequireUser.mockResolvedValue({ id: 'user-2', companyId: 'company-2' });
    mockLoadDashboardWalletData.mockResolvedValue({
      kind: 'member',
      balanceMinor: 0,
      adminLabel: 'Dana Lee',
    });
    mockLoadBillingSettingsWallet.mockResolvedValue(null);

    const ui = await CreditsBillingPage();
    render(ui);

    expect(screen.getByTestId('summary')).toBeInTheDocument();
    expect(screen.queryByTestId('billing-settings-sections')).not.toBeInTheDocument();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { log } from '@/lib/logging';
import type { DashboardWalletData } from '@/lib/credit/wallet-read';

const { mockRequireUser, mockLoadDashboardWalletData, mockNotFound, mockBuildNavContext } =
  vi.hoisted(() => ({
    mockRequireUser: vi.fn(),
    mockLoadDashboardWalletData: vi.fn(),
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

import CreditsBillingPage from './page';

beforeEach(() => {
  vi.clearAllMocks();
  mockNotFound.mockImplementation(() => {
    throw new Error('NEXT_NOT_FOUND');
  });
  // Default to a company workspace; the expert case overrides it.
  mockBuildNavContext.mockResolvedValue({ workspaceType: 'company', capabilities: [] });
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
});

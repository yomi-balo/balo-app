import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import type { WalletSnapshot, DisplayFxSnapshot } from '@/components/billing/top-up/types';

// ── Seams the top-up RSC page composes (mirrors the promo-codes RSC page-test precedent) ──
const {
  mockRequireUser,
  mockGetCompanyContext,
  mockHasCapability,
  mockFindWallet,
  mockListBillingUserIds,
  mockFindUserById,
  mockGetLatestFx,
  mockIsFxRateStale,
  mockResolveBuyerCurrency,
  mockResolveDisplayQuote,
} = vi.hoisted(() => ({
  mockRequireUser: vi.fn(),
  mockGetCompanyContext: vi.fn(),
  mockHasCapability: vi.fn(),
  mockFindWallet: vi.fn(),
  mockListBillingUserIds: vi.fn(),
  mockFindUserById: vi.fn(),
  mockGetLatestFx: vi.fn(),
  mockIsFxRateStale: vi.fn(),
  mockResolveBuyerCurrency: vi.fn(),
  mockResolveDisplayQuote: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  creditWalletsRepository: { findByCompanyId: mockFindWallet },
  partyMembershipsRepository: { listBillingUserIds: mockListBillingUserIds },
  usersRepository: { findById: mockFindUserById },
  fxDisplayRatesRepository: { getLatest: mockGetLatestFx },
}));
vi.mock('@balo/shared/pricing', () => ({ isFxRateStale: mockIsFxRateStale }));
vi.mock('@/lib/auth/session', () => ({
  requireUser: mockRequireUser,
  getCompanyContext: mockGetCompanyContext,
}));
vi.mock('@/lib/authz', () => ({
  hasCapability: mockHasCapability,
  CAPABILITIES: { MANAGE_BILLING: 'manage_billing' },
}));
vi.mock('@/lib/credit/display-fx', () => ({
  resolveBuyerCurrency: mockResolveBuyerCurrency,
  resolveDisplayQuote: mockResolveDisplayQuote,
}));

// Stub the heavy client children — this stays a unit test of the page's gating + projection.
vi.mock('@/components/billing/top-up/TopUpComposer', () => ({
  TopUpComposer: ({ wallet, fx }: { wallet: WalletSnapshot; fx: DisplayFxSnapshot | null }) => (
    <div
      data-testid="composer"
      data-balance={String(wallet.balanceMinor)}
      data-hascard={String(wallet.hasCard)}
      data-fx={fx ? fx.currency : 'none'}
    />
  ),
}));
vi.mock('@/components/billing/top-up/MemberWalletNudge', () => ({
  MemberWalletNudge: ({
    balanceMinor,
    adminLabel,
    fx,
  }: {
    balanceMinor: number;
    adminLabel: string;
    fx: DisplayFxSnapshot | null;
  }) => (
    <div
      data-testid="nudge"
      data-balance={String(balanceMinor)}
      data-admin={adminLabel}
      data-fx={fx ? fx.currency : 'none'}
    />
  ),
}));

import TopUpPage from './page';

const WALLET = {
  id: 'wallet-1',
  balanceMinor: 25000,
  lowBalanceMode: 'off',
  mandateStatus: 'active',
  topupReloadMinor: 10000,
  topupThresholdMinor: 2000,
};

async function renderPage(): Promise<void> {
  const ui = await TopUpPage();
  render(ui);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireUser.mockResolvedValue({ id: 'user-1' });
  mockGetCompanyContext.mockResolvedValue({ companyId: 'company-1' });
  // Default: AUD buyer → no indicative FX quote.
  mockResolveBuyerCurrency.mockReturnValue('aud');
  mockResolveDisplayQuote.mockReturnValue(null);
});

describe('TopUpPage (RSC) — member (no MANAGE_BILLING) nudge branch', () => {
  it('renders the member nudge with the first billing holder’s name', async () => {
    mockHasCapability.mockResolvedValue(false);
    mockFindWallet.mockResolvedValue(WALLET);
    mockListBillingUserIds.mockResolvedValue(['admin-1']);
    mockFindUserById.mockResolvedValue({ firstName: 'Dana', lastName: 'Lee' });

    await renderPage();

    const nudge = screen.getByTestId('nudge');
    expect(nudge).toHaveAttribute('data-admin', 'Dana Lee');
    expect(nudge).toHaveAttribute('data-balance', '25000');
    expect(screen.queryByTestId('composer')).not.toBeInTheDocument();
  });

  it('falls back to "your billing admin" when there is no billing holder (no findById call)', async () => {
    mockHasCapability.mockResolvedValue(false);
    mockFindWallet.mockResolvedValue(undefined);
    mockListBillingUserIds.mockResolvedValue([]);

    await renderPage();

    const nudge = screen.getByTestId('nudge');
    expect(nudge).toHaveAttribute('data-admin', 'your billing admin');
    expect(nudge).toHaveAttribute('data-balance', '0');
    expect(mockFindUserById).not.toHaveBeenCalled();
  });

  it('falls back to "your billing admin" when the holder has no name', async () => {
    mockHasCapability.mockResolvedValue(false);
    mockFindWallet.mockResolvedValue(WALLET);
    mockListBillingUserIds.mockResolvedValue(['admin-1']);
    mockFindUserById.mockResolvedValue({ firstName: null, lastName: null });

    await renderPage();

    expect(screen.getByTestId('nudge')).toHaveAttribute('data-admin', 'your billing admin');
  });
});

describe('TopUpPage (RSC) — billing holder composer branch', () => {
  it('shows the "setting up your balance" fallback when no wallet exists yet', async () => {
    mockHasCapability.mockResolvedValue(true);
    mockFindWallet.mockResolvedValue(undefined);

    await renderPage();

    expect(screen.getByText(/setting up your team/i)).toBeInTheDocument();
    expect(screen.queryByTestId('composer')).not.toBeInTheDocument();
    expect(screen.queryByTestId('nudge')).not.toBeInTheDocument();
  });

  it('projects a serialisable wallet snapshot into the composer for an AUD buyer (no FX)', async () => {
    mockHasCapability.mockResolvedValue(true);
    mockFindWallet.mockResolvedValue(WALLET);

    await renderPage();

    const composer = screen.getByTestId('composer');
    expect(composer).toHaveAttribute('data-balance', '25000');
    expect(composer).toHaveAttribute('data-hascard', 'true'); // mandateStatus 'active'
    expect(composer).toHaveAttribute('data-fx', 'none');
    expect(mockGetLatestFx).not.toHaveBeenCalled(); // AUD buyer → quote null → no FX fetch
  });

  it('marks hasCard false when the mandate is not active', async () => {
    mockHasCapability.mockResolvedValue(true);
    mockFindWallet.mockResolvedValue({ ...WALLET, mandateStatus: 'none' });

    await renderPage();

    expect(screen.getByTestId('composer')).toHaveAttribute('data-hascard', 'false');
  });
});

describe('TopUpPage (RSC) — indicative display-FX for a non-AUD buyer', () => {
  beforeEach(() => {
    mockHasCapability.mockResolvedValue(true);
    mockFindWallet.mockResolvedValue(WALLET);
    mockResolveBuyerCurrency.mockReturnValue('usd');
    mockResolveDisplayQuote.mockReturnValue('usd');
  });

  it('passes a fresh, positive rate through to the composer', async () => {
    mockGetLatestFx.mockResolvedValue({ rate: '0.65', asOf: new Date('2026-07-16') });
    mockIsFxRateStale.mockReturnValue(false);

    await renderPage();

    expect(screen.getByTestId('composer')).toHaveAttribute('data-fx', 'usd');
  });

  it('drops a stale rate (fx null)', async () => {
    mockGetLatestFx.mockResolvedValue({ rate: '0.65', asOf: new Date('2020-01-01') });
    mockIsFxRateStale.mockReturnValue(true);

    await renderPage();

    expect(screen.getByTestId('composer')).toHaveAttribute('data-fx', 'none');
  });

  it('drops a missing rate (fx null)', async () => {
    mockGetLatestFx.mockResolvedValue(undefined);

    await renderPage();

    expect(screen.getByTestId('composer')).toHaveAttribute('data-fx', 'none');
  });

  it('drops a non-positive / non-finite rate (fx null)', async () => {
    mockGetLatestFx.mockResolvedValue({ rate: '0', asOf: new Date('2026-07-16') });
    mockIsFxRateStale.mockReturnValue(false);

    await renderPage();

    expect(screen.getByTestId('composer')).toHaveAttribute('data-fx', 'none');
  });
});

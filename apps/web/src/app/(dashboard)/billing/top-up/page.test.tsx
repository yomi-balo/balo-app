import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DEFAULT_TOPUP_RELOAD_MINOR, DEFAULT_TOPUP_THRESHOLD_MINOR } from '@balo/shared/pricing';
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
// Spread the REAL module: the page also reads DEFAULT_TOPUP_{RELOAD,THRESHOLD}_MINOR from here
// for the unprovisioned-wallet projection, and a bare factory would blank them to `undefined`
// — the assertions below would then pass against undefined on both sides.
vi.mock('@balo/shared/pricing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@balo/shared/pricing')>()),
  isFxRateStale: mockIsFxRateStale,
}));
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
      data-savedcard={wallet.savedCard === null ? 'none' : JSON.stringify(wallet.savedCard)}
      data-mode={wallet.lowBalanceMode}
      data-reload={String(wallet.topupReloadMinor)}
      data-threshold={String(wallet.topupThresholdMinor)}
      data-walletid={String(wallet.walletId)}
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

/** A returning buyer: full card display columns AND both Stripe ids, with an active mandate. */
const WALLET = {
  id: 'wallet-1',
  balanceMinor: 25000,
  lowBalanceMode: 'off',
  mandateStatus: 'active',
  topupReloadMinor: 10000,
  topupThresholdMinor: 2000,
  cardBrand: 'visa',
  cardLast4: '4242',
  cardExpMonth: 8,
  cardExpYear: 2028,
  stripeCustomerId: 'cus_1',
  stripePaymentMethodId: 'pm_1',
};

/** A first-time buyer: no card facts and no Stripe ids. */
const NO_CARD_WALLET = {
  ...WALLET,
  mandateStatus: null,
  cardBrand: null,
  cardLast4: null,
  cardExpMonth: null,
  cardExpYear: null,
  stripeCustomerId: null,
  stripePaymentMethodId: null,
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
  it('renders the composer against schema defaults when no wallet row exists yet', async () => {
    // A company that has never held credit has no `credit_wallets` row. That must NOT dead-end
    // the buyer: the row is materialised by the first purchase (`ensureForCompany`), so the
    // composer renders now, showing exactly the figures that row will be created holding.
    mockHasCapability.mockResolvedValue(true);
    mockFindWallet.mockResolvedValue(undefined);

    await renderPage();

    const composer = screen.getByTestId('composer');
    expect(composer).toHaveAttribute('data-balance', '0');
    expect(composer).toHaveAttribute('data-savedcard', 'none');
    expect(composer).toHaveAttribute('data-mode', 'notify_only');
    expect(composer).toHaveAttribute('data-reload', String(DEFAULT_TOPUP_RELOAD_MINOR));
    expect(composer).toHaveAttribute('data-threshold', String(DEFAULT_TOPUP_THRESHOLD_MINOR));
    expect(screen.queryByTestId('nudge')).not.toBeInTheDocument();
  });

  it('projects a serialisable wallet snapshot into the composer for an AUD buyer (no FX)', async () => {
    mockHasCapability.mockResolvedValue(true);
    mockFindWallet.mockResolvedValue(WALLET);

    await renderPage();

    const composer = screen.getByTestId('composer');
    expect(composer).toHaveAttribute('data-balance', '25000');
    expect(composer).toHaveAttribute('data-fx', 'none');
    expect(mockGetLatestFx).not.toHaveBeenCalled(); // AUD buyer → quote null → no FX fetch
  });

  it('projects the four display columns into a savedCard object', async () => {
    mockHasCapability.mockResolvedValue(true);
    mockFindWallet.mockResolvedValue(WALLET);

    await renderPage();

    const savedCard = JSON.parse(
      screen.getByTestId('composer').getAttribute('data-savedcard') ?? 'null'
    );
    expect(savedCard).toEqual({
      brand: 'visa',
      last4: '4242',
      expMonth: 8,
      expYear: 2028,
      mandateActive: true, // mandateStatus 'active'
    });
  });

  it('marks mandateActive FALSE for a card on file without an active mandate', async () => {
    mockHasCapability.mockResolvedValue(true);
    mockFindWallet.mockResolvedValue({ ...WALLET, mandateStatus: 'pending' });

    await renderPage();

    const savedCard = JSON.parse(
      screen.getByTestId('composer').getAttribute('data-savedcard') ?? 'null'
    );
    // The card is chargeable ON-SESSION but Balo may not charge it unattended.
    expect(savedCard.mandateActive).toBe(false);
    expect(savedCard.last4).toBe('4242');
  });

  it('yields savedCard: null when the payment-method id is gone (an uncharge­able card)', async () => {
    mockHasCapability.mockResolvedValue(true);
    // Display columns survive, but the id that actually charges is gone (detached in Stripe).
    mockFindWallet.mockResolvedValue({ ...WALLET, stripePaymentMethodId: null });

    await renderPage();

    expect(screen.getByTestId('composer')).toHaveAttribute('data-savedcard', 'none');
  });

  it('yields savedCard: null when the customer id is gone', async () => {
    mockHasCapability.mockResolvedValue(true);
    mockFindWallet.mockResolvedValue({ ...WALLET, stripeCustomerId: null });

    await renderPage();

    expect(screen.getByTestId('composer')).toHaveAttribute('data-savedcard', 'none');
  });

  it('yields savedCard: null for a first-time buyer with no card facts', async () => {
    mockHasCapability.mockResolvedValue(true);
    mockFindWallet.mockResolvedValue(NO_CARD_WALLET);

    await renderPage();

    expect(screen.getByTestId('composer')).toHaveAttribute('data-savedcard', 'none');
  });

  it('yields savedCard: null for an unprovisioned wallet (no row at all)', async () => {
    mockHasCapability.mockResolvedValue(true);
    mockFindWallet.mockResolvedValue(undefined);

    await renderPage();

    const composer = screen.getByTestId('composer');
    expect(composer).toHaveAttribute('data-savedcard', 'none');
    expect(composer).toHaveAttribute('data-walletid', 'null');
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

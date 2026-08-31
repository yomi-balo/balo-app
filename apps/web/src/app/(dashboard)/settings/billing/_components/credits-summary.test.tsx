import { describe, it, expect, vi, beforeEach } from 'vitest';
import { axe } from 'jest-axe';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@/test/utils';
import { track, SETTINGS_EVENTS, WALLET_EVENTS } from '@/lib/analytics';
import type { DashboardWalletData } from '@/lib/credit/wallet-read';
import { CreditsSummary } from './credits-summary';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CreditsSummary — click analytics', () => {
  // This is the wallet's THIRD surface. Per the BAL-499 precedent it emits its own
  // `settings_billing_*` series rather than sharing the dashboard card's `WALLET_EVENTS`.
  it('emits settings_billing_topup_clicked on the Top up link', async () => {
    const data: DashboardWalletData = { kind: 'holder', balanceMinor: 25_000, fx: null };
    render(<CreditsSummary data={data} />);
    await userEvent.click(screen.getByRole('link', { name: /Top up/ }));
    expect(track).toHaveBeenCalledWith(SETTINGS_EVENTS.BILLING_TOPUP_CLICKED, {
      balance_minor: 25_000,
    });
  });

  it('emits settings_billing_redeem_clicked on the Redeem link', async () => {
    const data: DashboardWalletData = { kind: 'holder', balanceMinor: 0, fx: null };
    render(<CreditsSummary data={data} />);
    await userEvent.click(screen.getByRole('link', { name: /Redeem a code/ }));
    expect(track).toHaveBeenCalledWith(SETTINGS_EVENTS.BILLING_REDEEM_CLICKED, {
      balance_minor: 0,
    });
  });

  it('member nudge reuses the EXISTING wallet_nudge_clicked, minting no new constant', async () => {
    const data: DashboardWalletData = {
      kind: 'member',
      balanceMinor: 0,
      adminLabel: 'Dana Lee',
    };
    render(<CreditsSummary data={data} />);
    const nudge = screen.getByRole('button');
    await userEvent.click(nudge);
    expect(track).toHaveBeenCalledWith(WALLET_EVENTS.NUDGE_CLICKED, { state: 'zero' });
  });
});

describe('CreditsSummary — holder lens', () => {
  it('renders a link to /billing/top-up and one to /redeem', () => {
    const data: DashboardWalletData = { kind: 'holder', balanceMinor: 25_000, fx: null };
    render(<CreditsSummary data={data} />);
    expect(screen.getByRole('link', { name: /Top up/ })).toHaveAttribute('href', '/billing/top-up');
    expect(screen.getByRole('link', { name: /Redeem a code/ })).toHaveAttribute('href', '/redeem');
  });

  it('renders the zero resting state as an invitation, never absence-framed', () => {
    const data: DashboardWalletData = { kind: 'holder', balanceMinor: 0, fx: null };
    render(<CreditsSummary data={data} />);
    expect(screen.getByText(/Top up to start a consultation/)).toBeInTheDocument();
  });

  it('renders the indicative FX line when fx is present', () => {
    const data: DashboardWalletData = {
      kind: 'holder',
      balanceMinor: 25_000,
      fx: { currency: 'USD', audToQuote: 0.65 },
    };
    render(<CreditsSummary data={data} />);
    expect(screen.getByText(/≈/)).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const data: DashboardWalletData = { kind: 'holder', balanceMinor: 25_000, fx: null };
    const { container } = render(<CreditsSummary data={data} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('CreditsSummary — member lens', () => {
  it('renders the nudge, no /billing/top-up link, and no /redeem link', () => {
    const data: DashboardWalletData = {
      kind: 'member',
      balanceMinor: 25_000,
      adminLabel: 'Dana Lee',
    };
    render(<CreditsSummary data={data} />);
    expect(screen.getByText(/Team balance/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Top up/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Redeem a code/ })).not.toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const data: DashboardWalletData = {
      kind: 'member',
      balanceMinor: 0,
      adminLabel: 'Dana Lee',
    };
    const { container } = render(<CreditsSummary data={data} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { track, WALLET_EVENTS } from '@/lib/analytics';

const mockRefresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

// MemberWalletNudge (composed by the card) calls these — stub them so no server code runs.
const mockNudge = vi.fn();
vi.mock('@/lib/credit/actions', () => ({
  nudgeBillingAdminAction: (...a: unknown[]) => mockNudge(...a),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { DashboardWalletCard } from './dashboard-wallet-card';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DashboardWalletCard — holder lens', () => {
  it('renders the balance + a Top-up link and fires wallet_widget_viewed once', () => {
    render(<DashboardWalletCard data={{ kind: 'holder', balanceMinor: 34_700, fx: null }} />);

    expect(screen.getByText('A$347.00')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /top up/i })).toHaveAttribute(
      'href',
      '/billing/top-up'
    );
    expect(track).toHaveBeenCalledWith(WALLET_EVENTS.WIDGET_VIEWED, {
      lens: 'holder',
      state: 'healthy',
    });
    expect(track).toHaveBeenCalledTimes(1);
  });

  it('renders the healthy Top-up as a quiet primary-tinted CTA at a ≥44px tap target', () => {
    render(<DashboardWalletCard data={{ kind: 'holder', balanceMinor: 34_700, fx: null }} />);

    const link = screen.getByRole('link', { name: /top up/i });
    // ≥44px tap target (balo-ui) lands on the interactive element itself.
    expect(link).toHaveClass('min-h-11');
    // Calm-but-accented: primary tint, never a neutral gray or the solid CTA / a gradient.
    expect(link).toHaveClass('bg-primary/10', 'text-primary');
    expect(link).not.toHaveClass('bg-primary');
    expect(link.className).not.toContain('bg-gradient');
  });

  it('renders the low/zero Top-up as the solid primary CTA at a ≥44px tap target', () => {
    render(<DashboardWalletCard data={{ kind: 'holder', balanceMinor: 1_820, fx: null }} />);

    const link = screen.getByRole('link', { name: /top up/i });
    expect(link).toHaveClass('min-h-11', 'bg-primary');
    // Louder than healthy: the solid primary, not the quiet tint.
    expect(link).not.toHaveClass('bg-primary/10');
  });

  it('fires wallet_topup_clicked with the resting state on the Top-up click', async () => {
    render(<DashboardWalletCard data={{ kind: 'holder', balanceMinor: 1_820, fx: null }} />);

    await userEvent.click(screen.getByRole('link', { name: /top up/i }));

    expect(track).toHaveBeenCalledWith(WALLET_EVENTS.TOPUP_CLICKED, { state: 'low' });
  });

  it('renders the indicative "≈ local" line when a non-null fx snapshot is present', () => {
    render(
      <DashboardWalletCard
        data={{ kind: 'holder', balanceMinor: 34_700, fx: { currency: 'USD', audToQuote: 0.642 } }}
      />
    );
    expect(screen.getByText('≈ US$223')).toBeInTheDocument();
  });
});

describe('DashboardWalletCard — member lens', () => {
  it('renders the team-balance nudge and fires wallet_widget_viewed with the member lens', () => {
    render(
      <DashboardWalletCard data={{ kind: 'member', balanceMinor: 1_820, adminLabel: 'Sam' }} />
    );

    expect(screen.getByText('Team balance')).toBeInTheDocument();
    expect(track).toHaveBeenCalledWith(WALLET_EVENTS.WIDGET_VIEWED, {
      lens: 'member',
      state: 'low',
    });
  });

  it('fires wallet_nudge_clicked with the state when the nudge is pressed', async () => {
    mockNudge.mockResolvedValue({ ok: true });
    render(<DashboardWalletCard data={{ kind: 'member', balanceMinor: 0, adminLabel: 'Sam' }} />);

    await userEvent.click(screen.getByRole('button', { name: /Ask Sam to top up/i }));

    expect(track).toHaveBeenCalledWith(WALLET_EVENTS.NUDGE_CLICKED, { state: 'zero' });
  });
});

describe('DashboardWalletCard — error lens', () => {
  it('renders the error state, fires no viewed event, and Retry calls router.refresh', async () => {
    render(<DashboardWalletCard data={{ kind: 'error' }} />);

    expect(screen.getByText(/Balance didn't load/i)).toBeInTheDocument();
    expect(track).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });
});

describe('DashboardWalletCard — accessibility', () => {
  it('has no violations on each lens', async () => {
    const cases = [
      { kind: 'holder', balanceMinor: 34_700, fx: null },
      { kind: 'member', balanceMinor: 1_820, adminLabel: 'Sam' },
      { kind: 'error' },
    ] as const;
    for (const data of cases) {
      const { container, unmount } = render(<DashboardWalletCard data={data} />);
      expect(await axe(container)).toHaveNoViolations();
      unmount();
    }
  }, 20000);
});

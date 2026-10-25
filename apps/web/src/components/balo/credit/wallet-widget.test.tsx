import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { axe } from '@/test/axe';

import { WalletWidget } from './wallet-widget';
import { DASHBOARD_WALLET_SLOT_CLASS } from '@/lib/credit/display-constants';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('WalletWidget — session state', () => {
  it('shows the live balance, the per-minute rate, and warm pre-zero reassurance', () => {
    render(<WalletWidget state="session" balanceMinor={4820} ratePerMinuteMinor={450} />);
    expect(screen.getByText('In consultation')).toBeInTheDocument();
    expect(screen.getByText('A$48.20')).toBeInTheDocument();
    expect(screen.getByText('A$4.50/min · counts down as you talk')).toBeInTheDocument();
    expect(screen.getByText("We'll give you a heads-up before it runs out.")).toBeInTheDocument();
  });

  it('never renders a ticking-clock alarm or the word "overdraft"', () => {
    render(<WalletWidget state="session" balanceMinor={4820} ratePerMinuteMinor={450} />);
    expect(document.body.textContent?.toLowerCase()).not.toContain('overdraft');
  });
});

describe('WalletWidget — promo state', () => {
  it('shows the ring-fenced promo chip', () => {
    render(<WalletWidget state="promo" balanceMinor={39700} promoMinor={5000} />);
    expect(screen.getByText('A$397.00')).toBeInTheDocument();
    expect(screen.getByText('Includes A$50.00 promo credit')).toBeInTheDocument();
    expect(screen.getByText(/ring-fenced/i)).toBeInTheDocument();
  });
});

describe('WalletWidget — loading state', () => {
  it('renders a busy skeleton, not the balance surface', () => {
    render(<WalletWidget state="loading" />);
    expect(screen.getByLabelText('Loading wallet balance')).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByText('In consultation')).not.toBeInTheDocument();
  });
});

describe('WalletWidget — error state', () => {
  it('reassures, owns the failure, and offers Retry', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(<WalletWidget state="error" onRetry={onRetry} />);

    expect(
      screen.getByText(
        "Balance didn't load. Nothing's wrong with your credit — this is on our side."
      )
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe('WalletWidget — resting states (BAL-402)', () => {
  it('healthy shows the balance, renders the action slot, and no "Running low" chip', () => {
    render(
      <WalletWidget
        state="healthy"
        balanceMinor={34_700}
        action={<button type="button">Top up</button>}
      />
    );
    expect(screen.getByText('A$347.00')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Top up' })).toBeInTheDocument();
    expect(screen.queryByText('Running low')).not.toBeInTheDocument();
  });

  it('low shows the amber "Running low" chip alongside the balance', () => {
    render(<WalletWidget state="low" balanceMinor={1_820} />);
    expect(screen.getByText('A$18.20')).toBeInTheDocument();
    expect(screen.getByText('Running low')).toBeInTheDocument();
  });

  it('zero frames the balance as an invitation, not absence', () => {
    render(
      <WalletWidget state="zero" balanceMinor={0} action={<button type="button">Top up</button>} />
    );
    expect(screen.getByText('A$0.00')).toBeInTheDocument();
    expect(screen.getByText('Top up to start a consultation.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Top up' })).toBeInTheDocument();
  });

  it('never renders the word "overdraft" on any resting state', () => {
    for (const state of ['healthy', 'low', 'zero'] as const) {
      const { unmount } = render(<WalletWidget state={state} balanceMinor={1_000} />);
      expect(document.body.textContent?.toLowerCase()).not.toContain('overdraft');
      unmount();
    }
  });
});

describe('WalletWidget — indicative FX secondary', () => {
  it('renders the "≈ local" line when a non-null fx snapshot is passed', () => {
    render(
      <WalletWidget
        state="healthy"
        balanceMinor={34_700}
        fx={{ currency: 'USD', audToQuote: 0.642 }}
      />
    );
    expect(screen.getByText('≈ US$223')).toBeInTheDocument();
  });

  it('omits the "≈ local" line when fx is null (missing or stale rate)', () => {
    render(<WalletWidget state="healthy" balanceMinor={34_700} fx={null} />);
    expect(screen.queryByText(/≈/)).not.toBeInTheDocument();
  });

  it('never shows an indicative line on the zero state even with a rate', () => {
    render(
      <WalletWidget state="zero" balanceMinor={0} fx={{ currency: 'USD', audToQuote: 0.642 }} />
    );
    expect(screen.queryByText(/≈/)).not.toBeInTheDocument();
  });
});

describe('WalletWidget — chrome override', () => {
  it('keeps the 380px cap and renders flat by default', () => {
    const resting = render(<WalletWidget state="healthy" balanceMinor={34_700} />);
    expect(resting.container.firstElementChild).toHaveClass('max-w-[380px]');
    expect(resting.container.firstElementChild?.className).not.toContain('shadow');
    resting.unmount();
    render(<WalletWidget state="loading" />);
    expect(screen.getByLabelText('Loading wallet balance')).toHaveClass('max-w-[380px]');
  });

  it('swaps the cap when given the dashboard slot class and stays flat', () => {
    const { container } = render(
      <WalletWidget state="healthy" balanceMinor={34_700} className={DASHBOARD_WALLET_SLOT_CLASS} />
    );
    const root = container.firstElementChild;
    expect(root).toHaveClass('max-w-none', 'lg:flex-1');
    expect(root).not.toHaveClass('flex-col');
    expect(root).not.toHaveClass('max-w-[380px]');
    expect(root?.className).not.toContain('shadow');
  });

  it('keeps the resting footer a plain block unless growFooter is set', () => {
    const plain = render(
      <WalletWidget state="healthy" balanceMinor={34_700} action={<a href="/x">Act</a>} />
    );
    expect(screen.getByRole('link', { name: 'Act' }).parentElement?.className).toBe('mt-4');
    plain.unmount();
    render(
      <WalletWidget
        state="healthy"
        balanceMinor={34_700}
        growFooter
        action={<a href="/x">Act</a>}
      />
    );
    expect(screen.getByRole('link', { name: 'Act' }).parentElement).toHaveClass(
      'mt-4',
      'flex',
      'flex-1',
      'flex-col'
    );
  });

  it('renders the action only on resting states', () => {
    const loading = render(<WalletWidget state="loading" action={<a href="/x">Act</a>} />);
    expect(screen.queryByRole('link', { name: 'Act' })).toBeNull();
    loading.unmount();
    const error = render(<WalletWidget state="error" action={<a href="/x">Act</a>} />);
    expect(screen.queryByRole('link', { name: 'Act' })).toBeNull();
    error.unmount();
    render(<WalletWidget state="healthy" balanceMinor={34_700} action={<a href="/x">Act</a>} />);
    expect(screen.getByRole('link', { name: 'Act' })).toBeInTheDocument();
  });
});

describe('WalletWidget — accessibility', () => {
  it('session state has no violations', async () => {
    const { container } = render(
      <WalletWidget state="session" balanceMinor={4820} ratePerMinuteMinor={450} />
    );
    expect(await axe(container)).toHaveNoViolations();
  }, 15000);

  it('error state has no violations', async () => {
    const { container } = render(<WalletWidget state="error" onRetry={vi.fn()} />);
    expect(await axe(container)).toHaveNoViolations();
  }, 15000);

  it('holder resting states have no violations', async () => {
    for (const state of ['healthy', 'low', 'zero'] as const) {
      const { container, unmount } = render(
        <WalletWidget
          state={state}
          balanceMinor={1_820}
          fx={{ currency: 'USD', audToQuote: 0.642 }}
          action={<button type="button">Top up</button>}
        />
      );
      expect(await axe(container)).toHaveNoViolations();
      unmount();
    }
  }, 20000);
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PaymentSection as PaymentSectionType } from './PaymentSection';
import type { WalletSnapshot } from './types';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mockPush, back: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/credit/actions', () => ({
  validatePromoAction: vi.fn(),
  startPurchaseAction: vi.fn(),
}));

// Stub the Stripe-backed PaymentSection so the composer renders without @stripe/*. It also
// surfaces the client request id derived from `buildStartInput()` so the idempotency-stability
// guarantee can be asserted.
vi.mock('./PaymentSection', () => ({
  PaymentSection: (props: Parameters<typeof PaymentSectionType>[0]) => (
    <>
      <div data-testid="client-request-id">{props.buildStartInput().clientRequestId}</div>
      <div data-testid="pay-disabled">{String(props.disabled ?? false)}</div>
      <button
        type="button"
        onClick={() =>
          props.onComplete({
            amountMinor: props.amountMinor,
            promoMinor: props.promoMinor,
            promoCode: props.promoCode,
            lowBalanceMode: props.lowBalanceMode,
            mandateCaptured: false,
          })
        }
      >
        Pay now
      </button>
    </>
  ),
}));

import { TopUpComposer } from './TopUpComposer';

const WALLET: WalletSnapshot = {
  walletId: 'wallet-1',
  balanceMinor: 50_000,
  lowBalanceMode: 'keep_going',
  hasCard: false,
  topupReloadMinor: 30_000,
  topupThresholdMinor: 5_000,
};

describe('TopUpComposer', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders the compose surface: hero, amount, promo, funding, modes', () => {
    render(<TopUpComposer wallet={WALLET} fx={null} />);
    expect(screen.getByText(/Your top-up buys/i)).toBeInTheDocument();
    expect(screen.getByText(/Choose an amount/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Promo code/i)).toBeInTheDocument();
    expect(screen.getByText(/Pay with/i)).toBeInTheDocument();
    expect(screen.getByText(/When your balance runs low/i)).toBeInTheDocument();
  });

  it('swaps to the receipt on a completed purchase', async () => {
    render(<TopUpComposer wallet={WALLET} fx={null} />);
    await userEvent.click(screen.getByRole('button', { name: /Pay now/i }));
    expect(await screen.findByText(/You're topped up/i)).toBeInTheDocument();
  });

  it('keeps the clientRequestId STABLE across re-renders of the same configuration', () => {
    const { rerender } = render(<TopUpComposer wallet={WALLET} fx={null} />);
    const first = screen.getByTestId('client-request-id').textContent;
    expect(first).toBeTruthy();

    // A re-render with the same props does not change amount/mode/promo → same id (a
    // double-submit of the same config returns the same PaymentIntent).
    rerender(<TopUpComposer wallet={WALLET} fx={null} />);
    expect(screen.getByTestId('client-request-id').textContent).toBe(first);
  });

  it('REGENERATES the clientRequestId when the amount changes', async () => {
    render(<TopUpComposer wallet={WALLET} fx={null} />);
    const first = screen.getByTestId('client-request-id').textContent;

    // Pick a different tier → amount changes → the config signature changes → new id.
    await userEvent.click(screen.getByRole('button', { name: /A\$5,000/i }));
    expect(screen.getByTestId('client-request-id').textContent).not.toBe(first);
  });

  it('REGENERATES the clientRequestId when the low-balance mode changes', async () => {
    render(<TopUpComposer wallet={WALLET} fx={null} />);
    const first = screen.getByTestId('client-request-id').textContent;

    await userEvent.click(screen.getByRole('radio', { name: /Just notify me/i }));
    expect(screen.getByTestId('client-request-id').textContent).not.toBe(first);
  });

  it('blocks Pay while an out-of-range auto-top-up amount is entered', async () => {
    render(<TopUpComposer wallet={WALLET} fx={null} />);
    // Switch to auto top-up, then clear the "Add" field (→ A$0, below the A$50 floor).
    await userEvent.click(screen.getByRole('radio', { name: /Auto top-up/i }));
    const addInput = screen.getByLabelText(/^Add$/i);
    await userEvent.clear(addInput);
    expect(screen.getByTestId('pay-disabled')).toHaveTextContent('true');
    // The offending field shows an inline message (not a Pay-button "amount" error).
    expect(screen.getByText(/Minimum top-up is/i)).toBeInTheDocument();
  });
});

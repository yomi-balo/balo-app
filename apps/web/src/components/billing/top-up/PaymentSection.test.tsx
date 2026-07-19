import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ── Stripe.js mocks ──────────────────────────────────────────────────────────

const mockConfirmPayment = vi.fn();
const mockConfirmSetup = vi.fn();
const mockSubmit = vi.fn();
const mockUpdate = vi.fn();

vi.mock('@stripe/stripe-js', () => ({
  loadStripe: vi.fn(() => Promise.resolve({})),
}));

vi.mock('@stripe/react-stripe-js', () => ({
  Elements: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PaymentElement: () => <div data-testid="payment-element" />,
  useStripe: () => ({ confirmPayment: mockConfirmPayment, confirmSetup: mockConfirmSetup }),
  useElements: () => ({ submit: mockSubmit, update: mockUpdate }),
}));

const mockStartPurchaseAction = vi.fn();
vi.mock('@/lib/credit/actions', () => ({
  startPurchaseAction: (...args: unknown[]) => mockStartPurchaseAction(...args),
}));

import { PaymentSection, type PurchaseCompletion } from './PaymentSection';
import type { StartPurchaseInput, LowBalanceMode } from '@/lib/credit/actions';

// ── Fixtures ─────────────────────────────────────────────────────────────────

function renderSection(overrides: {
  lowBalanceMode?: LowBalanceMode;
  onComplete?: (c: PurchaseCompletion) => void;
  disabled?: boolean;
}) {
  const onComplete = overrides.onComplete ?? vi.fn();
  const buildStartInput = (): StartPurchaseInput => ({
    amountMinor: 100_000,
    clientRequestId: '550e8400-e29b-41d4-a716-446655440002',
    config: {
      lowBalanceMode: overrides.lowBalanceMode ?? 'keep_going',
      topupReloadMinor: 30_000,
      topupThresholdMinor: 5_000,
    },
  });
  render(
    <PaymentSection
      amountMinor={100_000}
      promoMinor={0}
      promoCode={null}
      lowBalanceMode={overrides.lowBalanceMode ?? 'keep_going'}
      fx={null}
      disabled={overrides.disabled}
      buildStartInput={buildStartInput}
      onComplete={onComplete}
    />
  );
  return { onComplete };
}

describe('PaymentSection', () => {
  beforeAll(() => {
    process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = 'pk_test_123';
  });
  afterAll(() => {
    delete process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mockSubmit.mockResolvedValue({});
    mockStartPurchaseAction.mockResolvedValue({
      ok: true,
      clientSecret: 'pi_secret',
      paymentIntentId: 'pi_1',
      setupClientSecret: 'seti_secret',
      walletId: 'wallet-1',
    });
    mockConfirmPayment.mockResolvedValue({
      paymentIntent: { status: 'succeeded', payment_method: 'pm_123' },
    });
    mockConfirmSetup.mockResolvedValue({});
  });

  it('confirms the PaymentIntent THEN the SetupIntent with the saved payment method', async () => {
    const { onComplete } = renderSection({ lowBalanceMode: 'keep_going' });

    await userEvent.click(screen.getByRole('button', { name: /Pay/i }));

    await waitFor(() => expect(onComplete).toHaveBeenCalled());

    // The Element is submitted, then the intent is created, then the PI is confirmed.
    expect(mockSubmit).toHaveBeenCalled();
    expect(mockStartPurchaseAction).toHaveBeenCalled();
    expect(mockConfirmPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        clientSecret: 'pi_secret',
        redirect: 'if_required',
        confirmParams: expect.objectContaining({ return_url: expect.any(String) }),
      })
    );
    // The mandate SetupIntent is confirmed with the PI's saved PM id (no fresh card entry).
    expect(mockConfirmSetup).toHaveBeenCalledWith(
      expect.objectContaining({
        clientSecret: 'seti_secret',
        redirect: 'if_required',
        confirmParams: expect.objectContaining({ payment_method: 'pm_123' }),
      })
    );
    // Sequence: PaymentIntent confirmed BEFORE the SetupIntent.
    const payOrder = mockConfirmPayment.mock.invocationCallOrder[0] ?? 0;
    const setupOrder = mockConfirmSetup.mock.invocationCallOrder[0] ?? 0;
    expect(payOrder).toBeLessThan(setupOrder);

    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({ mandateCaptured: true, lowBalanceMode: 'keep_going' })
    );
  });

  it('surfaces a decline/SCA error, charges nothing, and returns to idle', async () => {
    mockConfirmPayment.mockResolvedValue({ error: { message: 'Your card was declined.' } });
    const { onComplete } = renderSection({ lowBalanceMode: 'notify_only' });

    await userEvent.click(screen.getByRole('button', { name: /Pay/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/declined/i);
    // No mandate step, no completion — nothing was charged.
    expect(mockConfirmSetup).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
    // Pay button back to idle (label restored, not "Processing…").
    expect(screen.getByRole('button', { name: /Pay/i })).toBeEnabled();
  });

  it('completes with mandateCaptured=false when the charge succeeds but the SetupIntent fails', async () => {
    mockConfirmSetup.mockResolvedValue({ error: { message: 'setup failed' } });
    const { onComplete } = renderSection({ lowBalanceMode: 'auto_topup' });

    await userEvent.click(screen.getByRole('button', { name: /Pay/i }));

    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    // The purchase still completes (money is charged) — the mandate simply stays uncaptured.
    expect(mockConfirmPayment).toHaveBeenCalled();
    expect(mockConfirmSetup).toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({ mandateCaptured: false, lowBalanceMode: 'auto_topup' })
    );
  });

  it('does not attempt payment when start fails (invalid input / no charge)', async () => {
    mockStartPurchaseAction.mockResolvedValue({ ok: false, error: 'invalid_input' });
    const { onComplete } = renderSection({ lowBalanceMode: 'notify_only' });

    await userEvent.click(screen.getByRole('button', { name: /Pay/i }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(mockConfirmPayment).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });
});

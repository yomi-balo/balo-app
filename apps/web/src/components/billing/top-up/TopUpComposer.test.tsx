import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WalletSnapshot, SavedCard } from './types';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mockPush, back: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/credit/actions', () => ({
  validatePromoAction: vi.fn(),
  startPurchaseAction: vi.fn(),
}));

// Stripe.js is stubbed at the module boundary so the composer's real <Elements> hoist, its
// PaymentMethodSection and its PayAction all render — only the SDK is fake.
vi.mock('@stripe/stripe-js', () => ({ loadStripe: vi.fn(() => Promise.resolve({})) }));
const { mockStripeApi, mockElementsApi } = vi.hoisted(() => ({
  // Stable identities across renders — a fresh object each render would re-fire PayAction's
  // `elements.update({ amount })` effect on every keystroke.
  mockStripeApi: {
    confirmPayment: vi.fn(async () => ({
      paymentIntent: { status: 'succeeded', payment_method: 'pm_123' },
    })),
    confirmSetup: vi.fn(async () => ({})),
    handleNextAction: vi.fn(async () => ({})),
  },
  mockElementsApi: { submit: vi.fn(async () => ({})), update: vi.fn() },
}));
vi.mock('@stripe/react-stripe-js', () => ({
  Elements: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="elements-provider">{children}</div>
  ),
  PaymentElement: () => <div data-testid="payment-element" />,
  useStripe: () => mockStripeApi,
  useElements: () => mockElementsApi,
}));

import { TopUpComposer } from './TopUpComposer';
import { startPurchaseAction } from '@/lib/credit/actions';

const SAVED_CARD: SavedCard = {
  brand: 'visa',
  last4: '4242',
  expMonth: 8,
  expYear: 2028,
  mandateActive: true,
};

function wallet(overrides: Partial<WalletSnapshot> = {}): WalletSnapshot {
  return {
    walletId: 'wallet-1',
    balanceMinor: 50_000,
    lowBalanceMode: 'keep_going',
    savedCard: null,
    topupReloadMinor: 30_000,
    topupThresholdMinor: 5_000,
    ...overrides,
  };
}

/**
 * The composer no longer exposes the client request id through a stubbed child, so read it the
 * way the server does: press Pay and inspect what `startPurchaseAction` was handed.
 *
 * The action is stubbed to FAIL here on purpose — a success swaps the composer to its receipt,
 * unmounting the very controls the next assertion needs to interact with.
 */
async function pressPayAndReadRequestId(): Promise<string> {
  vi.mocked(startPurchaseAction).mockResolvedValue({ ok: false, error: 'stripe_error' });
  await userEvent.click(screen.getByRole('button', { name: /^Pay A\$/i }));
  const last = vi.mocked(startPurchaseAction).mock.calls.at(-1);
  expect(last).toBeDefined();
  return last?.[0].clientRequestId ?? '';
}

describe('TopUpComposer', () => {
  beforeAll(() => {
    process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = 'pk_test_123';
  });
  afterAll(() => {
    delete process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mockElementsApi.submit.mockResolvedValue({});
    mockStripeApi.confirmPayment.mockResolvedValue({
      paymentIntent: { status: 'succeeded', payment_method: 'pm_123' },
    });
    mockStripeApi.confirmSetup.mockResolvedValue({});
    mockStripeApi.handleNextAction.mockResolvedValue({});
    vi.mocked(startPurchaseAction).mockResolvedValue({
      ok: true,
      outcome: 'needs_client_confirmation',
      clientSecret: 'pi_secret',
      paymentIntentId: 'pi_1',
      mandate: { outcome: 'not_required' },
      walletId: 'wallet-1',
    });
  });

  it('renders the compose surface: hero, amount, promo, modes, payment method', () => {
    render(<TopUpComposer wallet={wallet()} fx={null} />);
    expect(screen.getByText(/Your top-up buys/i)).toBeInTheDocument();
    expect(screen.getByText(/Choose an amount/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /have a promo code/i })).toBeInTheDocument();
    expect(screen.getByText(/When your balance runs low/i)).toBeInTheDocument();
    expect(screen.getByText(/^Payment method$/i)).toBeInTheDocument();
  });

  it('no longer offers a "Pay with" funding control (one option is not a choice)', () => {
    render(<TopUpComposer wallet={wallet()} fx={null} />);
    expect(screen.queryByText(/Pay with/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Invoice \/ transfer/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Coming soon/i)).not.toBeInTheDocument();
    // Replaced by one line of fine print, not a disabled tile.
    expect(screen.getByText(/Paying by invoice or bank transfer/i)).toBeInTheDocument();
  });

  it('hoists <Elements> ABOVE both columns so the rail Pay button can reach useStripe', () => {
    render(<TopUpComposer wallet={wallet()} fx={null} />);
    const provider = screen.getByTestId('elements-provider');
    // Both the payment section (left) and the Pay button (rail) must be INSIDE the provider.
    expect(provider).toContainElement(screen.getByTestId('payment-element'));
    expect(provider).toContainElement(screen.getByRole('button', { name: /^Pay A\$/i }));
    expect(screen.getByRole('button', { name: /^Pay A\$/i })).toBeEnabled();
  });

  it('renders exactly ONE Pay button and ONE hero (only one layout branch exists)', () => {
    render(<TopUpComposer wallet={wallet()} fx={null} layoutHint="wide" />);
    expect(screen.getAllByRole('button', { name: /^Pay A\$/i })).toHaveLength(1);
    expect(screen.getAllByText(/Your top-up buys/i)).toHaveLength(1);
  });

  it('swaps to the receipt on a completed purchase', async () => {
    render(<TopUpComposer wallet={wallet()} fx={null} />);
    await userEvent.click(screen.getByRole('button', { name: /^Pay A\$/i }));
    expect(await screen.findByText(/You're topped up/i)).toBeInTheDocument();
  });

  // ── clientRequestId stability (Stripe idempotency) ────────────────────────

  it('keeps the clientRequestId STABLE across re-renders of the same configuration', async () => {
    const { rerender } = render(<TopUpComposer wallet={wallet()} fx={null} />);
    const first = await pressPayAndReadRequestId();
    expect(first).toBeTruthy();

    rerender(<TopUpComposer wallet={wallet()} fx={null} />);
    expect(await pressPayAndReadRequestId()).toBe(first);
  });

  it('REGENERATES the clientRequestId when the amount changes', async () => {
    render(<TopUpComposer wallet={wallet()} fx={null} />);
    const first = await pressPayAndReadRequestId();

    await userEvent.click(screen.getByRole('button', { name: /A\$5,000/i }));
    expect(await pressPayAndReadRequestId()).not.toBe(first);
  });

  it('REGENERATES the clientRequestId when the low-balance mode changes', async () => {
    render(<TopUpComposer wallet={wallet()} fx={null} />);
    const first = await pressPayAndReadRequestId();

    await userEvent.click(screen.getByRole('radio', { name: /Just notify me/i }));
    expect(await pressPayAndReadRequestId()).not.toBe(first);
  });

  it('REGENERATES the clientRequestId when the PAYMENT-METHOD SOURCE changes (R3)', async () => {
    render(<TopUpComposer wallet={wallet({ savedCard: SAVED_CARD })} fx={null} />);
    const first = await pressPayAndReadRequestId();

    // The two sources build PaymentIntents with DIFFERENT params. Reusing one Stripe
    // idempotency key across them is a 400 — which would kill Pay permanently after "Change".
    await userEvent.click(screen.getByRole('button', { name: /change/i }));
    const second = await pressPayAndReadRequestId();
    expect(second).not.toBe(first);

    await userEvent.click(screen.getByRole('button', { name: /keep visa •••• 4242 instead/i }));
    expect(await pressPayAndReadRequestId()).not.toBe(second);
  });

  // ── Saved card ────────────────────────────────────────────────────────────

  it('starts on the saved card for a returning buyer and says so in the rail', () => {
    render(<TopUpComposer wallet={wallet({ savedCard: SAVED_CARD })} fx={null} />);
    expect(screen.getByText('Paying with')).toBeInTheDocument();
    expect(screen.getAllByText('Visa •••• 4242').length).toBeGreaterThan(0);
  });

  it('sends paymentMethodSource: saved_card when paying with the card on file', async () => {
    render(<TopUpComposer wallet={wallet({ savedCard: SAVED_CARD })} fx={null} />);
    await userEvent.click(screen.getByRole('button', { name: /^Pay A\$/i }));
    expect(startPurchaseAction).toHaveBeenCalledWith(
      expect.objectContaining({ paymentMethodSource: 'saved_card' })
    );
  });

  it('sends paymentMethodSource: new_card for a first-time buyer', async () => {
    render(<TopUpComposer wallet={wallet()} fx={null} />);
    await userEvent.click(screen.getByRole('button', { name: /^Pay A\$/i }));
    expect(startPurchaseAction).toHaveBeenCalledWith(
      expect.objectContaining({ paymentMethodSource: 'new_card' })
    );
  });

  it('names the saved card in the mandate disclosure — and prints it only ONCE', async () => {
    render(
      <TopUpComposer
        wallet={wallet({ savedCard: SAVED_CARD, lowBalanceMode: 'keep_going' })}
        fx={null}
      />
    );
    const notes = screen.getAllByText(/letting Balo charge/i);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toHaveTextContent(/Visa •••• 4242/);
  });

  it('falls back to "this card" in the disclosure when a new card will be entered', () => {
    render(<TopUpComposer wallet={wallet({ lowBalanceMode: 'keep_going' })} fx={null} />);
    const notes = screen.getAllByText(/letting Balo charge/i);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toHaveTextContent(/charge this card/);
  });

  // ── Decline recovery (the seam no per-component test could see) ───────────

  it('gives the buyer a card form after a decline → "Use a different card"', async () => {
    // ⚠ THE DEAD END THIS PINS. `PayAction`'s decline escape reaches the composer, not
    // `PaymentMethodSection`'s own "Change" button — so when the Element latch lived only on
    // that button, flipping the source hid the saved-card row and mounted NOTHING in its place.
    // The buyer was left with a "Payment method" heading and no card input anywhere on the page,
    // unrecoverable without a reload. Both halves were green in isolation; only the composer,
    // rendering the real section AND the real Pay button, can see it.
    vi.mocked(startPurchaseAction).mockResolvedValue({
      ok: false,
      error: 'card_declined',
      declineCode: 'insufficient_funds',
    });
    render(<TopUpComposer wallet={wallet({ savedCard: SAVED_CARD })} fx={null} />);

    // Lazy: the saved card is shown, so no Stripe iframe has been created yet.
    expect(screen.queryByTestId('payment-element')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^Pay A\$/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/declined/i);

    await userEvent.click(screen.getByRole('button', { name: /use a different card/i }));

    expect(screen.getByTestId('payment-element')).toBeInTheDocument();
    expect(screen.queryByText('Visa •••• 4242')).not.toBeInTheDocument();
  });

  it('warns on the receipt when the mandate FAILED but the charge went through', async () => {
    // Crosses the whole seam: the action's stated outcome → PayAction's `mandateCaptured` →
    // the receipt's warning. Reporting `failed` as captured suppressed this warning entirely.
    vi.mocked(startPurchaseAction).mockResolvedValue({
      ok: true,
      outcome: 'complete',
      paymentIntentId: 'pi_saved',
      mandate: { outcome: 'failed' },
      walletId: 'wallet-1',
    });
    render(
      <TopUpComposer
        wallet={wallet({ savedCard: SAVED_CARD, lowBalanceMode: 'keep_going' })}
        fx={null}
      />
    );

    await userEvent.click(screen.getByRole('button', { name: /^Pay A\$/i }));

    expect(await screen.findByText(/You're topped up/i)).toBeInTheDocument();
    expect(screen.getByText(/couldn't finish setting up automatic charging/i)).toBeInTheDocument();
  });

  it('never disables a card-backed mode — every path is a card now', () => {
    render(<TopUpComposer wallet={wallet()} fx={null} />);
    expect(screen.getByRole('radio', { name: /Auto top-up/i })).toBeEnabled();
    expect(screen.getByRole('radio', { name: /Keep me going/i })).toBeEnabled();
    expect(screen.queryByText(/Add a card to use this/i)).not.toBeInTheDocument();
  });

  // ── Config validation + missing key ───────────────────────────────────────

  it('blocks Pay while an out-of-range auto-top-up amount is entered', async () => {
    render(<TopUpComposer wallet={wallet()} fx={null} />);
    await userEvent.click(screen.getByRole('radio', { name: /Auto top-up/i }));
    const addInput = screen.getByLabelText(/^Add$/i);
    await userEvent.clear(addInput);

    expect(screen.getByRole('button', { name: /^Pay A\$/i })).toBeDisabled();
    // The offending field shows an inline message (not a Pay-button "amount" error).
    expect(screen.getByText(/Minimum top-up is/i)).toBeInTheDocument();
  });

  it('renders without <Elements> and without Pay when Stripe is not configured', () => {
    delete process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
    render(<TopUpComposer wallet={wallet()} fx={null} />);

    expect(screen.queryByTestId('elements-provider')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Pay A\$/i })).not.toBeInTheDocument();
    expect(screen.getByText(/Card payments aren't configured right now/i)).toBeInTheDocument();
    // The rest of the composer still renders — the buyer can see what they were choosing.
    expect(screen.getByText(/Choose an amount/i)).toBeInTheDocument();

    process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = 'pk_test_123';
  });
});

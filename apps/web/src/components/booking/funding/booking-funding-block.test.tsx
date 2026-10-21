import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('motion/react', async () => {
  const { createMotionStub } = await import('@/test/motion-stub');
  return createMotionStub();
});

vi.mock('@/lib/credit/actions', () => ({
  validatePromoAction: vi.fn(),
  startPurchaseAction: vi.fn(),
  getTopUpCreditStatusAction: vi.fn(),
}));

const mockCaptureException = vi.fn();
vi.mock('@sentry/nextjs', () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

vi.mock('@/lib/stripe/loader', () => ({
  getStripe: (publishableKey: string) => Promise.resolve({ publishableKey }),
}));
const { mockStripeApi, mockElementsApi } = vi.hoisted(() => ({
  mockStripeApi: {
    confirmPayment: vi.fn(async () => ({
      paymentIntent: { status: 'succeeded', payment_method: 'pm_123' },
    })),
    confirmSetup: vi.fn(async () => ({})),
    handleNextAction: vi.fn(async () => ({})),
    retrievePaymentIntent: vi.fn(async () => ({})),
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

import { track, BOOKING_EVENTS } from '@/lib/analytics';
import {
  startPurchaseAction,
  getTopUpCreditStatusAction,
  validatePromoAction,
} from '@/lib/credit/actions';
import { BookingFundingBlock, type BookingFundingBlockProps } from './booking-funding-block';
import {
  BOOKING_PAY_ERROR_COPY,
  FUNDING_AUD_LINE,
  creditPendingCopy,
  fundingBlockCopy,
} from './funding-copy';
import { SAVED_CARD, refusedView } from './funding-fixtures';
import type { RefusedFundingView } from './funding-disposition';

const FIGURES = { topupReloadMinor: 10_000, topupThresholdMinor: 2_000 };

function managerView(overrides: Partial<RefusedFundingView> = {}): RefusedFundingView {
  return refusedView({ wallet: { savedCard: null, lowBalanceFigures: FIGURES }, ...overrides });
}

function savedCardView(overrides: Partial<RefusedFundingView> = {}): RefusedFundingView {
  return managerView({
    wallet: { savedCard: SAVED_CARD, lowBalanceFigures: FIGURES },
    firstTime: false,
    ...overrides,
  });
}

function memberView(overrides: Partial<RefusedFundingView> = {}): RefusedFundingView {
  return refusedView({ canManageBilling: false, wallet: null, ...overrides });
}

function renderBlock(
  view: RefusedFundingView,
  overrides: Partial<BookingFundingBlockProps> = {}
): BookingFundingBlockProps & ReturnType<typeof render> {
  const props: BookingFundingBlockProps = {
    view,
    caseSaved: null,
    ctaDisabled: false,
    onBeforePay: vi.fn(() => true),
    onFunded: vi.fn(async () => true),
    onSaveForLater: vi.fn(async () => undefined),
    onBack: vi.fn(),
    draftKept: true,
    onBusyChange: vi.fn(),
    onInFlightChange: vi.fn(),
    ...overrides,
  };
  return { ...props, ...render(<BookingFundingBlock {...props} />) };
}

function startOk(paymentIntentId = 'pi_1') {
  return {
    ok: true,
    outcome: 'complete',
    paymentIntentId,
    mandate: { outcome: 'not_required' },
    walletId: 'wallet-1',
  } as const;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const ctaName = (amount: string): RegExp => new RegExp(`^Top up ${amount} & book`);
const trackedPayloads = (event: string): unknown[] =>
  vi
    .mocked(track)
    .mock.calls.filter(([name]) => name === event)
    .map(([, payload]) => payload);

describe('BookingFundingBlock', () => {
  beforeAll(() => {
    process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = 'pk_test_123';
  });
  afterAll(() => {
    delete process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
  });
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(startPurchaseAction).mockResolvedValue(startOk());
    vi.mocked(getTopUpCreditStatusAction).mockResolvedValue({
      status: 'credited',
      balanceMinor: 30_000,
      promoGranted: null,
      mandateActive: false,
    });
  });

  describe('manager arm', () => {
    it('shows the first-time setup copy with no figure, and pre-selects the minimum', () => {
      const view = managerView();
      renderBlock(view);
      const { heading, body } = fundingBlockCopy(view);
      expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument();
      expect(screen.getByText(body)).toBeInTheDocument();
      expect(body).not.toContain('A$');
      expect(screen.getByRole('radio', { name: /A\$300\s*Minimum/ })).toHaveAttribute(
        'aria-checked',
        'true'
      );
      expect(screen.getByText(FUNDING_AUD_LINE)).toBeInTheDocument();
    });

    it('offers the suggested amount, the tiers above it, and Other', () => {
      renderBlock(managerView({ suggestedTopUpMinor: 60_000 }));
      const labels = within(screen.getByRole('radiogroup', { name: 'Amount' }))
        .getAllByRole('radio')
        .map((radio) => radio.textContent);
      expect(labels).toEqual(['A$600Minimum', 'A$1,000', 'A$5,000', 'Other']);
      expect(screen.getByRole('button', { name: ctaName('A\\$600') })).toBeInTheDocument();
    });

    it('with a saved card, one press charges it as a pure top-up', async () => {
      const view = savedCardView();
      renderBlock(view);
      expect(screen.queryByTestId('payment-element')).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: ctaName('A\\$300') }));
      await waitFor(() => expect(startPurchaseAction).toHaveBeenCalledTimes(1));
      const [input] = vi.mocked(startPurchaseAction).mock.calls[0] ?? [];
      expect(input?.paymentMethodSource).toBe('saved_card');
      expect(input?.amountMinor).toBe(30_000);
      expect(input?.lowBalance).toBe('keep');
      expect(input).not.toHaveProperty('config');
    });

    it('without a card, mounts the Payment Element and pays as a new card', async () => {
      renderBlock(managerView());
      expect(screen.getByTestId('payment-element')).toBeVisible();
      await userEvent.click(screen.getByRole('button', { name: ctaName('A\\$300') }));
      await waitFor(() => expect(startPurchaseAction).toHaveBeenCalledTimes(1));
      expect(vi.mocked(startPurchaseAction).mock.calls[0]?.[0].paymentMethodSource).toBe(
        'new_card'
      );
    });

    it('charges once on a double click', async () => {
      const start = deferred<ReturnType<typeof startOk>>();
      vi.mocked(startPurchaseAction).mockReturnValue(start.promise);
      renderBlock(savedCardView());
      await userEvent.dblClick(screen.getByRole('button', { name: ctaName('A\\$300') }));
      expect(startPurchaseAction).toHaveBeenCalledTimes(1);
      start.resolve(startOk());
      await waitFor(() => expect(getTopUpCreditStatusAction).toHaveBeenCalled());
    });

    it('uses the amount typed under Other, and blocks an invalid one', async () => {
      renderBlock(savedCardView());
      await userEvent.click(screen.getByRole('radio', { name: 'Other' }));
      const input = screen.getByRole('textbox', { name: /Top-up amount/ });
      expect(input).toHaveFocus();
      expect(screen.getByText('Between A$300 and A$10,000, in A$100 steps.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Top up & book' })).toBeDisabled();

      await userEvent.type(input, '350');
      expect(screen.getByText('Use A$100 steps, like A$400.')).toBeInTheDocument();
      expect(input).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByRole('button', { name: 'Top up & book' })).toBeDisabled();

      await userEvent.clear(input);
      await userEvent.type(input, '400');
      const cta = screen.getByRole('button', { name: ctaName('A\\$400') });
      expect(cta).toBeEnabled();
      await userEvent.click(cta);
      await waitFor(() => expect(startPurchaseAction).toHaveBeenCalledTimes(1));
      expect(vi.mocked(startPurchaseAction).mock.calls[0]?.[0].amountMinor).toBe(40_000);
    });

    it('does not charge when the dialog refuses the press', async () => {
      const { onBeforePay } = renderBlock(savedCardView(), { onBeforePay: vi.fn(() => false) });
      await userEvent.click(screen.getByRole('button', { name: ctaName('A\\$300') }));
      expect(onBeforePay).toHaveBeenCalledTimes(1);
      expect(startPurchaseAction).not.toHaveBeenCalled();
    });

    it('locks the amount, promo and payment method while the charge is in flight', async () => {
      const start = deferred<Awaited<ReturnType<typeof startPurchaseAction>>>();
      vi.mocked(startPurchaseAction).mockReturnValue(start.promise);
      renderBlock(savedCardView());
      expect(screen.getByRole('radio', { name: /A\$1,000/ })).toBeEnabled();
      expect(screen.getByRole('button', { name: /Have a promo code/ })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Change' })).toBeEnabled();

      await userEvent.click(screen.getByRole('button', { name: ctaName('A\\$300') }));

      await waitFor(() => expect(screen.getByRole('radio', { name: /A\$1,000/ })).toBeDisabled());
      expect(screen.getByRole('button', { name: /Have a promo code/ })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Change' })).toBeDisabled();
      start.resolve({ ok: false, error: 'card_declined' });
      await waitFor(() => expect(screen.getByRole('radio', { name: /A\$1,000/ })).toBeEnabled());
    });

    it('disables the action while the dialog gates it', () => {
      renderBlock(savedCardView(), { ctaDisabled: true });
      expect(screen.getByRole('button', { name: ctaName('A\\$300') })).toBeDisabled();
    });

    it('calls onBack from Back', async () => {
      const { onBack } = renderBlock(savedCardView());
      await userEvent.click(screen.getByRole('button', { name: /Back/ }));
      expect(onBack).toHaveBeenCalledTimes(1);
    });

    it('says so, and cannot pay, when card payments are not configured', () => {
      delete process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
      try {
        renderBlock(managerView());
        expect(screen.getByText(/Card payments aren't configured right now/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Top up/ })).toBeDisabled();
        expect(screen.queryByTestId('payment-element')).not.toBeInTheDocument();
      } finally {
        process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = 'pk_test_123';
      }
    });

    it('shows the case-saved line under the heading', () => {
      renderBlock(managerView(), {
        caseSaved: { caseTitle: 'Migration planning', expertLabel: 'CloudPeak' },
      });
      expect(screen.getByText(/"Migration planning" is saved in your Cases/)).toBeInTheDocument();
    });
  });

  describe('pay, then credit, then book', () => {
    it('books only once the wallet shows the credit', async () => {
      const poll = deferred<{ status: 'pending'; balanceMinor: number }>();
      vi.mocked(getTopUpCreditStatusAction).mockReturnValueOnce(poll.promise);
      const { onFunded } = renderBlock(savedCardView());
      await userEvent.click(screen.getByRole('button', { name: ctaName('A\\$300') }));

      await waitFor(() => expect(getTopUpCreditStatusAction).toHaveBeenCalledWith('pi_1', null));
      expect(screen.getByRole('button', { name: 'Adding to balance…' })).toBeDisabled();
      expect(onFunded).not.toHaveBeenCalled();

      vi.mocked(getTopUpCreditStatusAction).mockResolvedValue({
        status: 'credited',
        balanceMinor: 30_000,
        promoGranted: null,
        mandateActive: false,
      });
      poll.resolve({ status: 'pending', balanceMinor: 0 });
      await waitFor(() => expect(onFunded).toHaveBeenCalledTimes(1), { timeout: 4_000 });
      expect(onFunded).toHaveBeenCalledWith({
        method: 'topup',
        creditedMinor: 30_000,
        companyName: 'Northwind',
      });
      expect(startPurchaseAction).toHaveBeenCalledTimes(1);
    });

    it('adds the promo bonus to the credited amount only when the grant landed', async () => {
      vi.mocked(validatePromoAction).mockResolvedValue({
        ok: true,
        grantMinor: 5_000,
        promoCodeId: 'promo-1',
      } as never);
      vi.mocked(getTopUpCreditStatusAction).mockResolvedValue({
        status: 'credited',
        balanceMinor: 35_000,
        promoGranted: true,
        mandateActive: false,
      });
      const { onFunded } = renderBlock(savedCardView());
      await userEvent.click(screen.getByRole('button', { name: /Have a promo code/ }));
      await userEvent.type(screen.getByLabelText('Promo code'), 'WELCOME');
      await userEvent.click(screen.getByRole('button', { name: 'Apply' }));
      expect(await screen.findByText(/Adds A\$350\.00 to Northwind's balance/)).toBeInTheDocument();

      await userEvent.click(screen.getByRole('button', { name: ctaName('A\\$300') }));
      await waitFor(() => expect(onFunded).toHaveBeenCalledTimes(1));
      expect(onFunded).toHaveBeenCalledWith({
        method: 'topup',
        creditedMinor: 35_000,
        companyName: 'Northwind',
      });
    });

    it('credits the amount alone when the promo grant was skipped', async () => {
      vi.mocked(validatePromoAction).mockResolvedValue({
        ok: true,
        grantMinor: 5_000,
        promoCodeId: 'promo-1',
      } as never);
      vi.mocked(getTopUpCreditStatusAction).mockResolvedValue({
        status: 'credited',
        balanceMinor: 30_000,
        promoGranted: false,
        mandateActive: false,
      });
      const { onFunded } = renderBlock(savedCardView());
      await userEvent.click(screen.getByRole('button', { name: /Have a promo code/ }));
      await userEvent.type(screen.getByLabelText('Promo code'), 'WELCOME');
      await userEvent.click(screen.getByRole('button', { name: 'Apply' }));
      await screen.findByText(/WELCOME applied/);

      await userEvent.click(screen.getByRole('button', { name: ctaName('A\\$300') }));
      await waitFor(() => expect(onFunded).toHaveBeenCalledTimes(1));
      expect(onFunded).toHaveBeenCalledWith({
        method: 'topup',
        creditedMinor: 30_000,
        companyName: 'Northwind',
      });
    });

    it('waits for a mandate re-armed on the new card to be live before booking', async () => {
      vi.mocked(startPurchaseAction).mockResolvedValue({
        ok: true,
        outcome: 'needs_client_confirmation',
        clientSecret: 'pi_secret',
        paymentIntentId: 'pi_1',
        mandate: {
          outcome: 'requires_action',
          clientSecret: 'seti_secret',
          setupIntentId: 'seti_1',
        },
        walletId: 'wallet-1',
      });
      vi.mocked(getTopUpCreditStatusAction)
        .mockResolvedValueOnce({
          status: 'credited',
          balanceMinor: 30_000,
          promoGranted: null,
          mandateActive: false,
        })
        .mockResolvedValue({
          status: 'credited',
          balanceMinor: 30_000,
          promoGranted: null,
          mandateActive: true,
        });
      const { onFunded } = renderBlock(managerView());
      await userEvent.click(screen.getByRole('button', { name: ctaName('A\\$300') }));

      await waitFor(() => expect(getTopUpCreditStatusAction).toHaveBeenCalledTimes(1));
      expect(mockStripeApi.confirmSetup).toHaveBeenCalledTimes(1);
      expect(onFunded).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Adding to balance…' })).toBeDisabled();

      await waitFor(() => expect(onFunded).toHaveBeenCalledTimes(1), { timeout: 4_000 });
      expect(getTopUpCreditStatusAction).toHaveBeenCalledTimes(2);
      expect(startPurchaseAction).toHaveBeenCalledTimes(1);
    });

    it('books straight after the credit when the mandate was not captured', async () => {
      vi.mocked(startPurchaseAction).mockResolvedValue({
        ok: true,
        outcome: 'needs_client_confirmation',
        clientSecret: 'pi_secret',
        paymentIntentId: 'pi_1',
        mandate: {
          outcome: 'requires_action',
          clientSecret: 'seti_secret',
          setupIntentId: 'seti_1',
        },
        walletId: 'wallet-1',
      });
      mockStripeApi.confirmSetup.mockResolvedValueOnce({ error: { type: 'card_error' } });
      vi.mocked(getTopUpCreditStatusAction).mockResolvedValue({
        status: 'credited',
        balanceMinor: 30_000,
        promoGranted: null,
        mandateActive: false,
      });
      const { onFunded } = renderBlock(managerView());
      await userEvent.click(screen.getByRole('button', { name: ctaName('A\\$300') }));

      await waitFor(() => expect(onFunded).toHaveBeenCalledTimes(1));
      expect(getTopUpCreditStatusAction).toHaveBeenCalledTimes(1);
    });

    it('offers Book now when the credit cannot be confirmed, and never charges again', async () => {
      vi.mocked(getTopUpCreditStatusAction).mockResolvedValueOnce({ status: 'unauthorized' });
      const { onFunded } = renderBlock(savedCardView());
      await userEvent.click(screen.getByRole('button', { name: ctaName('A\\$300') }));

      await waitFor(() =>
        expect(screen.getByRole('status')).toHaveTextContent(creditPendingCopy('Northwind'))
      );
      expect(onFunded).not.toHaveBeenCalled();
      expect(trackedPayloads(BOOKING_EVENTS.FUNDING_FAILED)).toEqual([
        { reason: 'credit_timeout' },
      ]);

      await userEvent.click(screen.getByRole('button', { name: 'Book now' }));
      await waitFor(() => expect(onFunded).toHaveBeenCalledTimes(1));
      expect(startPurchaseAction).toHaveBeenCalledTimes(1);
    });

    it('returns to the pay action when the booking did not complete', async () => {
      const onFunded = vi.fn(async () => false);
      renderBlock(savedCardView(), { onFunded });
      await userEvent.click(screen.getByRole('button', { name: ctaName('A\\$300') }));
      await waitFor(() => expect(onFunded).toHaveBeenCalledTimes(1));
      expect(await screen.findByRole('button', { name: ctaName('A\\$300') })).toBeEnabled();
    });

    it('closes FUNDED out as a failed booking when the booking after the credit does not land', async () => {
      const onFunded = vi.fn(async () => false);
      renderBlock(savedCardView(), { onFunded });
      await userEvent.click(screen.getByRole('button', { name: ctaName('A\\$300') }));
      await waitFor(() => expect(onFunded).toHaveBeenCalledTimes(1));

      await waitFor(() =>
        expect(trackedPayloads(BOOKING_EVENTS.FUNDING_FAILED)).toEqual([
          { reason: 'booking_failed' },
        ])
      );
      expect(trackedPayloads(BOOKING_EVENTS.FUNDED)).toHaveLength(1);
    });

    it('never reports a failed booking when the booking lands', async () => {
      const { onFunded } = renderBlock(savedCardView());
      await userEvent.click(screen.getByRole('button', { name: ctaName('A\\$300') }));
      await waitFor(() => expect(onFunded).toHaveBeenCalledTimes(1));

      expect(trackedPayloads(BOOKING_EVENTS.FUNDING_FAILED)).toEqual([]);
    });

    it('reports a booking that throws and returns to the pay action', async () => {
      const failure = new Error('book failed');
      const onFunded = vi.fn(async () => {
        throw failure;
      });
      renderBlock(savedCardView(), { onFunded });
      await userEvent.click(screen.getByRole('button', { name: ctaName('A\\$300') }));
      await waitFor(() =>
        expect(mockCaptureException).toHaveBeenCalledWith(failure, expect.anything())
      );
      expect(await screen.findByRole('button', { name: ctaName('A\\$300') })).toBeEnabled();
      expect(trackedPayloads(BOOKING_EVENTS.FUNDING_FAILED)).toEqual([
        { reason: 'booking_failed' },
      ]);
    });

    it('shows the decline copy and never books', async () => {
      vi.mocked(startPurchaseAction).mockResolvedValue({ ok: false, error: 'card_declined' });
      const { onFunded } = renderBlock(savedCardView());
      await userEvent.click(screen.getByRole('button', { name: ctaName('A\\$300') }));
      expect(await screen.findByRole('alert')).toHaveTextContent(BOOKING_PAY_ERROR_COPY.declined);
      expect(onFunded).not.toHaveBeenCalled();
      expect(getTopUpCreditStatusAction).not.toHaveBeenCalled();
      expect(trackedPayloads(BOOKING_EVENTS.FUNDING_FAILED)).toEqual([{ reason: 'declined' }]);
    });

    it('switches to the new-card path from the decline escape', async () => {
      vi.mocked(startPurchaseAction).mockResolvedValue({ ok: false, error: 'card_declined' });
      renderBlock(savedCardView());
      await userEvent.click(screen.getByRole('button', { name: ctaName('A\\$300') }));
      await userEvent.click(await screen.findByRole('button', { name: 'Use a different card' }));
      await userEvent.click(screen.getByRole('button', { name: ctaName('A\\$300') }));
      await waitFor(() => expect(startPurchaseAction).toHaveBeenCalledTimes(2));
      expect(vi.mocked(startPurchaseAction).mock.calls[1]?.[0].paymentMethodSource).toBe(
        'new_card'
      );
    });
  });

  describe('amount radiogroup keyboard', () => {
    it('has one tab stop, on the selected option', () => {
      renderBlock(managerView());
      const tabStops = within(screen.getByRole('radiogroup', { name: 'Amount' }))
        .getAllByRole('radio')
        .filter((radio) => radio.tabIndex === 0);
      expect(tabStops).toHaveLength(1);
      expect(tabStops[0]).toHaveAttribute('aria-checked', 'true');
    });

    it('arrow keys move the selection and focus, wrapping at the ends', async () => {
      renderBlock(managerView());
      screen.getByRole('radio', { name: /A\$300\s*Minimum/ }).focus();

      await userEvent.keyboard('{ArrowRight}');
      expect(screen.getByRole('radio', { name: /A\$1,000/ })).toHaveFocus();
      expect(screen.getByRole('radio', { name: /A\$1,000/ })).toHaveAttribute(
        'aria-checked',
        'true'
      );

      await userEvent.keyboard('{ArrowLeft}{ArrowLeft}');
      expect(screen.getByRole('radio', { name: 'Other' })).toHaveFocus();
    });

    it('Home and End jump to the first and last option', async () => {
      renderBlock(managerView());
      screen.getByRole('radio', { name: /A\$300\s*Minimum/ }).focus();

      await userEvent.keyboard('{End}');
      expect(screen.getByRole('radio', { name: 'Other' })).toHaveFocus();

      await userEvent.keyboard('{Home}');
      expect(screen.getByRole('radio', { name: /A\$300\s*Minimum/ })).toHaveFocus();
    });

    it('arrowing onto Other keeps focus on the radios; pressing it moves focus to the field', async () => {
      renderBlock(managerView());
      screen.getByRole('radio', { name: /A\$300\s*Minimum/ }).focus();

      await userEvent.keyboard('{End}');
      expect(screen.getByRole('radio', { name: 'Other' })).toHaveFocus();

      await userEvent.click(screen.getByRole('radio', { name: /A\$300\s*Minimum/ }));
      await userEvent.click(screen.getByRole('radio', { name: 'Other' }));
      expect(screen.getByLabelText('Top-up amount in Australian dollars')).toHaveFocus();
    });

    it('marks the selected option with a check, not colour alone', () => {
      renderBlock(managerView());
      const selected = screen.getByRole('radio', { name: /A\$300\s*Minimum/ });
      expect(selected.querySelector('svg')).not.toBeNull();
      expect(screen.getByRole('radio', { name: /A\$1,000/ }).querySelector('svg')).toBeNull();
    });
  });

  describe('credited top-up whose booking did not land', () => {
    it('rotates the payment key so the next press is a new attempt', async () => {
      const onFunded = vi.fn(async () => false);
      renderBlock(savedCardView(), { onFunded });

      await userEvent.click(screen.getByRole('button', { name: ctaName('A\\$300') }));
      await waitFor(() => expect(onFunded).toHaveBeenCalledTimes(1));
      await userEvent.click(await screen.findByRole('button', { name: ctaName('A\\$300') }));
      await waitFor(() => expect(startPurchaseAction).toHaveBeenCalledTimes(2));

      const [first, second] = vi.mocked(startPurchaseAction).mock.calls.map(([input]) => input);
      expect(first?.clientRequestId).toBeTruthy();
      expect(second?.clientRequestId).not.toBe(first?.clientRequestId);
    });

    it('starts the controls afresh when a re-read changes the amount the booking needs', async () => {
      const view = managerView({ suggestedTopUpMinor: 30_000 });
      const { rerender, ...props } = renderBlock(view);
      await userEvent.click(screen.getByRole('radio', { name: /A\$1,000/ }));
      expect(screen.getByRole('radio', { name: /A\$1,000/ })).toHaveAttribute(
        'aria-checked',
        'true'
      );

      rerender(
        <BookingFundingBlock {...props} view={managerView({ suggestedTopUpMinor: 60_000 })} />
      );

      expect(screen.getByRole('radio', { name: /A\$600\s*Minimum/ })).toHaveAttribute(
        'aria-checked',
        'true'
      );
      expect(screen.getByRole('button', { name: ctaName('A\\$600') })).toBeInTheDocument();
    });
  });

  describe('stage announcements, focus and the busy report', () => {
    it('announces each stage in one persistent polite status region', async () => {
      const poll = deferred<{ status: 'pending'; balanceMinor: number }>();
      vi.mocked(getTopUpCreditStatusAction).mockReturnValueOnce(poll.promise);
      renderBlock(savedCardView());
      const region = screen.getByRole('status');
      expect(region).toHaveAttribute('aria-live', 'polite');
      expect(region).toHaveTextContent('');

      await userEvent.click(screen.getByRole('button', { name: ctaName('A\\$300') }));

      await waitFor(() =>
        expect(screen.getByRole('status')).toHaveTextContent('Adding to balance…')
      );
      expect(screen.getByRole('status')).toBe(region);
      poll.resolve({ status: 'pending', balanceMinor: 0 });
    });

    it('keeps focus in the action slot when the pay button is replaced', async () => {
      const poll = deferred<{ status: 'pending'; balanceMinor: number }>();
      vi.mocked(getTopUpCreditStatusAction).mockReturnValueOnce(poll.promise);
      renderBlock(savedCardView());

      await userEvent.click(screen.getByRole('button', { name: ctaName('A\\$300') }));

      const busy = await screen.findByRole('button', { name: 'Adding to balance…' });
      await waitFor(() => expect(busy.parentElement).toHaveFocus());
      poll.resolve({ status: 'pending', balanceMinor: 0 });
    });

    it('reports in-flight only while something runs: an unconfirmed credit is busy, not in flight', async () => {
      vi.mocked(getTopUpCreditStatusAction).mockResolvedValueOnce({ status: 'unauthorized' });
      const onBusyChange = vi.fn();
      const onInFlightChange = vi.fn();
      renderBlock(savedCardView(), { onBusyChange, onInFlightChange });
      expect(onInFlightChange).toHaveBeenLastCalledWith(false);

      await userEvent.click(screen.getByRole('button', { name: ctaName('A\\$300') }));

      await waitFor(() => expect(onInFlightChange).toHaveBeenCalledWith(true));
      await screen.findByRole('button', { name: 'Book now' });
      await waitFor(() => expect(onInFlightChange).toHaveBeenLastCalledWith(false));
      expect(onBusyChange).toHaveBeenLastCalledWith(true);
    });

    it('reports busy from the payment until the block returns to the pay action', async () => {
      const onBusyChange = vi.fn();
      const onFunded = vi.fn(async () => false);
      renderBlock(savedCardView(), { onBusyChange, onFunded });
      expect(onBusyChange).toHaveBeenLastCalledWith(false);

      await userEvent.click(screen.getByRole('button', { name: ctaName('A\\$300') }));

      await waitFor(() => expect(onBusyChange).toHaveBeenCalledWith(true));
      await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(false));
    });
  });

  describe('member arm', () => {
    it('names the billing admins in the Save sentence', () => {
      renderBlock(memberView());
      expect(screen.getByText(/we'll let your billing admins know/)).toBeInTheDocument();
    });

    it('drops the on-device sentence when no draft is kept', () => {
      renderBlock(memberView(), { draftKept: false });
      expect(screen.queryByText(/stays on this device/)).not.toBeInTheDocument();
    });
    it('renders no payment controls, and Save calls onSaveForLater', async () => {
      const { onSaveForLater } = renderBlock(memberView());
      expect(screen.queryByTestId('payment-element')).not.toBeInTheDocument();
      expect(screen.queryByRole('radio')).not.toBeInTheDocument();
      expect(screen.queryByText(FUNDING_AUD_LINE)).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Save and finish later' }));
      expect(onSaveForLater).toHaveBeenCalledTimes(1);
      expect(startPurchaseAction).not.toHaveBeenCalled();
    });

    it('shows Saving… while the save is pending', async () => {
      const save = deferred<undefined>();
      renderBlock(memberView(), { onSaveForLater: () => save.promise });
      await userEvent.click(screen.getByRole('button', { name: 'Save and finish later' }));
      expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
      save.resolve(undefined);
      expect(await screen.findByRole('button', { name: 'Save and finish later' })).toBeEnabled();
    });

    it('reports a save that throws and lets the member try again', async () => {
      const failure = new Error('save failed');
      renderBlock(memberView(), {
        onSaveForLater: vi.fn(async () => {
          throw failure;
        }),
      });
      await userEvent.click(screen.getByRole('button', { name: 'Save and finish later' }));
      await waitFor(() =>
        expect(mockCaptureException).toHaveBeenCalledWith(failure, expect.anything())
      );
      expect(await screen.findByRole('button', { name: 'Save and finish later' })).toBeEnabled();
    });
  });

  describe('analytics and copy rules', () => {
    it('fires FUNDING_SHOWN once per arm and company, not on re-render', () => {
      const view = managerView();
      const { rerender, ...props } = renderBlock(view);
      rerender(<BookingFundingBlock {...props} view={managerView()} />);
      expect(trackedPayloads(BOOKING_EVENTS.FUNDING_SHOWN)).toEqual([
        { arm: 'setup', can_manage_billing: true },
      ]);
      rerender(
        <BookingFundingBlock
          {...props}
          view={managerView({ arm: 'hold', topUpNeededMinor: 27_500 })}
        />
      );
      expect(trackedPayloads(BOOKING_EVENTS.FUNDING_SHOWN)).toHaveLength(2);
    });

    it('carries no money property in any booking funding event', async () => {
      renderBlock(savedCardView(), { onFunded: vi.fn(async () => false) });
      await userEvent.click(screen.getByRole('button', { name: ctaName('A\\$300') }));
      await waitFor(() => expect(trackedPayloads(BOOKING_EVENTS.FUNDED)).toHaveLength(1));
      expect(trackedPayloads(BOOKING_EVENTS.FUNDED)).toEqual([
        { method: 'topup', saved_card: true },
      ]);

      vi.mocked(startPurchaseAction).mockResolvedValue({ ok: false, error: 'card_declined' });
      renderBlock(savedCardView());
      await userEvent.click(
        screen.getAllByRole('button', { name: ctaName('A\\$300') })[1] as HTMLElement
      );
      await waitFor(() =>
        expect(trackedPayloads(BOOKING_EVENTS.FUNDING_FAILED)).toContainEqual({
          reason: 'declined',
        })
      );

      const payloads = [
        ...trackedPayloads(BOOKING_EVENTS.FUNDING_SHOWN),
        ...trackedPayloads(BOOKING_EVENTS.FUNDED),
        ...trackedPayloads(BOOKING_EVENTS.FUNDING_FAILED),
      ];
      expect(payloads.length).toBeGreaterThanOrEqual(3);
      for (const payload of payloads) {
        expect(Object.keys(payload as object).filter((key) => /minor|amount/i.test(key))).toEqual(
          []
        );
      }
    });

    it.each([
      ['setup first time', managerView()],
      ['setup returning', savedCardView()],
      [
        'reserved',
        managerView({ arm: 'reserved', topUpNeededMinor: 27_500, reservedBookingCount: 2 }),
      ],
      ['hold', managerView({ arm: 'hold', topUpNeededMinor: 27_500 })],
      ['member', memberView()],
    ])('%s shows no hourly rate', (_label, view) => {
      const { container } = renderBlock(view);
      const text = (container.textContent ?? '').replace(FUNDING_AUD_LINE, '');
      expect(text).not.toMatch(/\/hr|\/min|per hour|per minute|hourly|\brate\b/i);
    });
  });

  it('keeps ledger and database access out of the funding directory', () => {
    const dir = path.dirname(new URL(import.meta.url).pathname);
    const sources = readdirSync(dir).filter(
      (file) => /\.(ts|tsx)$/.test(file) && !/\.test\./.test(file)
    );
    expect(sources.length).toBeGreaterThan(0);
    for (const file of sources) {
      const text = readFileSync(path.join(dir, file), 'utf8');
      expect(text, file).not.toContain('@balo/db');
      expect(text, file).not.toContain('Ledger');
    }
  });

  describe('funding method picker', () => {
    const method = (name: RegExp) => screen.getByRole('radio', { name });

    it('offers both methods on the setup arm, defaulting to Top up now', () => {
      renderBlock(managerView());
      expect(screen.getByRole('radiogroup', { name: 'How to pay' })).toBeInTheDocument();
      expect(method(/Top up now/)).toHaveAttribute('aria-checked', 'true');
      expect(method(/Pay after the call/)).toHaveAttribute('aria-checked', 'false');
      expect(screen.getByRole('radiogroup', { name: 'Amount' })).toBeInTheDocument();
    });

    it('offers both methods on the reserved arm', () => {
      renderBlock(
        managerView({ arm: 'reserved', topUpNeededMinor: 27_500, reservedBookingCount: 2 })
      );
      expect(screen.getByRole('radiogroup', { name: 'How to pay' })).toBeInTheDocument();
    });

    it('is absent on the hold arm', () => {
      renderBlock(managerView({ arm: 'hold', topUpNeededMinor: 27_500 }));
      expect(screen.queryByRole('radiogroup', { name: 'How to pay' })).not.toBeInTheDocument();
    });

    it('is absent for a member', () => {
      renderBlock(memberView());
      expect(screen.queryByRole('radiogroup', { name: 'How to pay' })).not.toBeInTheDocument();
    });

    it('is absent when Stripe is not configured', () => {
      delete process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
      try {
        renderBlock(managerView());
        expect(screen.queryByRole('radiogroup', { name: 'How to pay' })).not.toBeInTheDocument();
      } finally {
        process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = 'pk_test_123';
      }
    });

    it('switches to Pay after, tracks the choice once, and swaps the controls', async () => {
      renderBlock(managerView());
      expect(trackedPayloads(BOOKING_EVENTS.FUNDING_METHOD_SELECTED)).toEqual([]);
      await userEvent.click(method(/Pay after the call/));
      expect(trackedPayloads(BOOKING_EVENTS.FUNDING_METHOD_SELECTED)).toEqual([
        { method: 'pay_after' },
      ]);
      expect(screen.queryByRole('radiogroup', { name: 'Amount' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Add card & book' })).toBeInTheDocument();
      expect(method(/Pay after the call/)).toHaveAttribute('aria-checked', 'true');
      await userEvent.click(method(/Top up now/));
      expect(screen.getByRole('radiogroup', { name: 'Amount' })).toBeInTheDocument();
    });

    it('tracks nothing when the selected method is clicked again', async () => {
      renderBlock(managerView());
      await userEvent.click(method(/Top up now/));
      expect(trackedPayloads(BOOKING_EVENTS.FUNDING_METHOD_SELECTED)).toEqual([]);
    });

    it('moves between the methods with the arrow keys', async () => {
      renderBlock(managerView());
      method(/Top up now/).focus();
      await userEvent.keyboard('{ArrowRight}');
      expect(method(/Pay after the call/)).toHaveFocus();
      expect(method(/Pay after the call/)).toHaveAttribute('aria-checked', 'true');
    });
  });
});

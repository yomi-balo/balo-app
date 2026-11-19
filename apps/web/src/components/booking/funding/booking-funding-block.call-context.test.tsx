import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('motion/react', async () => {
  const { createMotionStub } = await import('@/test/motion-stub');
  return createMotionStub();
});

vi.mock('@/lib/credit/actions', () => ({
  validatePromoAction: vi.fn(),
  startPurchaseAction: vi.fn(),
  getTopUpCreditStatusAction: vi.fn(),
  getWalletMandateStatusAction: vi.fn(),
  saveLowBalanceConfigAction: vi.fn(),
  armSavedCardMandateAction: vi.fn(),
  startCardCaptureAction: vi.fn(),
}));
vi.mock('@/lib/stripe/resolve-setup-next-action', () => ({
  resolveSetupIntentNextAction: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
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
  Elements: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PaymentElement: () => <div data-testid="payment-element" />,
  useStripe: () => mockStripeApi,
  useElements: () => mockElementsApi,
}));

import { track, BOOKING_EVENTS, CREDIT_EVENTS } from '@/lib/analytics';
import {
  armSavedCardMandateAction,
  getTopUpCreditStatusAction,
  getWalletMandateStatusAction,
  saveLowBalanceConfigAction,
  startCardCaptureAction,
  startPurchaseAction,
} from '@/lib/credit/actions';
import { BookingFundingBlock, type BookingFundingBlockProps } from './booking-funding-block';
import { SAVED_CARD, refusedView } from './funding-fixtures';
import type { RefusedFundingView } from './funding-disposition';

const FIGURES = { topupReloadMinor: 10_000, topupThresholdMinor: 2_000 };
const BOOKING_WORDING = /\bbook/i;

function managerView(overrides: Partial<RefusedFundingView> = {}): RefusedFundingView {
  return refusedView({
    wallet: { savedCard: SAVED_CARD, lowBalanceFigures: FIGURES },
    firstTime: false,
    ...overrides,
  });
}

function renderCall(
  view: RefusedFundingView,
  overrides: Partial<BookingFundingBlockProps> = {}
): BookingFundingBlockProps {
  const props: BookingFundingBlockProps = {
    view,
    context: 'call',
    caseSaved: null,
    ctaDisabled: false,
    onBeforePay: vi.fn(() => true),
    onFunded: vi.fn(async () => true),
    onSaveForLater: vi.fn(async () => undefined),
    onBack: vi.fn(),
    draftKept: false,
    onBusyChange: vi.fn(),
    onInFlightChange: vi.fn(),
    ...overrides,
  };
  render(<BookingFundingBlock {...props} />);
  return props;
}

/** Everything on screen — visible text and the screen-reader live region — never says "book". */
function expectNoBookingWording(): void {
  expect(document.body.textContent).not.toMatch(BOOKING_WORDING);
}

const bookingEventNames: ReadonlySet<string> = new Set(Object.values(BOOKING_EVENTS));
function bookingEventsSent(): string[] {
  return vi
    .mocked(track)
    .mock.calls.map(([name]) => String(name))
    .filter((name) => bookingEventNames.has(name));
}

function method(name: RegExp): HTMLElement {
  return screen.getByRole('radio', { name });
}

describe('BookingFundingBlock in the call context', () => {
  beforeAll(() => {
    process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = 'pk_test_123';
  });
  afterAll(() => {
    delete process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
  });
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(startPurchaseAction).mockResolvedValue({
      ok: true,
      outcome: 'complete',
      paymentIntentId: 'pi_1',
      mandate: { outcome: 'not_required' },
      walletId: 'wallet-1',
    });
    vi.mocked(getTopUpCreditStatusAction).mockResolvedValue({
      status: 'credited',
      balanceMinor: 30_000,
      promoGranted: null,
      mandateActive: false,
    });
    vi.mocked(saveLowBalanceConfigAction).mockResolvedValue({ ok: true });
    vi.mocked(armSavedCardMandateAction).mockResolvedValue({ ok: true, outcome: 'captured' });
    vi.mocked(getWalletMandateStatusAction).mockResolvedValue({ status: 'active' });
    vi.mocked(startCardCaptureAction).mockResolvedValue({
      ok: true,
      clientSecret: 'seti_secret',
      setupIntentId: 'seti_1',
      publishableKey: 'pk_test',
    });
  });

  describe('band copy', () => {
    it.each([
      [
        'a first-time setup',
        { firstTime: true, wallet: { savedCard: null, lowBalanceFigures: FIGURES } },
      ],
      ['a returning setup', {}],
      [
        'a reserved balance',
        { arm: 'reserved', topUpNeededMinor: 27_500, reservedBookingCount: 2 },
      ],
      ['a hold with a figure', { arm: 'hold', topUpNeededMinor: 27_500 }],
      ['a hold the balance already covers', { arm: 'hold', topUpNeededMinor: null }],
    ] as const)('never says booking for %s', (_label, overrides) => {
      renderCall(managerView(overrides));
      expectNoBookingWording();
    });

    it('says the call starts straight after the top-up', () => {
      renderCall(managerView({ firstTime: true }));
      expect(screen.getByText(/the call starts straight after/)).toBeInTheDocument();
    });

    it('says the call, not the booking, on the pay-after band', async () => {
      renderCall(
        managerView({ arm: 'reserved', topUpNeededMinor: 27_500, reservedBookingCount: 2 })
      );
      await userEvent.click(method(/Pay after the call/));
      expect(screen.getByText(/the call starts straight away/)).toBeInTheDocument();
      expectNoBookingWording();
    });
  });

  describe('top up', () => {
    it('labels the action "Top up … & call"', () => {
      renderCall(managerView());
      expect(screen.getByRole('button', { name: /^Top up A\$300 & call/ })).toBeInTheDocument();
      expectNoBookingWording();
    });

    it('speaks "call" through every stage and sends no booking events', async () => {
      let finish: (value: boolean) => void = () => undefined;
      const onFunded = vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            finish = resolve;
          })
      );
      renderCall(managerView(), { onFunded });
      await userEvent.click(screen.getByRole('button', { name: /^Top up A\$300 & call/ }));

      await screen.findByRole('button', { name: 'Starting the call…' });
      expectNoBookingWording();

      finish(false);
      await screen.findByRole('button', { name: /^Top up A\$300 & call/ });
      expectNoBookingWording();
      expect(bookingEventsSent()).toEqual([]);
    });

    it('offers "Call now" when the credit cannot be confirmed, and says so without "book"', async () => {
      vi.mocked(getTopUpCreditStatusAction).mockResolvedValueOnce({ status: 'unauthorized' });
      const onFunded = vi.fn(async () => true);
      renderCall(managerView(), { onFunded });
      await userEvent.click(screen.getByRole('button', { name: /^Top up A\$300 & call/ }));

      await screen.findByRole('button', { name: 'Call now' });
      expect(screen.getByRole('status')).toHaveTextContent(/Press Call now to finish/);
      expectNoBookingWording();
      expect(bookingEventsSent()).toEqual([]);

      await userEvent.click(screen.getByRole('button', { name: 'Call now' }));
      await waitFor(() => expect(onFunded).toHaveBeenCalledTimes(1));
    });

    it('sends no booking event for a failed payment either', async () => {
      vi.mocked(startPurchaseAction).mockResolvedValue({ ok: false, error: 'card_declined' });
      renderCall(managerView());
      await userEvent.click(screen.getByRole('button', { name: /^Top up A\$300 & call/ }));
      await screen.findByRole('alert');
      expectNoBookingWording();
      expect(bookingEventsSent()).toEqual([]);
    });

    it('sends no funding-shown event on mount and no method-selected event on a switch', async () => {
      renderCall(
        managerView({ arm: 'reserved', topUpNeededMinor: 27_500, reservedBookingCount: 2 })
      );
      await userEvent.click(method(/Pay after the call/));
      expect(bookingEventsSent()).toEqual([]);
    });
  });

  describe('pay after the call', () => {
    async function choosePayAfter(): Promise<void> {
      await userEvent.click(method(/Pay after the call/));
    }

    it('uses the call wording on the consent line and the action', async () => {
      renderCall(managerView());
      await choosePayAfter();
      expect(screen.getByText(/^By calling, you switch/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Start the call, pay after' })).toBeEnabled();
      expectNoBookingWording();
    });

    it('funds with a saved card, speaks "call" throughout, and sends no booking events', async () => {
      const onFunded = vi.fn(async () => true);
      renderCall(managerView(), { onFunded });
      await choosePayAfter();
      await userEvent.click(screen.getByRole('button', { name: 'Start the call, pay after' }));

      await waitFor(() => expect(onFunded).toHaveBeenCalledTimes(1));
      expect(bookingEventsSent()).toEqual([]);
      const credit = vi
        .mocked(track)
        .mock.calls.filter(([name]) => name === CREDIT_EVENTS.MANDATE_CAPTURED);
      expect(credit).toHaveLength(1);
      expect(credit[0]?.[1]).toMatchObject({ surface: 'call' });
      expectNoBookingWording();
    });

    it('names the call, not the booking, when the card is declined', async () => {
      vi.mocked(getWalletMandateStatusAction).mockResolvedValue({ status: 'failed' });
      renderCall(managerView({ wallet: { savedCard: null, lowBalanceFigures: FIGURES } }));
      await choosePayAfter();
      await userEvent.click(screen.getByRole('button', { name: 'Add card & call' }));
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(/the call hasn't started/);
      expectNoBookingWording();
      expect(bookingEventsSent()).toEqual([]);
    });
  });

  describe('credit events', () => {
    const creditEventNames: ReadonlySet<string> = new Set(Object.values(CREDIT_EVENTS));
    function creditSurfaces(): unknown[] {
      return vi
        .mocked(track)
        .mock.calls.filter(([name]) => creditEventNames.has(String(name)))
        .map(([, props]) => (props as { surface?: unknown } | undefined)?.surface);
    }

    it.each(['call', 'answer'] as const)(
      '⚠ the %s context reports surface "call", never "booking", on every credit event',
      async (context) => {
        renderCall(managerView(), { context });
        await userEvent.click(screen.getByRole('button', { name: /^Top up A\$300 & / }));
        await waitFor(() => expect(startPurchaseAction).toHaveBeenCalled());
        await userEvent.click(method(/Pay after the call/)).catch(() => undefined);

        const surfaces = creditSurfaces();
        expect(surfaces.length).toBeGreaterThan(0);
        expect(surfaces.filter((surface) => surface !== undefined)).not.toContain('booking');
        expect(surfaces).toContain('call');
      }
    );

    it('a payment-method switch reports surface "call"', async () => {
      renderCall(managerView());
      await userEvent.click(screen.getByRole('button', { name: 'Change' }));
      expect(track).toHaveBeenCalledWith(CREDIT_EVENTS.PAYMENT_METHOD_CHANGED, {
        to: 'new_card',
        surface: 'call',
      });
    });
  });

  describe('answering a call', () => {
    const CALL_PLACING_WORDING = /call now|starting the call|start the call/i;

    function expectAnswerWording(): void {
      expect(document.body.textContent).not.toMatch(CALL_PLACING_WORDING);
      expectNoBookingWording();
    }

    it('labels the action "Top up … & answer", never "call now"', () => {
      renderCall(managerView(), { context: 'answer' });
      expect(screen.getByRole('button', { name: /^Top up A\$300 & answer/ })).toBeInTheDocument();
      expectAnswerWording();
    });

    it('says "Answering…" while it runs and sends no booking events', async () => {
      let finish: (value: boolean) => void = () => undefined;
      const onFunded = vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            finish = resolve;
          })
      );
      renderCall(managerView(), { context: 'answer', onFunded });
      await userEvent.click(screen.getByRole('button', { name: /^Top up A\$300 & answer/ }));

      await screen.findByRole('button', { name: 'Answering…' });
      expectAnswerWording();

      finish(false);
      await screen.findByRole('button', { name: /^Top up A\$300 & answer/ });
      expect(bookingEventsSent()).toEqual([]);
    });

    it('offers "Answer" when the credit cannot be confirmed', async () => {
      vi.mocked(getTopUpCreditStatusAction).mockResolvedValueOnce({ status: 'unauthorized' });
      renderCall(managerView(), { context: 'answer' });
      await userEvent.click(screen.getByRole('button', { name: /^Top up A\$300 & answer/ }));

      await screen.findByRole('button', { name: 'Answer' });
      expect(screen.getByRole('status')).toHaveTextContent(/Press Answer to finish/);
      expectAnswerWording();
    });

    it('uses the answering wording on the pay-after consent and action', async () => {
      renderCall(managerView(), { context: 'answer' });
      await userEvent.click(method(/Pay after the call/));
      expect(screen.getByText(/^By answering, you switch/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Answer, pay after' })).toBeEnabled();
      expectAnswerWording();
    });
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('motion/react', async () => {
  const { createMotionStub } = await import('@/test/motion-stub');
  return createMotionStub();
});

vi.mock('@/lib/credit/actions', () => ({
  getWalletMandateStatusAction: vi.fn(),
  saveLowBalanceConfigAction: vi.fn(),
  armSavedCardMandateAction: vi.fn(),
  startCardCaptureAction: vi.fn(),
  getTopUpCreditStatusAction: vi.fn(),
  startPurchaseAction: vi.fn(),
  validatePromoAction: vi.fn(),
}));
vi.mock('@/lib/stripe/resolve-setup-next-action', () => ({
  resolveSetupIntentNextAction: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const mockCaptureException = vi.fn();
vi.mock('@sentry/nextjs', () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

vi.mock('@/lib/stripe/loader', () => ({
  getStripe: (publishableKey: string) => Promise.resolve({ publishableKey }),
}));
const { mockStripeApi, mockElementsApi } = vi.hoisted(() => ({
  mockStripeApi: { confirmSetup: vi.fn(async () => ({})) },
  mockElementsApi: { submit: vi.fn(async () => ({})), update: vi.fn() },
}));
vi.mock('@stripe/react-stripe-js', () => ({
  Elements: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PaymentElement: () => <div data-testid="payment-element" />,
  useStripe: () => mockStripeApi,
  useElements: () => mockElementsApi,
}));

import { toast } from 'sonner';
import { track, BOOKING_EVENTS, CREDIT_EVENTS } from '@/lib/analytics';
import {
  armSavedCardMandateAction,
  getWalletMandateStatusAction,
  saveLowBalanceConfigAction,
  startCardCaptureAction,
} from '@/lib/credit/actions';
import { resolveSetupIntentNextAction } from '@/lib/stripe/resolve-setup-next-action';
import { BookingFundingBlock, type BookingFundingBlockProps } from './booking-funding-block';
import { PAY_AFTER_COPY, payAfterConsentLine } from './funding-copy';
import { SAVED_CARD, refusedView } from './funding-fixtures';
import type { RefusedFundingView } from './funding-disposition';

const FIGURES = { topupReloadMinor: 12_300, topupThresholdMinor: 4_500 };

function view(savedCard: typeof SAVED_CARD | null, overrides: Partial<RefusedFundingView> = {}) {
  return refusedView({
    wallet: { savedCard, lowBalanceFigures: FIGURES },
    firstTime: savedCard === null,
    ...overrides,
  });
}

function renderBlock(
  refused: RefusedFundingView,
  overrides: Partial<BookingFundingBlockProps> = {}
): BookingFundingBlockProps & { unmount: () => void } {
  const props: BookingFundingBlockProps = {
    view: refused,
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
  const { unmount } = render(<BookingFundingBlock {...props} />);
  return { ...props, unmount };
}

async function choosePayAfter(): Promise<void> {
  await userEvent.click(screen.getByRole('radio', { name: /Pay after the call/ }));
}

const payloads = (event: string): unknown[] =>
  vi
    .mocked(track)
    .mock.calls.filter(([name]) => name === event)
    .map(([, payload]) => payload);

describe('PayAfterFunding', () => {
  beforeAll(() => {
    process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = 'pk_test_123';
  });
  afterAll(() => {
    delete process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
  });
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(saveLowBalanceConfigAction).mockResolvedValue({ ok: true });
    vi.mocked(armSavedCardMandateAction).mockResolvedValue({ ok: true, outcome: 'captured' });
    vi.mocked(startCardCaptureAction).mockResolvedValue({
      ok: true,
      clientSecret: 'seti_secret',
      setupIntentId: 'seti_1',
      publishableKey: 'pk_test',
    });
    vi.mocked(getWalletMandateStatusAction).mockResolvedValue({ status: 'active' });
    mockStripeApi.confirmSetup.mockResolvedValue({});
    mockElementsApi.submit.mockResolvedValue({});
  });

  it('shows the consent line with the company and card before any press', async () => {
    renderBlock(view(SAVED_CARD, { firstTime: false }));
    await choosePayAfter();
    expect(screen.getByText(payAfterConsentLine('Northwind', SAVED_CARD))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: PAY_AFTER_COPY.ctaSaved })).toBeEnabled();
  });

  describe('saved card', () => {
    it('saves keep_going with the wallet figures BEFORE arming, books only once active, and says so', async () => {
      const order: string[] = [];
      vi.mocked(saveLowBalanceConfigAction).mockImplementation(async () => {
        order.push('save');
        return { ok: true };
      });
      vi.mocked(armSavedCardMandateAction).mockImplementation(async () => {
        order.push('arm');
        return { ok: true, outcome: 'captured' };
      });
      const props = renderBlock(view(SAVED_CARD, { firstTime: false }));
      await choosePayAfter();
      await userEvent.click(screen.getByRole('button', { name: PAY_AFTER_COPY.ctaSaved }));

      await waitFor(() =>
        expect(props.onFunded).toHaveBeenCalledWith({
          method: 'pay_after',
          card: SAVED_CARD,
          companyName: 'Northwind',
        })
      );
      expect(order).toEqual(['save', 'arm']);
      expect(saveLowBalanceConfigAction).toHaveBeenCalledWith({
        lowBalanceMode: 'keep_going',
        topupReloadMinor: 12_300,
        topupThresholdMinor: 4_500,
      });
      expect(getWalletMandateStatusAction).toHaveBeenCalled();
      expect(toast.success).toHaveBeenCalledWith('Keep me going is on for Northwind.');
      expect(payloads(BOOKING_EVENTS.FUNDED)).toEqual([{ method: 'pay_after', saved_card: true }]);
      expect(payloads(CREDIT_EVENTS.MANDATE_CAPTURED)).toEqual([
        { low_balance_mode: 'keep_going', surface: 'booking' },
      ]);
    });

    it('never books while the mandate is pending', async () => {
      vi.mocked(getWalletMandateStatusAction).mockResolvedValue({ status: 'pending' });
      const props = renderBlock(view(SAVED_CARD, { firstTime: false }));
      await choosePayAfter();
      await userEvent.click(screen.getByRole('button', { name: PAY_AFTER_COPY.ctaSaved }));
      await screen.findByRole('button', { name: PAY_AFTER_COPY.stage.awaiting_mandate });
      await waitFor(() => expect(getWalletMandateStatusAction).toHaveBeenCalled());
      expect(props.onFunded).not.toHaveBeenCalled();
    });

    it('resolves a bank challenge before waiting for the mandate', async () => {
      vi.mocked(armSavedCardMandateAction).mockResolvedValue({
        ok: true,
        outcome: 'requires_action',
        clientSecret: 'seti_secret',
      });
      vi.mocked(resolveSetupIntentNextAction).mockResolvedValue(true);
      const props = renderBlock(view(SAVED_CARD, { firstTime: false }));
      await choosePayAfter();
      await userEvent.click(screen.getByRole('button', { name: PAY_AFTER_COPY.ctaSaved }));
      await waitFor(() => expect(props.onFunded).toHaveBeenCalled());
      expect(resolveSetupIntentNextAction).toHaveBeenCalledWith('seti_secret');
    });

    it('shows the auth_failed line and does not book when the challenge is abandoned', async () => {
      vi.mocked(armSavedCardMandateAction).mockResolvedValue({
        ok: true,
        outcome: 'requires_action',
        clientSecret: 'seti_secret',
      });
      vi.mocked(resolveSetupIntentNextAction).mockResolvedValue(false);
      const props = renderBlock(view(SAVED_CARD, { firstTime: false }));
      await choosePayAfter();
      await userEvent.click(screen.getByRole('button', { name: PAY_AFTER_COPY.ctaSaved }));
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(PAY_AFTER_COPY.errors.auth_failed);
      expect(alert).toHaveTextContent(PAY_AFTER_COPY.switchedNote);
      expect(props.onFunded).not.toHaveBeenCalled();
      expect(payloads(BOOKING_EVENTS.FUNDING_FAILED)).toEqual([{ reason: 'auth_failed' }]);
    });
  });

  describe('new card', () => {
    it('captures, waits for the active mandate, THEN saves keep_going, then books', async () => {
      const order: string[] = [];
      vi.mocked(getWalletMandateStatusAction).mockImplementation(async () => {
        order.push('active');
        return { status: 'active' };
      });
      vi.mocked(saveLowBalanceConfigAction).mockImplementation(async () => {
        order.push('save');
        return { ok: true };
      });
      const props = renderBlock(view(null));
      await choosePayAfter();
      await userEvent.click(screen.getByRole('button', { name: PAY_AFTER_COPY.ctaNew }));

      await waitFor(() =>
        expect(props.onFunded).toHaveBeenCalledWith({
          method: 'pay_after',
          card: null,
          companyName: 'Northwind',
        })
      );
      expect(order).toEqual(['active', 'save']);
      expect(mockStripeApi.confirmSetup).toHaveBeenCalledWith(
        expect.objectContaining({ clientSecret: 'seti_secret', redirect: 'if_required' })
      );
      expect(armSavedCardMandateAction).not.toHaveBeenCalled();
      expect(payloads(BOOKING_EVENTS.FUNDED)).toEqual([{ method: 'pay_after', saved_card: false }]);
    });

    it('does not write the mode or book when the mandate fails', async () => {
      vi.mocked(getWalletMandateStatusAction).mockResolvedValue({ status: 'failed' });
      const props = renderBlock(view(null));
      await choosePayAfter();
      await userEvent.click(screen.getByRole('button', { name: PAY_AFTER_COPY.ctaNew }));
      expect(await screen.findByRole('alert')).toHaveTextContent(
        PAY_AFTER_COPY.errors.setup_failed
      );
      expect(screen.getByRole('alert')).not.toHaveTextContent(PAY_AFTER_COPY.switchedNote);
      expect(saveLowBalanceConfigAction).not.toHaveBeenCalled();
      expect(props.onFunded).not.toHaveBeenCalled();
      expect(payloads(BOOKING_EVENTS.FUNDING_FAILED)).toEqual([{ reason: 'setup_failed' }]);
      expect(screen.getByRole('button', { name: PAY_AFTER_COPY.ctaNew })).toBeEnabled();
    });

    it('says the card is saved when the mode write fails, then retries without capturing again', async () => {
      vi.mocked(saveLowBalanceConfigAction).mockResolvedValueOnce({
        ok: false,
        error: 'no_saved_card',
      });
      const props = renderBlock(view(null));
      await choosePayAfter();
      await userEvent.click(screen.getByRole('button', { name: PAY_AFTER_COPY.ctaNew }));
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(PAY_AFTER_COPY.errors.mode_failed);
      expect(alert).not.toHaveTextContent(PAY_AFTER_COPY.switchedNote);
      expect(props.onFunded).not.toHaveBeenCalled();
      expect(payloads(BOOKING_EVENTS.FUNDING_FAILED)).toEqual([{ reason: 'setup_failed' }]);

      expect(screen.queryByTestId('payment-element')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Change' })).not.toBeInTheDocument();
      expect(screen.getByText(PAY_AFTER_COPY.cardSaved)).toBeInTheDocument();
      expect(screen.getByText(payAfterConsentLine('Northwind', null))).toBeInTheDocument();
      let release: (value: { ok: true }) => void = () => undefined;
      vi.mocked(saveLowBalanceConfigAction).mockImplementationOnce(
        () => new Promise((resolve) => (release = resolve))
      );
      await userEvent.click(screen.getByRole('button', { name: PAY_AFTER_COPY.ctaSaved }));
      expect(
        await screen.findByRole('button', { name: PAY_AFTER_COPY.stage.setting_up_saved })
      ).toBeInTheDocument();
      release({ ok: true });
      await waitFor(() => expect(props.onFunded).toHaveBeenCalled());
      expect(startCardCaptureAction).toHaveBeenCalledTimes(1);
      expect(mockStripeApi.confirmSetup).toHaveBeenCalledTimes(1);
      expect(saveLowBalanceConfigAction).toHaveBeenCalledTimes(2);
    });

    it('never writes the mode when the confirm errors', async () => {
      mockStripeApi.confirmSetup.mockResolvedValue({
        error: { type: 'card_error', code: 'card_declined' },
      } as never);
      renderBlock(view(null));
      await choosePayAfter();
      await userEvent.click(screen.getByRole('button', { name: PAY_AFTER_COPY.ctaNew }));
      expect(await screen.findByRole('alert')).toHaveTextContent(PAY_AFTER_COPY.errors.declined);
      expect(saveLowBalanceConfigAction).not.toHaveBeenCalled();
      expect(getWalletMandateStatusAction).not.toHaveBeenCalled();
    });

    it('stays silent on an Element validation error', async () => {
      mockElementsApi.submit.mockResolvedValue({ error: { message: 'Incomplete' } } as never);
      renderBlock(view(null));
      await choosePayAfter();
      await userEvent.click(screen.getByRole('button', { name: PAY_AFTER_COPY.ctaNew }));
      await waitFor(() =>
        expect(screen.getByRole('button', { name: PAY_AFTER_COPY.ctaNew })).toBeEnabled()
      );
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(startCardCaptureAction).not.toHaveBeenCalled();
      expect(payloads(BOOKING_EVENTS.FUNDING_FAILED)).toEqual([]);
    });

    it('explains a card change refused while a call is running', async () => {
      vi.mocked(startCardCaptureAction).mockResolvedValue({
        ok: false,
        error: 'settlement_outstanding',
      });
      renderBlock(view(null));
      await choosePayAfter();
      await userEvent.click(screen.getByRole('button', { name: PAY_AFTER_COPY.ctaNew }));
      expect(await screen.findByRole('alert')).toHaveTextContent(
        PAY_AFTER_COPY.errors.settlement_outstanding
      );
    });
  });

  describe('mandate not confirmed in time', () => {
    beforeEach(() => {
      vi.mocked(getWalletMandateStatusAction).mockResolvedValue({ status: 'unauthorized' });
    });

    it('says it is still confirming, never that setup failed, and offers Check again', async () => {
      const props = renderBlock(view(null));
      await choosePayAfter();
      await userEvent.click(screen.getByRole('button', { name: PAY_AFTER_COPY.ctaNew }));
      expect(await screen.findByRole('button', { name: 'Check again' })).toBeEnabled();
      expect(screen.getAllByText(PAY_AFTER_COPY.unconfirmed).length).toBeGreaterThan(0);
      expect(screen.queryByText(PAY_AFTER_COPY.errors.setup_failed)).not.toBeInTheDocument();
      expect(payloads(BOOKING_EVENTS.FUNDING_FAILED)).toEqual([{ reason: 'mandate_timeout' }]);
      expect(saveLowBalanceConfigAction).not.toHaveBeenCalled();
      expect(props.onFunded).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: /Back/ })).toBeEnabled();
      // The in-flight flag clears in an effect after the "Check again" render, so wait for the
      // settled value rather than reading the mock's last call synchronously.
      await waitFor(() => expect(props.onInFlightChange).toHaveBeenLastCalledWith(false));
      expect(props.onBusyChange).toHaveBeenLastCalledWith(true);
    });

    it('Check again polls only: a new card is never captured twice, then the mode is saved and it books', async () => {
      const props = renderBlock(view(null));
      await choosePayAfter();
      await userEvent.click(screen.getByRole('button', { name: PAY_AFTER_COPY.ctaNew }));
      await userEvent.click(await screen.findByRole('button', { name: 'Check again' }));
      expect(props.onFunded).not.toHaveBeenCalled();

      vi.mocked(getWalletMandateStatusAction).mockResolvedValue({ status: 'active' });
      await userEvent.click(await screen.findByRole('button', { name: 'Check again' }));
      await waitFor(() =>
        expect(props.onFunded).toHaveBeenCalledWith({
          method: 'pay_after',
          card: null,
          companyName: 'Northwind',
        })
      );
      expect(startCardCaptureAction).toHaveBeenCalledTimes(1);
      expect(mockStripeApi.confirmSetup).toHaveBeenCalledTimes(1);
      expect(saveLowBalanceConfigAction).toHaveBeenCalledTimes(1);
    });

    it('on the saved-card path never re-arms, and books without a second save', async () => {
      const props = renderBlock(view(SAVED_CARD, { firstTime: false }));
      await choosePayAfter();
      await userEvent.click(screen.getByRole('button', { name: PAY_AFTER_COPY.ctaSaved }));
      vi.mocked(getWalletMandateStatusAction).mockResolvedValue({ status: 'active' });
      await userEvent.click(await screen.findByRole('button', { name: 'Check again' }));
      await waitFor(() =>
        expect(props.onFunded).toHaveBeenCalledWith(
          expect.objectContaining({ method: 'pay_after', card: SAVED_CARD })
        )
      );
      expect(armSavedCardMandateAction).toHaveBeenCalledTimes(1);
      expect(saveLowBalanceConfigAction).toHaveBeenCalledTimes(1);
    });
  });

  describe('saved-card failure copy', () => {
    it('says the setting is now Keep me going when the arm fails after the switch', async () => {
      vi.mocked(armSavedCardMandateAction).mockResolvedValue({ ok: false, error: 'failed' });
      renderBlock(view(SAVED_CARD, { firstTime: false }));
      await choosePayAfter();
      await userEvent.click(screen.getByRole('button', { name: PAY_AFTER_COPY.ctaSaved }));
      expect(await screen.findByRole('alert')).toHaveTextContent(
        PAY_AFTER_COPY.errors.setup_failed_saved
      );
      expect(payloads(BOOKING_EVENTS.FUNDING_FAILED)).toEqual([{ reason: 'setup_failed' }]);
    });

    it('uses the same line when the saved card mandate reports failed', async () => {
      vi.mocked(getWalletMandateStatusAction).mockResolvedValue({ status: 'failed' });
      renderBlock(view(SAVED_CARD, { firstTime: false }));
      await choosePayAfter();
      await userEvent.click(screen.getByRole('button', { name: PAY_AFTER_COPY.ctaSaved }));
      expect(await screen.findByRole('alert')).toHaveTextContent(
        PAY_AFTER_COPY.errors.setup_failed_saved
      );
    });

    it('keeps the generic line when the switch itself is refused', async () => {
      vi.mocked(saveLowBalanceConfigAction).mockResolvedValue({
        ok: false,
        error: 'no_saved_card',
      });
      renderBlock(view(SAVED_CARD, { firstTime: false }));
      await choosePayAfter();
      await userEvent.click(screen.getByRole('button', { name: PAY_AFTER_COPY.ctaSaved }));
      expect(await screen.findByRole('alert')).toHaveTextContent(
        PAY_AFTER_COPY.errors.setup_failed
      );
      expect(screen.getByRole('alert')).not.toHaveTextContent('Keep me going');
    });

    it('adds the note to the generic line when arming throws after the switch', async () => {
      vi.mocked(armSavedCardMandateAction).mockRejectedValue(new Error('boom'));
      renderBlock(view(SAVED_CARD, { firstTime: false }));
      await choosePayAfter();
      await userEvent.click(screen.getByRole('button', { name: PAY_AFTER_COPY.ctaSaved }));
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(PAY_AFTER_COPY.errors.error);
      expect(alert).toHaveTextContent(PAY_AFTER_COPY.switchedNote);
    });

    it('gives the plain mode_failed line when a new card follows a saved-card failure', async () => {
      vi.mocked(armSavedCardMandateAction).mockResolvedValue({
        ok: true,
        outcome: 'requires_action',
        clientSecret: 'seti_secret',
      });
      vi.mocked(resolveSetupIntentNextAction).mockResolvedValue(false);
      renderBlock(view(SAVED_CARD, { firstTime: false }));
      await choosePayAfter();
      await userEvent.click(screen.getByRole('button', { name: PAY_AFTER_COPY.ctaSaved }));
      await screen.findByRole('alert');
      await userEvent.click(screen.getByRole('button', { name: 'Change' }));
      vi.mocked(saveLowBalanceConfigAction).mockResolvedValue({
        ok: false,
        error: 'no_saved_card',
      });
      await userEvent.click(screen.getByRole('button', { name: PAY_AFTER_COPY.ctaNew }));
      await waitFor(() =>
        expect(screen.getByRole('alert')).toHaveTextContent(PAY_AFTER_COPY.errors.mode_failed)
      );
      expect(screen.getByRole('alert')).not.toHaveTextContent(PAY_AFTER_COPY.switchedNote);
    });

    it('adds the note to the unconfirmed panel after the switch', async () => {
      vi.mocked(getWalletMandateStatusAction).mockResolvedValue({ status: 'unauthorized' });
      renderBlock(view(SAVED_CARD, { firstTime: false }));
      await choosePayAfter();
      await userEvent.click(screen.getByRole('button', { name: PAY_AFTER_COPY.ctaSaved }));
      await screen.findByRole('button', { name: 'Check again' });
      expect(
        screen.getAllByText(`${PAY_AFTER_COPY.unconfirmed} ${PAY_AFTER_COPY.switchedNote}`).length
      ).toBeGreaterThan(0);
    });
  });

  it('on the reserved arm saves keep_going, sees the mandate active, then books', async () => {
    const props = renderBlock(
      view(SAVED_CARD, {
        arm: 'reserved',
        firstTime: false,
        topUpNeededMinor: 27_500,
        reservedBookingCount: 2,
      })
    );
    await choosePayAfter();
    await userEvent.click(screen.getByRole('button', { name: PAY_AFTER_COPY.ctaSaved }));
    await waitFor(() =>
      expect(props.onFunded).toHaveBeenCalledWith({
        method: 'pay_after',
        card: SAVED_CARD,
        companyName: 'Northwind',
      })
    );
    expect(saveLowBalanceConfigAction).toHaveBeenCalledWith(
      expect.objectContaining({ lowBalanceMode: 'keep_going' })
    );
    expect(getWalletMandateStatusAction).toHaveBeenCalled();
  });

  it('settlement_outstanding is reported to analytics under its own reason', async () => {
    vi.mocked(startCardCaptureAction).mockResolvedValue({
      ok: false,
      error: 'settlement_outstanding',
    });
    renderBlock(view(null));
    await choosePayAfter();
    await userEvent.click(screen.getByRole('button', { name: PAY_AFTER_COPY.ctaNew }));
    await screen.findByRole('alert');
    expect(payloads(BOOKING_EVENTS.FUNDING_FAILED)).toEqual([{ reason: 'settlement_outstanding' }]);
  });

  it('shows the pay-after header band, with no top-up figure, on setup and reserved', async () => {
    renderBlock(view(null));
    expect(screen.getByRole('heading', { name: 'One setup step first' })).toBeInTheDocument();
    await choosePayAfter();
    expect(screen.getByRole('heading', { name: 'Pay after the call' })).toBeInTheDocument();
    expect(screen.getByText(/Nothing is charged now\./)).toBeInTheDocument();
    expect(screen.queryByText(/Top up now and this one books/)).not.toBeInTheDocument();
  });

  it('the reserved arm band names no top-up figure either', async () => {
    renderBlock(
      view(SAVED_CARD, {
        arm: 'reserved',
        firstTime: false,
        topUpNeededMinor: 27_500,
        reservedBookingCount: 2,
      })
    );
    await choosePayAfter();
    expect(
      screen.getByRole('heading', { name: 'Pay after the call for this one' })
    ).toBeInTheDocument();
    expect(screen.queryByText(/A\$275/)).not.toBeInTheDocument();
  });

  it('abandons the press, calling nothing, when the dialog refuses', async () => {
    renderBlock(view(SAVED_CARD, { firstTime: false }), { onBeforePay: vi.fn(() => false) });
    await choosePayAfter();
    await userEvent.click(screen.getByRole('button', { name: PAY_AFTER_COPY.ctaSaved }));
    expect(saveLowBalanceConfigAction).not.toHaveBeenCalled();
  });

  it('reports a failed booking, returns to idle and keeps the CTA pressable', async () => {
    const props = renderBlock(view(SAVED_CARD, { firstTime: false }), {
      onFunded: vi.fn(async () => false),
    });
    await choosePayAfter();
    await userEvent.click(screen.getByRole('button', { name: PAY_AFTER_COPY.ctaSaved }));
    await waitFor(() => expect(props.onFunded).toHaveBeenCalled());
    expect(await screen.findByRole('button', { name: PAY_AFTER_COPY.ctaSaved })).toBeEnabled();
    expect(payloads(BOOKING_EVENTS.FUNDING_FAILED)).toEqual([{ reason: 'booking_failed' }]);
  });

  it('reports busy and in-flight while running, and clears both on unmount', async () => {
    vi.mocked(getWalletMandateStatusAction).mockResolvedValue({ status: 'pending' });
    const props = renderBlock(view(SAVED_CARD, { firstTime: false }));
    await choosePayAfter();
    await userEvent.click(screen.getByRole('button', { name: PAY_AFTER_COPY.ctaSaved }));
    await waitFor(() => expect(props.onInFlightChange).toHaveBeenLastCalledWith(true));
    expect(props.onBusyChange).toHaveBeenLastCalledWith(true);
    expect(screen.getByRole('button', { name: /Back/ })).toBeDisabled();
    props.unmount();
    expect(props.onBusyChange).toHaveBeenLastCalledWith(false);
    expect(props.onInFlightChange).toHaveBeenLastCalledWith(false);
  });
});

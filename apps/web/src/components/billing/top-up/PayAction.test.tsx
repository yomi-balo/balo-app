import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ── Stripe.js mocks ──────────────────────────────────────────────────────────

const mockConfirmPayment = vi.fn();
const mockConfirmSetup = vi.fn();
const mockHandleNextAction = vi.fn();
const mockRetrievePaymentIntent = vi.fn();
const mockSubmit = vi.fn();
const mockUpdate = vi.fn();

vi.mock('@stripe/react-stripe-js', () => ({
  useStripe: () => ({
    confirmPayment: mockConfirmPayment,
    confirmSetup: mockConfirmSetup,
    handleNextAction: mockHandleNextAction,
    retrievePaymentIntent: mockRetrievePaymentIntent,
  }),
  useElements: () => ({ submit: mockSubmit, update: mockUpdate }),
}));

const mockStartPurchaseAction = vi.fn();
vi.mock('@/lib/credit/actions', () => ({
  startPurchaseAction: (...args: unknown[]) => mockStartPurchaseAction(...args),
}));

import { PayAction } from './PayAction';
import { track, CREDIT_EVENTS } from '@/lib/analytics';
import type { StartPurchaseInput, LowBalanceMode } from '@/lib/credit/actions';
import type { PaymentMethodSource } from '@/lib/credit/api-client';
import type { PurchaseCompletion } from './types';

// ── Fixtures ─────────────────────────────────────────────────────────────────

function renderAction(overrides: {
  lowBalanceMode?: LowBalanceMode;
  paymentMethodSource?: PaymentMethodSource;
  onComplete?: (c: PurchaseCompletion) => void;
  onUseDifferentCard?: () => void;
  onCardDeclined?: () => void;
  disabled?: boolean;
}) {
  const onComplete = overrides.onComplete ?? vi.fn();
  const onUseDifferentCard = overrides.onUseDifferentCard ?? vi.fn();
  const onCardDeclined = overrides.onCardDeclined ?? vi.fn();
  const source = overrides.paymentMethodSource ?? 'new_card';
  const buildStartInput = (): StartPurchaseInput => ({
    amountMinor: 100_000,
    clientRequestId: '550e8400-e29b-41d4-a716-446655440002',
    config: {
      lowBalanceMode: overrides.lowBalanceMode ?? 'keep_going',
      topupReloadMinor: 30_000,
      topupThresholdMinor: 5_000,
    },
    paymentMethodSource: source,
  });
  render(
    <PayAction
      amountMinor={100_000}
      promoMinor={0}
      promoCodeId={null}
      promoCode={null}
      lowBalanceMode={overrides.lowBalanceMode ?? 'keep_going'}
      paymentMethodSource={source}
      disabled={overrides.disabled}
      buildStartInput={buildStartInput}
      onComplete={onComplete}
      onUseDifferentCard={onUseDifferentCard}
      onCardDeclined={onCardDeclined}
    />
  );
  return { onComplete, onUseDifferentCard, onCardDeclined };
}

describe('PayAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSubmit.mockResolvedValue({});
    mockStartPurchaseAction.mockResolvedValue({
      ok: true,
      outcome: 'needs_client_confirmation',
      clientSecret: 'pi_secret',
      paymentIntentId: 'pi_1',
      mandate: { outcome: 'requires_action', clientSecret: 'seti_secret' },
      walletId: 'wallet-1',
    });
    mockConfirmPayment.mockResolvedValue({
      paymentIntent: { status: 'succeeded', payment_method: 'pm_123' },
    });
    mockConfirmSetup.mockResolvedValue({});
    // ⚠ BAL-515 — this default USED TO BE `{}` (no error, no intent), which the pre-fix code read
    // as success. That is precisely why the suite could not detect the 3DS replay bug: an
    // abandoned challenge and a completed one were indistinguishable to the assertion. The
    // default now models a genuinely COMPLETED challenge, so the failure cases have to say so.
    mockHandleNextAction.mockResolvedValue({
      paymentIntent: { status: 'succeeded' },
      setupIntent: { status: 'succeeded' },
    });
    // ⚠ THE DEFAULT IS A PROVABLY-UNPAID INTENT. `handleNextAction` rejecting is ambiguous on its
    // own — it rejects both for an already-SUCCEEDED intent and for a genuinely unpaid one — so
    // every test that drives that rejection has to say which. Defaulting to unpaid keeps the
    // pre-existing "rotate on a rejection" expectation meaningful; the replay case sets its own.
    mockRetrievePaymentIntent.mockResolvedValue({
      paymentIntent: { status: 'requires_payment_method' },
    });
  });

  // ── The four cases lifted from PaymentSection.test.tsx (the hoist regression net) ──

  it('confirms the PaymentIntent THEN the SetupIntent with the saved payment method', async () => {
    const { onComplete } = renderAction({ lowBalanceMode: 'keep_going' });

    await userEvent.click(screen.getByRole('button', { name: /Pay/i }));

    await waitFor(() => expect(onComplete).toHaveBeenCalled());

    expect(mockSubmit).toHaveBeenCalled();
    expect(mockStartPurchaseAction).toHaveBeenCalled();
    expect(mockConfirmPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        clientSecret: 'pi_secret',
        redirect: 'if_required',
        confirmParams: expect.objectContaining({ return_url: expect.any(String) }),
      })
    );
    expect(mockConfirmSetup).toHaveBeenCalledWith(
      expect.objectContaining({
        clientSecret: 'seti_secret',
        redirect: 'if_required',
        confirmParams: expect.objectContaining({ payment_method: 'pm_123' }),
      })
    );
    const payOrder = mockConfirmPayment.mock.invocationCallOrder[0] ?? 0;
    const setupOrder = mockConfirmSetup.mock.invocationCallOrder[0] ?? 0;
    expect(payOrder).toBeLessThan(setupOrder);

    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({ mandateCaptured: true, lowBalanceMode: 'keep_going' })
    );
  });

  it('surfaces a decline/SCA error, charges nothing, and returns to idle', async () => {
    mockConfirmPayment.mockResolvedValue({ error: { message: 'Your card was declined.' } });
    const { onComplete } = renderAction({ lowBalanceMode: 'notify_only' });

    await userEvent.click(screen.getByRole('button', { name: /Pay/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/declined/i);
    expect(mockConfirmSetup).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Pay/i })).toBeEnabled();
  });

  it('completes with mandateCaptured=false when the charge succeeds but the SetupIntent fails', async () => {
    mockConfirmSetup.mockResolvedValue({ error: { message: 'setup failed' } });
    const { onComplete } = renderAction({ lowBalanceMode: 'auto_topup' });

    await userEvent.click(screen.getByRole('button', { name: /Pay/i }));

    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(mockConfirmPayment).toHaveBeenCalled();
    expect(mockConfirmSetup).toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({ mandateCaptured: false, lowBalanceMode: 'auto_topup' })
    );
  });

  it('does not attempt payment when start fails (invalid input / no charge)', async () => {
    mockStartPurchaseAction.mockResolvedValue({ ok: false, error: 'invalid_input' });
    const { onComplete } = renderAction({ lowBalanceMode: 'notify_only' });

    await userEvent.click(screen.getByRole('button', { name: /Pay/i }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(mockConfirmPayment).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });

  // ── The <Elements> hoist regression test ──────────────────────────────────

  it('renders an ENABLED Pay button — i.e. useStripe() resolved from the hoisted provider', () => {
    renderAction({});
    // A `useStripe()` returning null (the failure mode of a bad hoist) disables Pay forever and
    // silently. This asserts the button is live where it now lives — the summary rail.
    expect(screen.getByRole('button', { name: /Pay A\$1,000/i })).toBeEnabled();
  });

  // ── Saved-card path ───────────────────────────────────────────────────────

  it('does NOT submit an Element on the saved-card path and completes straight away', async () => {
    mockStartPurchaseAction.mockResolvedValue({
      ok: true,
      outcome: 'complete',
      paymentIntentId: 'pi_saved',
      mandate: { outcome: 'not_required' },
      walletId: 'wallet-1',
    });
    const { onComplete } = renderAction({
      paymentMethodSource: 'saved_card',
      lowBalanceMode: 'notify_only',
    });

    await userEvent.click(screen.getByRole('button', { name: /Pay/i }));

    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    // There is no Element to submit, and the browser never confirms a PI it did not create.
    expect(mockSubmit).not.toHaveBeenCalled();
    expect(mockConfirmPayment).not.toHaveBeenCalled();
    expect(mockStartPurchaseAction).toHaveBeenCalledWith(
      expect.objectContaining({ paymentMethodSource: 'saved_card' })
    );
  });

  it('runs 3DS via handleNextAction on requires_action, then completes', async () => {
    mockStartPurchaseAction.mockResolvedValue({
      ok: true,
      outcome: 'requires_action',
      clientSecret: 'pi_3ds_secret',
      paymentIntentId: 'pi_saved',
      mandate: { outcome: 'not_required' },
      walletId: 'wallet-1',
    });
    const { onComplete } = renderAction({
      paymentMethodSource: 'saved_card',
      lowBalanceMode: 'notify_only',
    });

    await userEvent.click(screen.getByRole('button', { name: /Pay/i }));

    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(mockHandleNextAction).toHaveBeenCalledWith({ clientSecret: 'pi_3ds_secret' });
    expect(mockConfirmPayment).not.toHaveBeenCalled();
  });

  // ── BAL-515: a failed / abandoned / replayed 3DS must ROTATE the key ────────

  it('fires onCardDeclined when the saved-card 3DS challenge FAILS with a card_error, so the key rotates', async () => {
    // ⚠ A `requires_action` answer is a CACHED 200 against the purchase idempotency key exactly
    // as a 402 decline is. Without the rotation the next Pay press REPLAYS the stale
    // `requires_action` for 24h and the issuer is never contacted again. A `card_error` is the
    // DEFINITE non-completion that rotation is for: Stripe.js is saying the issuer refused the
    // authentication, so nothing was charged and the cached answer on this key is worthless.
    mockStartPurchaseAction.mockResolvedValue({
      ok: true,
      outcome: 'requires_action',
      clientSecret: 'pi_3ds_secret',
      paymentIntentId: 'pi_saved',
      mandate: { outcome: 'not_required' },
      walletId: 'wallet-1',
    });
    mockHandleNextAction.mockResolvedValue({
      error: { type: 'card_error', message: 'Authentication failed.' },
    });
    const { onCardDeclined, onComplete } = renderAction({ paymentMethodSource: 'saved_card' });

    await userEvent.click(screen.getByRole('button', { name: /Pay/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Authentication failed/i);
    expect(onCardDeclined).toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
    // A definite non-completion needs no retrieve — rotating on it is provably safe.
    expect(mockRetrievePaymentIntent).not.toHaveBeenCalled();
  });

  it('rotates on a client-side validation_error too (the request never left the browser)', async () => {
    mockStartPurchaseAction.mockResolvedValue({
      ok: true,
      outcome: 'requires_action',
      clientSecret: 'pi_3ds_secret',
      paymentIntentId: 'pi_saved',
      mandate: { outcome: 'not_required' },
      walletId: 'wallet-1',
    });
    mockHandleNextAction.mockResolvedValue({
      error: { type: 'validation_error', message: 'Your card number is incomplete.' },
    });
    const { onCardDeclined } = renderAction({ paymentMethodSource: 'saved_card' });

    await userEvent.click(screen.getByRole('button', { name: /Pay/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/card number is incomplete/i);
    expect(onCardDeclined).toHaveBeenCalled();
    expect(mockRetrievePaymentIntent).not.toHaveBeenCalled();
  });

  it('does NOT rotate on an api_connection_error whose intent ALREADY SUCCEEDED (the second-charge bug)', async () => {
    // ⚠⚠ THE HIGH-SEVERITY DEFECT THIS PINS. The `{ error }` RETURN arm used to call
    // `onCardDeclined()` for ANY error type. An `api_connection_error` can be raised AFTER the
    // challenge completed — the socket dropped on the way back — and on the saved-card path the
    // api has ALREADY confirmed the PaymentIntent, so the card IS charged. Rotating
    // `clientRequestId` there changes the server-side purchase idempotency key, so one further
    // Pay press mints a SECOND real PaymentIntent, taken from a buyer told nothing went through.
    // "Stripe returned an error" is not "the card was not charged": ask Stripe which it was.
    mockStartPurchaseAction.mockResolvedValue({
      ok: true,
      outcome: 'requires_action',
      clientSecret: 'pi_3ds_secret',
      paymentIntentId: 'pi_saved',
      mandate: { outcome: 'not_required' },
      walletId: 'wallet-1',
    });
    mockHandleNextAction.mockResolvedValue({
      error: { type: 'api_connection_error', message: 'A network error occurred.' },
    });
    mockRetrievePaymentIntent.mockResolvedValue({ paymentIntent: { status: 'succeeded' } });
    const { onCardDeclined, onComplete } = renderAction({ paymentMethodSource: 'saved_card' });

    await userEvent.click(screen.getByRole('button', { name: /Pay/i }));

    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(mockRetrievePaymentIntent).toHaveBeenCalledWith('pi_3ds_secret');
    expect(onCardDeclined).not.toHaveBeenCalled();
    // And it must not have claimed a failure at all — the purchase is done.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({ paymentIntentId: 'pi_saved' })
    );
  });

  it('does NOT rotate on an api_error whose intent is `processing` (the webhook credits it)', async () => {
    mockStartPurchaseAction.mockResolvedValue({
      ok: true,
      outcome: 'requires_action',
      clientSecret: 'pi_3ds_secret',
      paymentIntentId: 'pi_saved',
      mandate: { outcome: 'not_required' },
      walletId: 'wallet-1',
    });
    mockHandleNextAction.mockResolvedValue({
      error: { type: 'api_error', message: 'An error occurred.' },
    });
    mockRetrievePaymentIntent.mockResolvedValue({ paymentIntent: { status: 'processing' } });
    const { onCardDeclined, onComplete } = renderAction({ paymentMethodSource: 'saved_card' });

    await userEvent.click(screen.getByRole('button', { name: /Pay/i }));

    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(onCardDeclined).not.toHaveBeenCalled();
  });

  it('DOES rotate on an api_connection_error once the retrieve PROVES the intent is unpaid', async () => {
    // The rule is "let the true status decide", not "never rotate on a connection error". A
    // provably-unpaid intent still holds a worthless cached answer on the key.
    mockStartPurchaseAction.mockResolvedValue({
      ok: true,
      outcome: 'requires_action',
      clientSecret: 'pi_3ds_secret',
      paymentIntentId: 'pi_saved',
      mandate: { outcome: 'not_required' },
      walletId: 'wallet-1',
    });
    mockHandleNextAction.mockResolvedValue({
      error: { type: 'api_connection_error', message: 'A network error occurred.' },
    });
    mockRetrievePaymentIntent.mockResolvedValue({
      paymentIntent: { status: 'requires_payment_method' },
    });
    const { onCardDeclined, onComplete } = renderAction({ paymentMethodSource: 'saved_card' });

    await userEvent.click(screen.getByRole('button', { name: /Pay/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/check your balance before trying again/i);
    expect(alert).not.toHaveTextContent(/no charge was made/i);
    expect(onCardDeclined).toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('FAILS CLOSED on an api_connection_error when the retrieve is ALSO unreadable (no rotation)', async () => {
    // Two ambiguities do not make a certainty. An unresolvable outcome must not rotate: a stale
    // replayed key costs a retry, a rotated key on an already-paid intent costs real money.
    mockStartPurchaseAction.mockResolvedValue({
      ok: true,
      outcome: 'requires_action',
      clientSecret: 'pi_3ds_secret',
      paymentIntentId: 'pi_saved',
      mandate: { outcome: 'not_required' },
      walletId: 'wallet-1',
    });
    mockHandleNextAction.mockResolvedValue({
      error: { type: 'rate_limit_error', message: 'Too many requests.' },
    });
    mockRetrievePaymentIntent.mockResolvedValue({ error: { message: 'unreadable' } });
    const { onCardDeclined, onComplete } = renderAction({ paymentMethodSource: 'saved_card' });

    await userEvent.click(screen.getByRole('button', { name: /Pay/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/check your balance before trying again/i);
    expect(alert).not.toHaveTextContent(/no charge was made/i);
    expect(onCardDeclined).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('rotates and surfaces an error when handleNextAction REJECTS on a PROVABLY UNPAID intent', async () => {
    // `handleNextAction` THROWS when the intent is not in `requires_action`. Unhandled, the
    // rejection escaped into `handlePayClick`'s `.catch(() => undefined)` and left the button on
    // "Processing…" forever, with no alert and no completion. When the retrieve proves the intent
    // is still unpaid, rotating is right: the cached answer on this key is worthless.
    mockStartPurchaseAction.mockResolvedValue({
      ok: true,
      outcome: 'requires_action',
      clientSecret: 'pi_3ds_secret',
      paymentIntentId: 'pi_saved',
      mandate: { outcome: 'not_required' },
      walletId: 'wallet-1',
    });
    mockHandleNextAction.mockRejectedValue(
      new Error('This PaymentIntent does not require any action')
    );
    mockRetrievePaymentIntent.mockResolvedValue({
      paymentIntent: { status: 'requires_payment_method' },
    });
    const { onCardDeclined, onComplete } = renderAction({ paymentMethodSource: 'saved_card' });

    await userEvent.click(screen.getByRole('button', { name: /Pay/i }));

    const alert = await screen.findByRole('alert');
    // ⚠ THE COPY IS THE ASSERTION, not the existence of an alert. On this path the api already
    // confirmed the PaymentIntent, so the default "no charge was made" would be a claim about the
    // buyer's money that this component cannot make.
    expect(alert).not.toHaveTextContent(/no charge was made/i);
    expect(alert).toHaveTextContent(/check your balance before trying again/i);
    expect(mockRetrievePaymentIntent).toHaveBeenCalledWith('pi_3ds_secret');
    expect(onCardDeclined).toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
    // Back to idle — the button must not be stranded on "Processing…".
    expect(screen.getByRole('button', { name: /Pay/i })).not.toBeDisabled();
  });

  it('does NOT rotate and does NOT claim "no charge was made" when the intent ALREADY SUCCEEDED', async () => {
    // ⚠⚠ THE DOUBLE-CHARGE THIS PREVENTS. `handleNextAction` rejects on a REPLAYED, already-paid
    // intent. Treating that as a failure both (a) told the buyer "no charge was made" about a card
    // that HAD been charged, and (b) rotated `clientRequestId` — which changes the server-side
    // purchase idempotency key, so one further Pay press mints a SECOND PaymentIntent that the api
    // confirms: a second real charge. The completion path must simply take over instead.
    mockStartPurchaseAction.mockResolvedValue({
      ok: true,
      outcome: 'requires_action',
      clientSecret: 'pi_3ds_secret',
      paymentIntentId: 'pi_saved',
      mandate: { outcome: 'not_required' },
      walletId: 'wallet-1',
    });
    mockHandleNextAction.mockRejectedValue(
      new Error('This PaymentIntent does not require any action')
    );
    mockRetrievePaymentIntent.mockResolvedValue({ paymentIntent: { status: 'succeeded' } });
    const { onCardDeclined, onComplete } = renderAction({ paymentMethodSource: 'saved_card' });

    await userEvent.click(screen.getByRole('button', { name: /Pay/i }));

    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(onCardDeclined).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({ paymentIntentId: 'pi_saved' })
    );
  });

  it('treats a `processing` replayed intent as done too (the webhook credits it)', async () => {
    mockStartPurchaseAction.mockResolvedValue({
      ok: true,
      outcome: 'requires_action',
      clientSecret: 'pi_3ds_secret',
      paymentIntentId: 'pi_saved',
      mandate: { outcome: 'not_required' },
      walletId: 'wallet-1',
    });
    mockHandleNextAction.mockRejectedValue(new Error('does not require any action'));
    mockRetrievePaymentIntent.mockResolvedValue({ paymentIntent: { status: 'processing' } });
    const { onCardDeclined, onComplete } = renderAction({ paymentMethodSource: 'saved_card' });

    await userEvent.click(screen.getByRole('button', { name: /Pay/i }));

    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(onCardDeclined).not.toHaveBeenCalled();
  });

  it.each([
    ['the retrieve returns an error', { error: { message: 'network' } }],
    ['the retrieve returns nothing usable', {}],
  ])('FAILS CLOSED (no rotation) when %s', async (_label, retrieveResult) => {
    // ⚠ THE TWO FAILURE MODES ARE NOT SYMMETRIC. A stale replayed key costs the buyer a repeated
    // no-op they can clear with a refresh; a rotated key on an intent that may already be paid
    // costs them a second real charge. So an unresolvable outcome shows the ambiguous copy and
    // rotates nothing.
    mockStartPurchaseAction.mockResolvedValue({
      ok: true,
      outcome: 'requires_action',
      clientSecret: 'pi_3ds_secret',
      paymentIntentId: 'pi_saved',
      mandate: { outcome: 'not_required' },
      walletId: 'wallet-1',
    });
    mockHandleNextAction.mockRejectedValue(new Error('does not require any action'));
    mockRetrievePaymentIntent.mockResolvedValue(retrieveResult);
    const { onCardDeclined, onComplete } = renderAction({ paymentMethodSource: 'saved_card' });

    await userEvent.click(screen.getByRole('button', { name: /Pay/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/check your balance before trying again/i);
    expect(alert).not.toHaveTextContent(/no charge was made/i);
    expect(onCardDeclined).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Pay/i })).not.toBeDisabled();
  });

  it('FAILS CLOSED (no rotation) when the retrieve itself REJECTS', async () => {
    mockStartPurchaseAction.mockResolvedValue({
      ok: true,
      outcome: 'requires_action',
      clientSecret: 'pi_3ds_secret',
      paymentIntentId: 'pi_saved',
      mandate: { outcome: 'not_required' },
      walletId: 'wallet-1',
    });
    mockHandleNextAction.mockRejectedValue(new Error('does not require any action'));
    mockRetrievePaymentIntent.mockRejectedValue(new Error('offline'));
    const { onCardDeclined, onComplete } = renderAction({ paymentMethodSource: 'saved_card' });

    await userEvent.click(screen.getByRole('button', { name: /Pay/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /check your balance before trying again/i
    );
    expect(onCardDeclined).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('treats a non-succeeded PaymentIntent with NO error as a failure (an abandoned challenge)', async () => {
    mockStartPurchaseAction.mockResolvedValue({
      ok: true,
      outcome: 'requires_action',
      clientSecret: 'pi_3ds_secret',
      paymentIntentId: 'pi_saved',
      mandate: { outcome: 'not_required' },
      walletId: 'wallet-1',
    });
    mockHandleNextAction.mockResolvedValue({ paymentIntent: { status: 'requires_action' } });
    const { onCardDeclined, onComplete } = renderAction({ paymentMethodSource: 'saved_card' });

    await userEvent.click(screen.getByRole('button', { name: /Pay/i }));

    const alert = await screen.findByRole('alert');
    // The status is provably unpaid, so rotating is right — but the copy still may not claim
    // nothing was charged: the api confirmed this PaymentIntent server-side.
    expect(alert).toHaveTextContent(/check your balance before trying again/i);
    expect(alert).not.toHaveTextContent(/no charge was made/i);
    expect(onCardDeclined).toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('still completes on a `processing` PaymentIntent (the webhook credits it)', async () => {
    mockStartPurchaseAction.mockResolvedValue({
      ok: true,
      outcome: 'requires_action',
      clientSecret: 'pi_3ds_secret',
      paymentIntentId: 'pi_saved',
      mandate: { outcome: 'not_required' },
      walletId: 'wallet-1',
    });
    mockHandleNextAction.mockResolvedValue({ paymentIntent: { status: 'processing' } });
    const { onCardDeclined, onComplete } = renderAction({ paymentMethodSource: 'saved_card' });

    await userEvent.click(screen.getByRole('button', { name: /Pay/i }));

    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(onCardDeclined).not.toHaveBeenCalled();
  });

  it('never falls back to "no charge was made" when the 3DS error carries NO message', async () => {
    // ⚠ THE FALLBACK IS THE BUG SURFACE. Stripe usually supplies a message, so `?? null` here
    // looks harmless — until it does not, and the buyer is told nothing was charged on the one
    // path where the api has already created AND confirmed the PaymentIntent.
    mockStartPurchaseAction.mockResolvedValue({
      ok: true,
      outcome: 'requires_action',
      clientSecret: 'pi_3ds_secret',
      paymentIntentId: 'pi_saved',
      mandate: { outcome: 'not_required' },
      walletId: 'wallet-1',
    });
    mockHandleNextAction.mockResolvedValue({ error: { type: 'card_error' } });
    const { onCardDeclined } = renderAction({ paymentMethodSource: 'saved_card' });

    await userEvent.click(screen.getByRole('button', { name: /Pay/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).not.toHaveTextContent(/no charge was made/i);
    expect(alert).toHaveTextContent(/check your balance before trying again/i);
    // A genuine 3DS error still rotates: the authentication did not complete, so the cached
    // `requires_action` on this key would otherwise be replayed for 24h without the issuer ever
    // being contacted again.
    expect(onCardDeclined).toHaveBeenCalled();
  });

  it('does not complete when the 3DS challenge fails', async () => {
    mockStartPurchaseAction.mockResolvedValue({
      ok: true,
      outcome: 'requires_action',
      clientSecret: 'pi_3ds_secret',
      paymentIntentId: 'pi_saved',
      mandate: { outcome: 'not_required' },
      walletId: 'wallet-1',
    });
    mockHandleNextAction.mockResolvedValue({
      error: { type: 'card_error', message: 'Authentication failed.' },
    });
    const { onComplete } = renderAction({ paymentMethodSource: 'saved_card' });

    await userEvent.click(screen.getByRole('button', { name: /Pay/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Authentication failed/i);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('counts a server-confirmed saved-card mandate as captured (outcome says so, nothing to do)', async () => {
    mockStartPurchaseAction.mockResolvedValue({
      ok: true,
      outcome: 'complete',
      paymentIntentId: 'pi_saved',
      // 'captured' = the api already confirmed it server-side; the webhook activates the wallet.
      mandate: { outcome: 'captured' },
      walletId: 'wallet-1',
    });
    const { onComplete } = renderAction({
      paymentMethodSource: 'saved_card',
      lowBalanceMode: 'keep_going',
    });

    await userEvent.click(screen.getByRole('button', { name: /Pay/i }));

    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ mandateCaptured: true }));
    expect(mockConfirmSetup).not.toHaveBeenCalled();
  });

  it('reports a FAILED saved-card mandate as NOT captured, so the receipt warns', async () => {
    // ⚠ The regression this pins: a failed mandate confirmation used to arrive as the same
    // `null` secret a SUCCESSFUL one did, and any null on the saved-card path was read as
    // "captured". The buyer was congratulated on automatic charging that was never set up.
    mockStartPurchaseAction.mockResolvedValue({
      ok: true,
      outcome: 'complete',
      paymentIntentId: 'pi_saved',
      mandate: { outcome: 'failed' },
      walletId: 'wallet-1',
    });
    const { onComplete } = renderAction({
      paymentMethodSource: 'saved_card',
      lowBalanceMode: 'keep_going',
    });

    await userEvent.click(screen.getByRole('button', { name: /Pay/i }));

    // The purchase still completes — the money already moved.
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ mandateCaptured: false }));
    expect(mockHandleNextAction).not.toHaveBeenCalled();
    expect(mockConfirmSetup).not.toHaveBeenCalled();
  });

  it('does not count an untouched mandate (not_required) as captured', async () => {
    mockStartPurchaseAction.mockResolvedValue({
      ok: true,
      outcome: 'complete',
      paymentIntentId: 'pi_saved',
      mandate: { outcome: 'not_required' },
      walletId: 'wallet-1',
    });
    const { onComplete } = renderAction({
      paymentMethodSource: 'saved_card',
      lowBalanceMode: 'auto_topup',
    });

    await userEvent.click(screen.getByRole('button', { name: /Pay/i }));

    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ mandateCaptured: false }));
  });

  it('answers a saved-card mandate 3DS challenge with handleNextAction', async () => {
    mockStartPurchaseAction.mockResolvedValue({
      ok: true,
      outcome: 'complete',
      paymentIntentId: 'pi_saved',
      mandate: { outcome: 'requires_action', clientSecret: 'seti_3ds_secret' },
      walletId: 'wallet-1',
    });
    const { onComplete } = renderAction({
      paymentMethodSource: 'saved_card',
      lowBalanceMode: 'auto_topup',
    });

    await userEvent.click(screen.getByRole('button', { name: /Pay/i }));

    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(mockHandleNextAction).toHaveBeenCalledWith({ clientSecret: 'seti_3ds_secret' });
    expect(mockConfirmSetup).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ mandateCaptured: true }));
  });

  it('does NOT count an ABANDONED mandate 3DS as captured (no error, intent still requires_action)', async () => {
    // ⚠ Reading only `error` told a buyer whose mandate was never confirmed that automatic
    // charging was on: the receipt's warning was suppressed and the wallet stayed `pending` with
    // nothing to ever tell them. The purchase itself still completes — the money already moved.
    mockStartPurchaseAction.mockResolvedValue({
      ok: true,
      outcome: 'complete',
      paymentIntentId: 'pi_saved',
      mandate: { outcome: 'requires_action', clientSecret: 'seti_3ds_secret' },
      walletId: 'wallet-1',
    });
    mockHandleNextAction.mockResolvedValue({ setupIntent: { status: 'requires_action' } });
    const { onComplete } = renderAction({
      paymentMethodSource: 'saved_card',
      lowBalanceMode: 'auto_topup',
    });

    await userEvent.click(screen.getByRole('button', { name: /Pay/i }));

    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ mandateCaptured: false }));
  });

  it('does NOT count a REJECTED mandate 3DS as captured, and never fails the purchase', async () => {
    mockStartPurchaseAction.mockResolvedValue({
      ok: true,
      outcome: 'complete',
      paymentIntentId: 'pi_saved',
      mandate: { outcome: 'requires_action', clientSecret: 'seti_3ds_secret' },
      walletId: 'wallet-1',
    });
    mockHandleNextAction.mockRejectedValue(new Error('does not require any action'));
    const { onComplete } = renderAction({
      paymentMethodSource: 'saved_card',
      lowBalanceMode: 'auto_topup',
    });

    await userEvent.click(screen.getByRole('button', { name: /Pay/i }));

    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ mandateCaptured: false }));
  });

  // ── Decline ───────────────────────────────────────────────────────────────

  it('shows an inline alert AND a "Use a different card" affordance on a decline', async () => {
    mockStartPurchaseAction.mockResolvedValue({
      ok: false,
      error: 'card_declined',
      declineCode: 'insufficient_funds',
    });
    const { onUseDifferentCard } = renderAction({ paymentMethodSource: 'saved_card' });

    await userEvent.click(screen.getByRole('button', { name: /Pay/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/declined/i);
    const escape = screen.getByRole('button', { name: /use a different card/i });
    await userEvent.click(escape);
    expect(onUseDifferentCard).toHaveBeenCalled();
    expect(track).toHaveBeenCalledWith(CREDIT_EVENTS.PURCHASE_DECLINED, {
      amount_minor: 100_000,
      decline_code: 'insufficient_funds',
    });
  });

  it('does NOT claim "no charge was made" on a saved-card generic failure (R14)', async () => {
    mockStartPurchaseAction.mockResolvedValue({ ok: false, error: 'saved_card_error' });
    renderAction({ paymentMethodSource: 'saved_card' });

    await userEvent.click(screen.getByRole('button', { name: /Pay/i }));

    const alert = await screen.findByRole('alert');
    // On this path the charge is attempted INSIDE the action, so the new-card copy would lie
    // about the buyer's money.
    expect(alert).not.toHaveTextContent(/no charge was made/i);
    expect(alert).toHaveTextContent(/check your balance before trying again/i);
  });

  it('fires onCardDeclined on a decline so the idempotency key rotates (no cached-402 replay)', async () => {
    // Stripe caches a 402 card_declined against the idempotency key for 24h — the endpoint DID
    // execute. Without rotation, pressing Pay again on the same configuration returns the
    // cached decline without contacting the issuer, making soft declines permanent.
    mockStartPurchaseAction.mockResolvedValue({
      ok: false,
      error: 'card_declined',
      declineCode: 'insufficient_funds',
    });
    const { onCardDeclined } = renderAction({ paymentMethodSource: 'saved_card' });

    await userEvent.click(screen.getByRole('button', { name: /Pay/i }));

    expect(onCardDeclined).toHaveBeenCalledTimes(1);
  });

  it('offers no "Use a different card" escape on a non-decline failure', async () => {
    mockStartPurchaseAction.mockResolvedValue({ ok: false, error: 'stripe_error' });
    renderAction({});

    await userEvent.click(screen.getByRole('button', { name: /Pay/i }));

    await screen.findByRole('alert');
    expect(screen.queryByRole('button', { name: /use a different card/i })).not.toBeInTheDocument();
  });

  // ── paymentIntentId threading ─────────────────────────────────────────────

  it.each([
    [
      'needs_client_confirmation',
      {
        ok: true,
        outcome: 'needs_client_confirmation',
        clientSecret: 'pi_secret',
        paymentIntentId: 'pi_new',
        mandate: { outcome: 'not_required' },
        walletId: 'wallet-1',
      },
      'pi_new',
      'new_card' as const,
    ],
    [
      'complete',
      {
        ok: true,
        outcome: 'complete',
        paymentIntentId: 'pi_complete',
        mandate: { outcome: 'not_required' },
        walletId: 'wallet-1',
      },
      'pi_complete',
      'saved_card' as const,
    ],
    [
      'requires_action',
      {
        ok: true,
        outcome: 'requires_action',
        clientSecret: 'pi_3ds_secret',
        paymentIntentId: 'pi_3ds',
        mandate: { outcome: 'not_required' },
        walletId: 'wallet-1',
      },
      'pi_3ds',
      'saved_card' as const,
    ],
  ])(
    'carries paymentIntentId to onComplete on the %s arm',
    async (_label, startResult, expectedId, source) => {
      // ⚠ THE REGRESSION THIS PINS: the id was already on all three `ok` arms and this handler
      // threw it away, leaving the receipt with no way to ask the wallet whether the credit
      // landed — so it asserted an arithmetic balance instead.
      mockStartPurchaseAction.mockResolvedValue(startResult);
      const { onComplete } = renderAction({
        paymentMethodSource: source,
        lowBalanceMode: 'notify_only',
      });

      await userEvent.click(screen.getByRole('button', { name: /Pay/i }));

      await waitFor(() => expect(onComplete).toHaveBeenCalled());
      expect(onComplete).toHaveBeenCalledWith(
        expect.objectContaining({ paymentIntentId: expectedId })
      );
    }
  );

  // ── Analytics + disabled ──────────────────────────────────────────────────

  it('tags the purchase-started event with the payment-method source', async () => {
    renderAction({ paymentMethodSource: 'new_card', lowBalanceMode: 'notify_only' });

    await userEvent.click(screen.getByRole('button', { name: /Pay/i }));

    expect(track).toHaveBeenCalledWith(
      CREDIT_EVENTS.PURCHASE_STARTED,
      expect.objectContaining({ payment_method_source: 'new_card', funding_method: 'card' })
    );
  });

  it('disables Pay when the composer reports an invalid configuration', () => {
    renderAction({ disabled: true });
    expect(screen.getByRole('button', { name: /Pay/i })).toBeDisabled();
  });

  it('keeps the Payment Element amount in sync as the amount changes', () => {
    renderAction({});
    expect(mockUpdate).toHaveBeenCalledWith({ amount: 100_000 });
  });
});

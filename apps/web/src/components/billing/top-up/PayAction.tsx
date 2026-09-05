'use client';

import { useCallback, useEffect, useState } from 'react';
import { useElements, useStripe } from '@stripe/react-stripe-js';
import { ArrowRight, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { track, CREDIT_EVENTS } from '@/lib/analytics';
import {
  startPurchaseAction,
  type StartPurchaseInput,
  type StartPurchaseResult,
  type MandateOutcome,
} from '@/lib/credit/actions';
import { formatAud } from '@/lib/credit/display-constants';
import type { PaymentMethodSource } from '@/lib/credit/api-client';
import type { PurchaseCompletion } from './types';

interface PayActionProps {
  readonly amountMinor: number;
  readonly promoMinor: number;
  readonly promoCode: string | null;
  readonly promoCodeId: string | null;
  readonly lowBalanceMode: StartPurchaseInput['config']['lowBalanceMode'];
  readonly paymentMethodSource: PaymentMethodSource;
  /**
   * Block Pay when the composer's configuration is invalid (e.g. an out-of-range auto-top-up
   * "Add"/"When below"). The offending field shows its own inline message in the mode picker,
   * so Pay is simply disabled here rather than surfacing a mis-attributed "amount" error.
   */
  readonly disabled?: boolean;
  /** Compact styling for the mobile pay bar (auto width, tighter padding). */
  readonly compact?: boolean;
  readonly buildStartInput: () => StartPurchaseInput;
  readonly onComplete: (completion: PurchaseCompletion) => void;
  /** Offer "Use a different card" after a decline — flips the composer to the new-card path. */
  readonly onUseDifferentCard: () => void;
  /**
   * Fired on `card_declined` so the OWNER of `clientRequestId` can rotate it. Without the
   * rotation, retrying the same configuration replays Stripe's CACHED 402 against the same
   * idempotency key for 24h — the issuer is never contacted again, so `insufficient_funds`
   * or a soft fraud decline becomes permanent for that amount/card until the buyer happens
   * to change something. The composer owns the key, so the composer does the rotating.
   */
  readonly onCardDeclined: () => void;
}

/** The two halves of the Server Action's result, named so the charge helpers can take one. */
type StartSuccess = Extract<StartPurchaseResult, { ok: true }>;
type StartFailure = Extract<StartPurchaseResult, { ok: false }>;

/**
 * ⚠ THE ONLY COPY THE SAVED-CARD PATH MAY SHOW ON AN AMBIGUOUS OUTCOME — and a named constant
 * rather than a bare record entry because every arm in `confirmSavedCard` has to reach it WITHOUT
 * a `START_ERROR_COPY[...]` lookup, which is `string | undefined` under `noUncheckedIndexedAccess`
 * and whose `?? null` fallback renders the "no charge was made" default.
 *
 * On this path the api creates AND CONFIRMS the PaymentIntent (`confirm: true`), so by the time
 * the browser sees anything the card may already have been charged. "No charge was made" is then
 * a lie about the buyer's money — and it is the lie that invites the second Pay press.
 */
const SAVED_CARD_ERROR_COPY =
  'Something went wrong finishing your top-up — check your balance before trying again.';

/**
 * The ONLY Stripe.js error types that PROVE the 3DS step did not complete — the client-side twin
 * of `isCardDeclineError` in `apps/api/src/services/credit/auto-topup.ts`, held to the same rule
 * that docblock states: "The ONLY thrown error that is a definite non-completion … Every OTHER
 * thrown error (connection / api / rate_limit / idempotency-in-progress / invalid_request) is
 * INDETERMINATE: the PI may still have succeeded."
 *
 * ⚠⚠ WHY THE DISTINCTION IS REAL MONEY HERE. Any error at all used to call `onCardDeclined()`,
 * which rotates `clientRequestId` and therefore the server-side purchase idempotency key
 * (`purchase:{walletId}:{source}:{clientRequestId}`). On the saved-card path the api CONFIRMS the
 * PaymentIntent, so an `api_connection_error` raised AFTER the challenge actually completed — the
 * socket dropped on the way back, the charge landed — rotated the key against a card that HAD
 * been charged, arming the next Pay press to mint a SECOND real PaymentIntent while the buyer was
 * being told the payment had not gone through.
 *
 * `card_error` is the genuine issuer refusal the rotation exists for (an unrotated key replays the
 * cached answer for its 24h lifetime and the issuer is never contacted again). `validation_error`
 * is Stripe.js refusing the call client-side, before any request leaves the browser. Every other
 * type routes through `resolveNextActionOutcome`, which asks Stripe what actually happened.
 */
const DEFINITE_NON_COMPLETION_ERROR_TYPES: ReadonlySet<string> = new Set([
  'card_error',
  'validation_error',
]);

/**
 * Copy per failure code. `stripe_error` and `saved_card_error` are DELIBERATELY different and
 * must never be merged: on the new-card path nothing was charged, but on the saved-card path
 * the charge is attempted inside the Server Action, so "no charge was made" would be a lie
 * about the buyer's money.
 */
const START_ERROR_COPY: Record<string, string> = {
  unauthorized: "You don't have permission to top up this balance.",
  invalid_input: 'Something looks off with the amount. Please adjust and try again.',
  stripe_error: "We couldn't start the payment just now — no charge was made. Give it another go?",
  saved_card_error: SAVED_CARD_ERROR_COPY,
  no_saved_card: "We couldn't find your saved card. Enter a card to continue.",
  card_declined: 'Your card was declined. Try a different card?',
  // BAL-523 FIX ROUND 2 (R4) — the low-balance picker in this composer tried to move the wallet
  // out of a card-backed mode while a consultation is live, and the server refused. The action
  // returns before the PaymentIntent is created, so "no charge was made" is literally true, and
  // the top-up itself is never what was blocked — the buyer just has to leave the setting alone.
  settlement_outstanding:
    "We can't change your low-balance setting while a consultation is running — no charge was made. Leave it as it is and your top-up will go through.",
};

/**
 * The Pay button and the whole charge orchestration.
 *
 * ⚠ MUST RENDER INSIDE `<Elements>`: `useStripe()` / `useElements()` only resolve there, and a
 * `useStripe()` that returns `null` silently disables Pay forever. Because this control lives in
 * the summary rail — a SIBLING column of the payment section, not a descendant — the provider is
 * hoisted to the composer root. That hoist is the reason this component exists.
 *
 * Two charge paths, one button:
 *  · NEW CARD  — `elements.submit()` → `startPurchaseAction` → `stripe.confirmPayment`. This is
 *    the shipped flow, lifted verbatim.
 *  · SAVED CARD — no Element to submit and the browser never learns the payment-method id, so
 *    the api creates AND confirms the PaymentIntent. `complete` goes straight to the receipt;
 *    `requires_action` runs 3DS via `handleNextAction`; a decline surfaces inline with a
 *    "use a different card" escape. A 3DS challenge that PROVABLY did not complete rotates the
 *    idempotency key too (BAL-515); an ambiguous one asks Stripe first — see `confirmSavedCard`
 *    and `DEFINITE_NON_COMPLETION_ERROR_TYPES`.
 *
 * The wallet is credited by the shipped BAL-382 webhook — NEVER from any return value here.
 */
export function PayAction({
  amountMinor,
  promoMinor,
  promoCode,
  promoCodeId,
  lowBalanceMode,
  paymentMethodSource,
  disabled = false,
  compact = false,
  buildStartInput,
  onComplete,
  onUseDifferentCard,
  onCardDeclined,
}: Readonly<PayActionProps>) {
  const stripe = useStripe();
  const elements = useElements();
  const [status, setStatus] = useState<'idle' | 'processing'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [declined, setDeclined] = useState(false);
  // One-shot shake on a charge error (reset on animationend); motion-reduce viewers get the
  // straight red highlight (the error line) instead of the shake.
  const [shake, setShake] = useState(false);
  const stopShake = useCallback(() => setShake(false), []);

  const usingSavedCard = paymentMethodSource === 'saved_card';

  // Keep the PaymentElement's displayed amount in sync as the slider moves (deferred flow).
  useEffect(() => {
    if (elements) elements.update({ amount: amountMinor });
  }, [elements, amountMinor]);

  const fail = useCallback((message: string | null) => {
    setShake(true);
    setError(message ?? "That didn't go through — no charge was made. Want to try again?");
    setStatus('idle');
  }, []);

  /**
   * Finish the card-backed mandate and report whether it is genuinely captured.
   *
   * ⚠ THE ANSWER COMES FROM THE STATED OUTCOME, NEVER FROM A NULLABLE SECRET. `succeeded`,
   * `failed` and a secret-less `requires_action` all used to arrive as `null`, and treating any
   * null on the saved-card path as "captured" told a buyer whose mandate had just been REFUSED
   * that automatic charging was on — the receipt's warning suppressed, `MANDATE_CAPTURED` fired,
   * the wallet stuck at `pending` with nothing to ever tell them.
   *
   * A hiccup in the browser step still never fails the purchase — the money is already charged;
   * the mode simply stays uncaptured and the receipt surfaces its warning.
   */
  const captureMandate = useCallback(
    async (mandate: MandateOutcome, savedPaymentMethodId: string | null): Promise<boolean> => {
      if (mandate.outcome !== 'requires_action') {
        return mandate.outcome === 'captured';
      }
      if (!stripe) return false;
      if (usingSavedCard) {
        // 3DS on a mandate the api already confirmed server-side against the stored card.
        try {
          const { setupIntent, error: actionError } = await stripe.handleNextAction({
            clientSecret: mandate.clientSecret,
          });
          // An ABANDONED challenge comes back with NO error and the intent still
          // `requires_action`; counting that as captured tells a buyer automatic charging is on
          // when it is not — the exact lie this function's docblock exists to prevent.
          return !actionError && setupIntent?.status === 'succeeded';
        } catch {
          // `handleNextAction` REJECTS when the intent is not in `requires_action`. Nothing here
          // may fail the purchase — the money is already charged — so the mode simply stays
          // uncaptured and the receipt surfaces its warning.
          return false;
        }
      }
      if (savedPaymentMethodId === null) return false;
      const { error: setupError } = await stripe.confirmSetup({
        clientSecret: mandate.clientSecret,
        confirmParams: {
          payment_method: savedPaymentMethodId,
          return_url: globalThis.location.href,
        },
        redirect: 'if_required',
      });
      return !setupError;
    },
    [stripe, usingSavedCard]
  );

  /**
   * NEW CARD — confirm the PaymentIntent against the mounted Payment Element. Resolves to the
   * payment-method id Stripe saved (the mandate SetupIntent must be confirmed against the SAME
   * card), or `null` when the charge did not go through, with the buyer-facing error already set.
   */
  const confirmNewCard = useCallback(
    async (clientSecret: string): Promise<{ paymentMethodId: string | null } | null> => {
      if (!stripe || !elements) {
        fail(null);
        return null;
      }
      const { error: payError, paymentIntent } = await stripe.confirmPayment({
        elements,
        clientSecret,
        confirmParams: { return_url: globalThis.location.href },
        redirect: 'if_required',
      });
      if (payError) {
        fail(payError.message ?? null);
        return null;
      }
      if (
        paymentIntent &&
        paymentIntent.status !== 'succeeded' &&
        paymentIntent.status !== 'processing'
      ) {
        fail(null);
        return null;
      }
      const method = paymentIntent?.payment_method;
      return { paymentMethodId: typeof method === 'string' ? method : (method?.id ?? null) };
    },
    [stripe, elements, fail]
  );

  /**
   * The AMBIGUOUS arms of `confirmSavedCard`, resolved rather than guessed. Reached from BOTH the
   * rejection (`catch`) and any `{ error }` return whose type is not a definite non-completion.
   *
   * ⚠ ROTATING BLIND HERE IS A DUPLICATE CHARGE. `handleNextAction` REJECTS whenever the intent is
   * not in `requires_action` — and the commonest reason by far is that it ALREADY SUCCEEDED (a
   * replay of a settled purchase). It also RETURNS an `api_connection_error` when the challenge
   * completed but the answer never made it back. Rotating `clientRequestId` on either changes the
   * server-side purchase idempotency key (`purchase:{walletId}:{source}:{clientRequestId}`), so one
   * further Pay press creates a SECOND PaymentIntent — and on the saved-card path the api confirms
   * it, so that is a second real charge, taken from a buyer who was simultaneously told "no charge
   * was made".
   *
   * So ask Stripe what actually happened. `succeeded` / `processing` ⇒ the purchase is done; hand
   * it to the normal completion path and rotate NOTHING. Only a provably-unpaid intent rotates.
   *
   * ⚠ AN UNREADABLE INTENT FAILS CLOSED FOR MONEY: ambiguous-outcome copy, and NO rotation. The
   * two failure modes are not symmetric — a stale replayed key costs the buyer a repeated no-op
   * they can retry after a refresh; a rotated key on an already-paid intent costs them real money.
   */
  const resolveNextActionOutcome = useCallback(
    async (clientSecret: string): Promise<boolean> => {
      if (!stripe) {
        fail(SAVED_CARD_ERROR_COPY);
        return false;
      }
      try {
        const { paymentIntent, error: retrieveError } =
          await stripe.retrievePaymentIntent(clientSecret);
        if (retrieveError || !paymentIntent) {
          fail(SAVED_CARD_ERROR_COPY);
          return false;
        }
        if (paymentIntent.status === 'succeeded' || paymentIntent.status === 'processing') {
          // Already paid. `onComplete` still fires below, so the receipt polls the wallet exactly
          // as it does on a first-time purchase — the webhook remains the sole crediting authority.
          return true;
        }
        // Provably still unpaid (`requires_payment_method` / `canceled` / a stale
        // `requires_action`): the cached answer on this key is worthless, so rotate.
        onCardDeclined();
        fail(SAVED_CARD_ERROR_COPY);
        return false;
      } catch {
        fail(SAVED_CARD_ERROR_COPY);
        return false;
      }
    },
    [stripe, fail, onCardDeclined]
  );

  /**
   * SAVED CARD — the api already created AND confirmed the PaymentIntent; the browser only
   * answers the 3DS challenge. `handleNextAction` never needs the payment-method id, which is
   * why the browser is never told it.
   *
   * ⚠ NO ARM HERE MAY SAY "no charge was made" — see `SAVED_CARD_ERROR_COPY`.
   */
  const confirmSavedCard = useCallback(
    async (clientSecret: string): Promise<boolean> => {
      if (!stripe) return false;
      try {
        const { paymentIntent, error: actionError } = await stripe.handleNextAction({
          clientSecret,
        });
        if (actionError) {
          // ⚠ ROTATE THE KEY — BUT ONLY WHEN THE ERROR PROVES NOTHING WAS CHARGED. A
          // `requires_action` answer is a CACHED 200 against the purchase idempotency key exactly
          // as a 402 decline is: failing or abandoning the challenge leaves the key holding a
          // stale `requires_action` that the next Pay press REPLAYS for the key's 24h lifetime —
          // the issuer is never contacted again. That is the bug the rotation fixes, and a
          // `card_error` (or a client-side `validation_error`) is exactly that case, so it keeps
          // rotating. Stripe's own message is kept because it is specific and true ("We are unable
          // to authenticate your payment method"); only the message-less fallback changes, to the
          // ambiguous-outcome copy — never the "no charge was made" default, which this path may
          // not show.
          //
          // ⚠⚠ EVERY OTHER ERROR TYPE IS INDETERMINATE, AND ROTATING ON ONE IS A SECOND REAL
          // CHARGE. An `api_connection_error` / `api_error` / `rate_limit_error` can be raised
          // AFTER the challenge completed and the api's `confirm: true` PaymentIntent succeeded;
          // "Stripe returned an error" is not "the card was not charged". Those go to the
          // resolver, which retrieves the intent and lets its REAL status decide. Same rule the
          // `catch` below follows, and the same rule `isCardDeclineError` states server-side.
          if (!DEFINITE_NON_COMPLETION_ERROR_TYPES.has(actionError.type)) {
            return resolveNextActionOutcome(clientSecret);
          }
          onCardDeclined();
          fail(actionError.message ?? SAVED_CARD_ERROR_COPY);
          return false;
        }
        if (
          paymentIntent &&
          paymentIntent.status !== 'succeeded' &&
          paymentIntent.status !== 'processing'
        ) {
          // Mirrors `confirmNewCard`'s guard above. An abandoned challenge can come back with NO
          // error and the intent still in `requires_action`; reading only `error` counted that
          // as a completed purchase. Every status reachable here is PROVABLY unpaid, so rotating
          // is safe — but the copy still must not claim nothing was charged.
          onCardDeclined();
          fail(SAVED_CARD_ERROR_COPY);
          return false;
        }
        return true;
      } catch {
        // `handleNextAction` THROWS when the intent is not in `requires_action` — which is
        // precisely what a REPLAYED, already-succeeded intent is. Unhandled, this rejection
        // escaped `onPay` into `handlePayClick`'s `.catch(() => undefined)` and left Pay stuck on
        // "Processing…" with no error and no completion. Resolve the real status before deciding.
        return resolveNextActionOutcome(clientSecret);
      }
    },
    [stripe, fail, onCardDeclined, resolveNextActionOutcome]
  );

  /** Take the Server Action's outcome to a settled charge, whichever arm it came back on. */
  const confirmCharge = useCallback(
    async (start: StartSuccess): Promise<{ paymentMethodId: string | null } | null> => {
      if (start.outcome === 'needs_client_confirmation') {
        return confirmNewCard(start.clientSecret);
      }
      if (start.outcome === 'requires_action') {
        return (await confirmSavedCard(start.clientSecret)) ? { paymentMethodId: null } : null;
      }
      // 'complete' — settled server-side, nothing for the browser to do.
      return { paymentMethodId: null };
    },
    [confirmNewCard, confirmSavedCard]
  );

  /** Surface a start-time failure, with the decline escape hatch when the card was refused. */
  const reportStartFailure = useCallback(
    (start: StartFailure) => {
      if (start.error === 'card_declined') {
        setDeclined(true);
        // Rotate the idempotency key NOW, not at retry time: the decline is already cached
        // against the current key, so the very next Pay press must carry a fresh one.
        onCardDeclined();
        track(CREDIT_EVENTS.PURCHASE_DECLINED, {
          amount_minor: amountMinor,
          decline_code: start.declineCode ?? null,
        });
      }
      fail(START_ERROR_COPY[start.error] ?? START_ERROR_COPY.stripe_error ?? null);
    },
    [amountMinor, fail, onCardDeclined]
  );

  const onPay = useCallback(async () => {
    if (!stripe || status === 'processing') return;
    // The new-card path needs an Elements instance to submit; the saved-card path does not.
    if (!usingSavedCard && !elements) return;

    track(CREDIT_EVENTS.PURCHASE_STARTED, {
      amount_minor: amountMinor,
      promo_applied: promoMinor > 0,
      funding_method: 'card',
      low_balance_mode: lowBalanceMode,
      payment_method_source: paymentMethodSource,
    });

    setStatus('processing');
    setError(null);
    setDeclined(false);

    if (!usingSavedCard && elements) {
      const { error: submitError } = await elements.submit();
      if (submitError) {
        fail(submitError.message ?? null);
        return;
      }
    }

    const start = await startPurchaseAction(buildStartInput());
    if (!start.ok) {
      reportStartFailure(start);
      return;
    }

    const charged = await confirmCharge(start);
    if (charged === null) return;

    const mandateCaptured = await captureMandate(start.mandate, charged.paymentMethodId);

    // ⚠ `paymentIntentId` RIDES ALONG ON EVERY `ok` ARM — it is present on all three by
    // construction, and dropping it here is exactly what left the receipt unable to ask the
    // wallet whether the credit landed. It is the poll's terminal key, not a credit grant.
    onComplete({
      amountMinor,
      promoMinor,
      promoCode,
      promoCodeId,
      lowBalanceMode,
      mandateCaptured,
      paymentIntentId: start.paymentIntentId,
    });
  }, [
    stripe,
    elements,
    status,
    usingSavedCard,
    amountMinor,
    promoMinor,
    promoCode,
    promoCodeId,
    lowBalanceMode,
    paymentMethodSource,
    buildStartInput,
    onComplete,
    confirmCharge,
    captureMandate,
    reportStartFailure,
    fail,
  ]);

  const handlePayClick = useCallback(() => {
    onPay().catch(() => undefined);
  }, [onPay]);

  return (
    <div>
      <style>{`
        @keyframes topupShake{0%,100%{transform:translateX(0)}20%,60%{transform:translateX(-6px)}40%,80%{transform:translateX(6px)}}
      `}</style>

      {error && (
        <p role="alert" className="text-destructive mb-2.5 text-sm font-medium">
          {error}
        </p>
      )}

      {declined && (
        <div className="mb-2.5">
          <button
            type="button"
            onClick={onUseDifferentCard}
            className="text-primary focus-visible:ring-ring relative rounded text-sm font-semibold before:absolute before:-inset-2 before:content-[''] hover:opacity-80 focus-visible:ring-2 focus-visible:outline-none"
          >
            Use a different card
          </button>
        </div>
      )}

      <Button
        type="button"
        size="lg"
        onClick={handlePayClick}
        onAnimationEnd={stopShake}
        disabled={status === 'processing' || !stripe || disabled}
        className={cn(
          'from-primary bg-gradient-to-br to-violet-600 text-white transition-transform active:scale-[0.98] motion-reduce:active:scale-100',
          compact ? 'w-auto whitespace-nowrap' : 'w-full',
          shake && 'motion-safe:animate-[topupShake_0.4s_ease-in-out] motion-reduce:animate-none'
        )}
      >
        {status === 'processing' ? (
          <>
            <Loader2 className="size-4 animate-spin" aria-hidden="true" /> Processing…
          </>
        ) : (
          <>
            Pay {formatAud(amountMinor)}{' '}
            <ArrowRight className="size-4" strokeWidth={2.6} aria-hidden="true" />
          </>
        )}
      </Button>
    </div>
  );
}

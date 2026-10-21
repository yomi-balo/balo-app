'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Sentry from '@sentry/nextjs';
import { toast } from 'sonner';
import type { StripeElementsOptions } from '@stripe/stripe-js';
import { Elements, useElements, useStripe } from '@stripe/react-stripe-js';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { track, BOOKING_EVENTS, CREDIT_EVENTS } from '@/lib/analytics';
import type { BookingFundingFailureReason } from '@balo/analytics/events';
import type { PaymentMethodSource } from '@/lib/credit/api-client';
import { PaymentMethodSection } from '@/components/billing/top-up/PaymentMethodSection';
import type { BookingTopUpWallet, FundedVia } from '@/lib/booking/actions/booking-funding-types';
import { getStripe } from '@/lib/stripe/loader';
import type { BookingFundingBlockProps } from './booking-funding-block';
import {
  BusyButton,
  CTA_GRADIENT,
  FundingFooter,
  FundingSection,
  useMountedRef,
} from './funding-frame';
import { PAY_AFTER_COPY, payAfterConsentLine } from './funding-copy';
import type { RefusedFundingView } from './funding-disposition';
import { MandateAwaiter } from './mandate-awaiter';
import {
  armSavedCard,
  captureNewCard,
  switchToKeepGoing,
  type PayAfterFailure,
  type StepResult,
} from './pay-after-steps';

type PayAfterStage =
  | 'idle'
  | 'setting_up'
  | 'authenticating'
  | 'awaiting_mandate'
  | 'unconfirmed'
  | 'booking';

type PayAfterFundingProps = Pick<
  BookingFundingBlockProps,
  | 'caseSaved'
  | 'ctaDisabled'
  | 'onBeforePay'
  | 'onFunded'
  | 'onBack'
  | 'onBusyChange'
  | 'onInFlightChange'
> & {
  readonly view: RefusedFundingView;
  readonly wallet: BookingTopUpWallet;
  /** The method picker, rendered first inside the controls so both methods share one layout. */
  readonly methodPicker: React.ReactNode;
};

const FAILURE_REASON: Readonly<Record<PayAfterFailure, BookingFundingFailureReason>> = {
  declined: 'declined',
  auth_failed: 'auth_failed',
  setup_failed: 'setup_failed',
  mode_failed: 'setup_failed',
  arm_failed: 'setup_failed',
  settlement_outstanding: 'settlement_outstanding',
  error: 'error',
};

/** The line for a failure; once the mode has been switched, it also says the setting changed. */
function failureCopy(reason: PayAfterFailure, modeSwitched: boolean): string {
  if (reason === 'arm_failed') return PAY_AFTER_COPY.errors.setup_failed_saved;
  const line = PAY_AFTER_COPY.errors[reason];
  return modeSwitched && reason !== 'mode_failed' ? `${line} ${PAY_AFTER_COPY.switchedNote}` : line;
}

function unconfirmedText(modeSwitched: boolean): string {
  return modeSwitched
    ? `${PAY_AFTER_COPY.unconfirmed} ${PAY_AFTER_COPY.switchedNote}`
    : PAY_AFTER_COPY.unconfirmed;
}

function stageText(stage: PayAfterStage, usingSavedCard: boolean, modeSwitched = false): string {
  switch (stage) {
    case 'idle':
      return '';
    case 'unconfirmed':
      return unconfirmedText(modeSwitched);
    case 'setting_up':
      return usingSavedCard
        ? PAY_AFTER_COPY.stage.setting_up_saved
        : PAY_AFTER_COPY.stage.setting_up_new;
    default:
      return PAY_AFTER_COPY.stage[stage];
  }
}

interface PayAfterBodyProps extends PayAfterFundingProps {
  /** False renders the controls but never enables the press. */
  readonly stripeConfigured: boolean;
}

/**
 * A billing manager chooses to pay after the call: the wallet is switched to Keep me going, a
 * card's mandate is armed (the saved card, or a new one captured here), the block waits until the
 * wallet reports that mandate active, and only then books. Renders inside `<Elements>`.
 */
function PayAfterBody({
  view,
  wallet,
  caseSaved,
  ctaDisabled,
  onBeforePay,
  onFunded,
  onBack,
  onBusyChange,
  onInFlightChange,
  methodPicker,
  stripeConfigured,
}: Readonly<PayAfterBodyProps>) {
  const stripe = useStripe();
  const elements = useElements();
  const companyName = view.company.name;
  const mountedRef = useMountedRef();
  const [source, setSource] = useState<PaymentMethodSource>(
    wallet.savedCard === null ? 'new_card' : 'saved_card'
  );
  const [stage, setStage] = useState<PayAfterStage>('idle');
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const usedSavedCardRef = useRef(false);
  const modeSwitchedRef = useRef(false);
  const cardReadyRef = useRef(false);
  const [cardReady, setCardReady] = useState(false);
  const ctaSlotRef = useRef<HTMLDivElement>(null);

  const usingSavedCard = wallet.savedCard !== null && source === 'saved_card';
  // An unconfirmed card still fixes what is being set up (busy) but nothing is running (not in
  // flight), so the client may leave the dialog and keep the draft.
  const busy = stage !== 'idle';
  const inFlight = busy && stage !== 'unconfirmed';
  useEffect(() => {
    onBusyChange(busy);
  }, [busy, onBusyChange]);
  useEffect(() => {
    onInFlightChange(inFlight);
  }, [inFlight, onInFlightChange]);
  useEffect(
    () => () => {
      onBusyChange(false);
      onInFlightChange(false);
    },
    [onBusyChange, onInFlightChange]
  );

  const stageRef = useRef(stage);
  useEffect(() => {
    if (stageRef.current === stage) return;
    stageRef.current = stage;
    const active = globalThis.document.activeElement;
    const slot = ctaSlotRef.current;
    if (slot !== null && (active === null || active === globalThis.document.body)) slot.focus();
  }, [stage]);

  const handleSourceChange = useCallback((next: PaymentMethodSource) => {
    setSource(next);
    setError(null);
    track(CREDIT_EVENTS.PAYMENT_METHOD_CHANGED, { to: next, surface: 'booking' });
  }, []);

  const fail = useCallback(
    (reason: PayAfterFailure, reasonOverride?: BookingFundingFailureReason, silent = false) => {
      if (!silent)
        track(BOOKING_EVENTS.FUNDING_FAILED, { reason: reasonOverride ?? FAILURE_REASON[reason] });
      if (!mountedRef.current) return;
      setError(silent ? null : failureCopy(reason, modeSwitchedRef.current));
      setStage('idle');
    },
    [mountedRef]
  );

  const runSetup = useCallback(async (): Promise<StepResult> => {
    if (stripe === null || elements === null) return { ok: false, reason: 'error', silent: true };
    try {
      if (usedSavedCardRef.current) {
        return await armSavedCard(wallet.lowBalanceFigures, {
          onAuthenticating: () => setStage('authenticating'),
          onSwitched: () => {
            modeSwitchedRef.current = true;
          },
        });
      }
      return await captureNewCard(stripe, elements);
    } catch (error_) {
      Sentry.captureException(error_, {
        tags: {
          feature: 'booking',
          step: usedSavedCardRef.current ? 'pay_after_arm_saved' : 'pay_after_capture_new',
        },
      });
      return { ok: false, reason: 'error' };
    }
  }, [stripe, elements, wallet.lowBalanceFigures]);

  const bookNow = useCallback(async () => {
    const savedCard = usedSavedCardRef.current;
    toast.success(PAY_AFTER_COPY.switchedToast(companyName));
    track(BOOKING_EVENTS.FUNDED, { method: 'pay_after', saved_card: savedCard });
    track(CREDIT_EVENTS.MANDATE_CAPTURED, { low_balance_mode: 'keep_going', surface: 'booking' });
    setStage('booking');
    const funded: FundedVia = {
      method: 'pay_after',
      card: savedCard ? wallet.savedCard : null,
      companyName,
    };
    let booked = false;
    try {
      booked = await onFunded(funded);
    } catch (error_) {
      Sentry.captureException(error_, { tags: { feature: 'booking', step: 'funded_book' } });
    }
    if (booked) return;
    track(BOOKING_EVENTS.FUNDING_FAILED, { reason: 'booking_failed' });
    if (mountedRef.current) setStage('idle');
  }, [companyName, wallet.savedCard, onFunded, mountedRef]);

  const switchThenBook = useCallback(async (): Promise<void> => {
    if (!usedSavedCardRef.current) {
      let switched: StepResult = { ok: false, reason: 'mode_failed' };
      try {
        switched = await switchToKeepGoing(wallet.lowBalanceFigures);
      } catch (error_) {
        Sentry.captureException(error_, {
          tags: { feature: 'booking', step: 'pay_after_switch_mode' },
        });
      }
      if (!switched.ok) {
        fail('mode_failed');
        return;
      }
    }
    await bookNow();
  }, [wallet.lowBalanceFigures, bookNow, fail]);

  const handleActive = useCallback(() => {
    if (!usedSavedCardRef.current) {
      cardReadyRef.current = true;
      setCardReady(true);
    }
    switchThenBook().catch(() => undefined);
  }, [switchThenBook]);
  const handlePress = useCallback(async () => {
    if (!onBeforePay()) return;
    setError(null);
    usedSavedCardRef.current = !cardReadyRef.current && usingSavedCard;
    setStage('setting_up');
    if (cardReadyRef.current) {
      await switchThenBook();
      return;
    }
    const result = await runSetup();
    if (!mountedRef.current) return;
    if (!result.ok) {
      fail(result.reason, undefined, result.silent === true);
      return;
    }
    setAttempt((value) => value + 1);
    setStage('awaiting_mandate');
  }, [onBeforePay, usingSavedCard, runSetup, mountedRef, fail, switchThenBook]);

  // A saved card was already switched to Keep me going before its mandate failed.
  const handleFailed = useCallback(
    () => fail(usedSavedCardRef.current ? 'arm_failed' : 'setup_failed'),
    [fail]
  );
  const handleUnconfirmed = useCallback(() => {
    track(BOOKING_EVENTS.FUNDING_FAILED, { reason: 'mandate_timeout' });
    if (mountedRef.current) setStage('unconfirmed');
  }, [mountedRef]);
  const handleCheckAgain = useCallback(() => {
    setAttempt((value) => value + 1);
    setStage('awaiting_mandate');
  }, []);

  const handlePressClick = useCallback(() => {
    handlePress().catch(() => undefined);
  }, [handlePress]);

  const idleLabel = usingSavedCard || cardReady ? PAY_AFTER_COPY.ctaSaved : PAY_AFTER_COPY.ctaNew;
  let cta: React.ReactNode;
  if (stage === 'unconfirmed') {
    cta = (
      <Button
        type="button"
        size="lg"
        className={cn('min-h-11 w-full', CTA_GRADIENT)}
        disabled={ctaDisabled}
        onClick={handleCheckAgain}
      >
        {PAY_AFTER_COPY.checkAgain}
      </Button>
    );
  } else if (stage === 'idle') {
    cta = (
      <Button
        type="button"
        size="lg"
        className={cn('min-h-11 w-full', CTA_GRADIENT)}
        disabled={ctaDisabled || !stripeConfigured || stripe === null || elements === null}
        onClick={handlePressClick}
      >
        {idleLabel}
      </Button>
    );
  } else {
    cta = (
      <BusyButton
        label={stageText(stage, usedSavedCardRef.current || cardReady, modeSwitchedRef.current)}
      />
    );
  }

  return (
    <div className="space-y-3">
      <FundingSection view={view} caseSaved={caseSaved} draftKept method="pay_after">
        <div className="flex flex-col gap-[18px] p-4 sm:p-[18px]">
          <fieldset disabled={busy} className="m-0 min-w-0 space-y-[18px] border-0 p-0">
            {methodPicker}
            {cardReady ? (
              <p className="text-sm leading-relaxed">{PAY_AFTER_COPY.cardSaved}</p>
            ) : (
              <PaymentMethodSection
                savedCard={wallet.savedCard}
                source={source}
                onSourceChange={handleSourceChange}
              />
            )}
            <p className="text-muted-foreground text-xs leading-relaxed">
              {payAfterConsentLine(
                companyName,
                usingSavedCard && !cardReady ? wallet.savedCard : null
              )}
            </p>
            {error !== null && (
              <p role="alert" className="text-destructive-strong text-sm font-medium">
                {error}
              </p>
            )}
          </fieldset>
        </div>
      </FundingSection>

      {stage === 'unconfirmed' && (
        <p className="text-muted-foreground bg-muted/50 rounded-lg px-3 py-2.5 text-sm leading-relaxed">
          {unconfirmedText(modeSwitchedRef.current)}
        </p>
      )}
      <div role="status" aria-live="polite" className="sr-only">
        {stageText(stage, usedSavedCardRef.current || cardReady, modeSwitchedRef.current)}
      </div>

      <FundingFooter onBack={onBack} backDisabled={inFlight} slotRef={ctaSlotRef}>
        {cta}
      </FundingFooter>

      {stage === 'awaiting_mandate' && (
        <MandateAwaiter
          key={attempt}
          onActive={handleActive}
          onFailed={handleFailed}
          onUnconfirmed={handleUnconfirmed}
        />
      )}
    </div>
  );
}

/**
 * The "Pay after the call" method of the inline funding block. Its own `<Elements>` in deferred
 * `setup` mode: the Payment Element renders before any SetupIntent exists, and the intent is
 * opened on the press.
 */
export function PayAfterFunding(props: Readonly<PayAfterFundingProps>): React.JSX.Element {
  const publishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
  const stripePromise = useMemo(
    () => (publishableKey ? getStripe(publishableKey) : Promise.resolve(null)),
    [publishableKey]
  );
  const options = useMemo<StripeElementsOptions>(() => ({ mode: 'setup', currency: 'aud' }), []);
  return (
    <Elements stripe={stripePromise} options={options}>
      <PayAfterBody {...props} stripeConfigured={Boolean(publishableKey)} />
    </Elements>
  );
}

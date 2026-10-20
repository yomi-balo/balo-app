'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import * as Sentry from '@sentry/nextjs';
import { ChevronLeft, Loader2, Wallet } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { track, BOOKING_EVENTS, CREDIT_EVENTS } from '@/lib/analytics';
import type { StartPurchaseInput } from '@/lib/credit/actions';
import type { PaymentMethodSource } from '@/lib/credit/api-client';
import { formatAudShort } from '@/lib/credit/display-constants';
import { PayAction, type PayActionFailureReason } from '@/components/billing/top-up/PayAction';
import { PaymentMethodSection } from '@/components/billing/top-up/PaymentMethodSection';
import { PromoField, type AppliedPromo } from '@/components/billing/top-up/PromoField';
import { TopUpElements, isStripeConfigured } from '@/components/billing/top-up/TopUpElements';
import { usePurchaseRequestId } from '@/components/billing/top-up/use-purchase-request-id';
import type { PurchaseCompletion } from '@/components/billing/top-up/types';
import type { BookingTopUpWallet } from '@/lib/booking/actions/booking-funding-types';
import { caseSavedCopy, companyLabels, type CaseSavedNote } from '../booking-error-panels';
import { CreditAwaiter } from './credit-awaiter';
import { buildAmountChips, parseOtherAmount, type OtherAmountResult } from './funding-amount';
import { FundingAmountPicker } from './funding-amount-picker';
import {
  BOOKING_PAY_ERROR_COPY,
  FUNDING_AUD_LINE,
  FUNDING_STAGE_COPY,
  creditPendingCopy,
  fundingBlockCopy,
} from './funding-copy';
import type { RefusedFundingView } from './funding-disposition';

/** What a successful top-up leaves in the balance, for the line shown once the booking lands. */
export interface FundedTopUp {
  readonly creditedMinor: number;
  readonly companyName: string | null;
}

export interface BookingFundingBlockProps {
  readonly view: RefusedFundingView;
  /** Set when the case row was already written; the line is shown under the heading. */
  readonly caseSaved: CaseSavedNote | null;
  /** The dialog's own slot and company gates. */
  readonly ctaDisabled: boolean;
  /** The dialog validates the form and writes the draft. `false` abandons the press with no charge. */
  readonly onBeforePay: () => boolean;
  /**
   * Books the consultation with the SAME nonce. Called only after the wallet shows the credit.
   * Resolves `true` once the consultation is booked, `false` when it is not.
   */
  readonly onFunded: (topUp: FundedTopUp) => Promise<boolean>;
  /** The member arm: keep the draft on this device and tell the billing admins. */
  readonly onSaveForLater: () => Promise<void>;
  readonly onBack: () => void;
  /** Whether Save keeps the typed details on this device (the member copy says so). */
  readonly draftKept: boolean;
  /**
   * Reports `true` while a payment, the wait for the credit or the booking itself is under way,
   * so the dialog can lock the controls that would change what is being paid for.
   */
  readonly onBusyChange: (busy: boolean) => void;
}

type Stage = 'pay' | 'awaiting_credit' | 'booking' | 'credit_unconfirmed';

interface PendingTopUp {
  readonly paymentIntentId: string;
  readonly promoCodeId: string | null;
  readonly amountMinor: number;
  readonly promoMinor: number;
  readonly savedCard: boolean;
}

/** The amount that will be charged, or `null` while "Other" holds nothing usable. */
function effectiveAmount(
  selectedMinor: number,
  parsedOther: OtherAmountResult | null
): number | null {
  if (parsedOther === null) return selectedMinor;
  return parsedOther.ok ? parsedOther.amountMinor : null;
}

/** What the polite live region says for the stage the block is in; empty while nothing runs. */
function stageStatusText(stage: Stage, paying: boolean, companyName: string | null): string {
  if (stage === 'pay') return paying ? FUNDING_STAGE_COPY.processing : '';
  if (stage === 'credit_unconfirmed') return creditPendingCopy(companyName);
  return FUNDING_STAGE_COPY[stage];
}

const CTA_GRADIENT = 'from-primary bg-gradient-to-br to-violet-600 text-white';

/** Tracks whether the component is still mounted, for state updates after an awaited booking. */
function useMountedRef(): React.RefObject<boolean> {
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  return mountedRef;
}

interface FundingSectionProps {
  readonly view: RefusedFundingView;
  readonly caseSaved: CaseSavedNote | null;
  readonly draftKept: boolean;
  readonly children?: React.ReactNode;
}

/** The framed block: a header band (icon, heading, body) and, for a manager, the controls below. */
function FundingSection({ view, caseSaved, draftKept, children }: Readonly<FundingSectionProps>) {
  const headingId = useId();
  const reduceMotion = useReducedMotion();
  const copy = fundingBlockCopy(view, draftKept);
  return (
    <motion.section
      aria-labelledby={headingId}
      initial={reduceMotion ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      className="border-primary/20 bg-card overflow-hidden rounded-[14px] border"
    >
      <div
        className={cn(
          'bg-primary/5 flex items-start gap-3 px-[18px] py-4',
          children !== undefined && 'border-border border-b'
        )}
      >
        <span className="bg-primary/10 flex size-9 shrink-0 items-center justify-center rounded-[10px]">
          <Wallet className="text-primary size-[18px]" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h3 id={headingId} className="text-foreground text-[15px] leading-snug font-semibold">
            {copy.heading}
          </h3>
          <p className="text-muted-foreground mt-1 text-[13.5px] leading-relaxed">{copy.body}</p>
          {caseSaved !== null && (
            <p className="text-muted-foreground mt-1.5 text-[13.5px] leading-relaxed">
              {caseSavedCopy(caseSaved)}
            </p>
          )}
        </div>
      </div>
      {children}
    </motion.section>
  );
}

interface FundingFooterProps {
  readonly onBack: () => void;
  readonly backDisabled: boolean;
  /** The primary-action slot, focusable so focus survives the action being swapped. */
  readonly slotRef?: React.Ref<HTMLDivElement>;
  readonly children: React.ReactNode;
}

/** `[Back] [primary action]`, bottom-aligned so an error above the action does not skew Back. */
function FundingFooter({ onBack, backDisabled, slotRef, children }: Readonly<FundingFooterProps>) {
  return (
    <div className="flex items-end gap-2">
      <Button
        type="button"
        variant="outline"
        className="min-h-11"
        onClick={onBack}
        disabled={backDisabled}
      >
        <ChevronLeft className="size-4" aria-hidden="true" />
        Back
      </Button>
      <div
        ref={slotRef}
        tabIndex={slotRef === undefined ? undefined : -1}
        className="min-w-0 flex-1 focus:outline-none"
      >
        {children}
      </div>
    </div>
  );
}

function BusyButton({ label }: Readonly<{ label: string }>) {
  return (
    <Button
      type="button"
      size="lg"
      disabled
      aria-busy="true"
      className={cn('min-h-11 w-full', CTA_GRADIENT)}
    >
      <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
      {label}
    </Button>
  );
}

type MemberFundingProps = Pick<
  BookingFundingBlockProps,
  'view' | 'caseSaved' | 'ctaDisabled' | 'onSaveForLater' | 'onBack' | 'draftKept'
>;

/** A member cannot top up: they keep the booking for a billing admin. No payment controls render. */
function MemberFunding({
  view,
  caseSaved,
  ctaDisabled,
  onSaveForLater,
  onBack,
  draftKept,
}: Readonly<MemberFundingProps>) {
  const [saving, setSaving] = useState(false);
  const mountedRef = useMountedRef();

  const handleSave = useCallback(() => {
    setSaving(true);
    onSaveForLater()
      .catch((error: unknown) => {
        Sentry.captureException(error, { tags: { feature: 'booking', step: 'save_for_later' } });
      })
      .finally(() => {
        if (mountedRef.current) setSaving(false);
      });
  }, [onSaveForLater, mountedRef]);

  return (
    <div className="space-y-3">
      <FundingSection view={view} caseSaved={caseSaved} draftKept={draftKept} />
      <FundingFooter onBack={onBack} backDisabled={saving}>
        {saving ? (
          <BusyButton label="Saving…" />
        ) : (
          <Button
            type="button"
            size="lg"
            className={cn('min-h-11 w-full', CTA_GRADIENT)}
            disabled={ctaDisabled}
            onClick={handleSave}
          >
            Save and finish later
          </Button>
        )}
      </FundingFooter>
    </div>
  );
}

type ManagerFundingProps = Pick<
  BookingFundingBlockProps,
  'view' | 'caseSaved' | 'ctaDisabled' | 'onBeforePay' | 'onFunded' | 'onBack' | 'onBusyChange'
> & { readonly wallet: BookingTopUpWallet; readonly suggestedMinor: number };

/**
 * A billing manager pays here: pick an amount, pay, wait for the wallet to show the credit, then
 * book. The Payment Element and the saved-card row live in one section that is never unmounted.
 */
function ManagerFunding({
  view,
  wallet,
  suggestedMinor: suggested,
  caseSaved,
  ctaDisabled,
  onBeforePay,
  onFunded,
  onBack,
  onBusyChange,
}: Readonly<ManagerFundingProps>) {
  const companyName = view.company.name;
  const stripeConfigured = isStripeConfigured();
  const mountedRef = useMountedRef();

  const [amountMinor, setAmountMinor] = useState(suggested);
  const [other, setOther] = useState(false);
  const [otherValue, setOtherValue] = useState('');
  const [promo, setPromo] = useState<AppliedPromo | null>(null);
  const [source, setSource] = useState<PaymentMethodSource>(
    wallet.savedCard === null ? 'new_card' : 'saved_card'
  );
  const [stage, setStage] = useState<Stage>('pay');
  const [pending, setPending] = useState<PendingTopUp | null>(null);
  const [pollAttempt, setPollAttempt] = useState(0);
  const [paying, setPaying] = useState(false);
  const ctaSlotRef = useRef<HTMLDivElement>(null);

  // Anything past the pay button (a payment in flight, or a payment made) fixes what is being paid
  // for, so the dialog locks the controls that would change it.
  const busy = paying || stage !== 'pay';
  useEffect(() => {
    onBusyChange(busy);
  }, [busy, onBusyChange]);
  useEffect(() => () => onBusyChange(false), [onBusyChange]);

  // The button that held focus is replaced as the stage moves on; the slot keeps it.
  const stageRef = useRef(stage);
  useEffect(() => {
    if (stageRef.current === stage) return;
    stageRef.current = stage;
    const active = globalThis.document.activeElement;
    const slot = ctaSlotRef.current;
    if (slot !== null && (active === null || active === globalThis.document.body)) slot.focus();
  }, [stage]);

  const parsedOther = other ? parseOtherAmount(otherValue, suggested) : null;
  const effectiveMinor = effectiveAmount(amountMinor, parsedOther);
  const payAmount = effectiveMinor ?? suggested;
  const promoMinor = promo?.minor ?? 0;

  const { clientRequestId, rotate } = usePurchaseRequestId(
    `${payAmount}:${promo?.code ?? ''}:${source}`
  );

  const handleSourceChange = useCallback((next: PaymentMethodSource) => {
    setSource(next);
    track(CREDIT_EVENTS.PAYMENT_METHOD_CHANGED, { to: next, surface: 'booking' });
  }, []);
  const handleUseDifferentCard = useCallback(
    () => handleSourceChange('new_card'),
    [handleSourceChange]
  );
  const handleApplied = useCallback((applied: AppliedPromo) => setPromo(applied), []);
  const handleRemoved = useCallback(() => setPromo(null), []);
  const handleFailure = useCallback((reason: PayActionFailureReason) => {
    track(BOOKING_EVENTS.FUNDING_FAILED, { reason });
  }, []);

  const buildStartInput = useCallback(
    (): StartPurchaseInput => ({
      amountMinor: payAmount,
      clientRequestId,
      promoCode: promo?.code,
      lowBalance: 'keep',
      paymentMethodSource: source,
    }),
    [payAmount, clientRequestId, promo?.code, source]
  );

  const handleComplete = useCallback(
    (completion: PurchaseCompletion) => {
      setPending({
        paymentIntentId: completion.paymentIntentId,
        promoCodeId: completion.promoCodeId,
        amountMinor: completion.amountMinor,
        promoMinor: completion.promoMinor,
        savedCard: wallet.savedCard !== null && source === 'saved_card',
      });
      setStage('awaiting_credit');
    },
    [wallet.savedCard, source]
  );

  const bookAfterCredit = useCallback(
    async (topUp: PendingTopUp, promoGranted: boolean) => {
      setStage('booking');
      track(BOOKING_EVENTS.FUNDED, { method: 'topup', saved_card: topUp.savedCard });
      let booked = false;
      try {
        booked = await onFunded({
          creditedMinor: topUp.amountMinor + (promoGranted ? topUp.promoMinor : 0),
          companyName,
        });
      } catch (error) {
        Sentry.captureException(error, { tags: { feature: 'booking', step: 'funded_book' } });
      }
      if (booked || !mountedRef.current) return;
      // The credit has landed but the booking has not, and the block is still on screen: the
      // payment's key is spent, so the next press is a new attempt rather than a replay of it.
      rotate();
      setPaying(false);
      setStage('pay');
      setPending(null);
    },
    [onFunded, companyName, mountedRef, rotate]
  );

  const handleCredited = useCallback(
    (promoGranted: boolean) => {
      if (pending === null) return;
      bookAfterCredit(pending, promoGranted).catch(() => undefined);
    },
    [pending, bookAfterCredit]
  );
  const handleUnconfirmed = useCallback(() => {
    setStage('credit_unconfirmed');
    track(BOOKING_EVENTS.FUNDING_FAILED, { reason: 'credit_timeout' });
  }, []);
  const handleBookNow = useCallback(() => {
    setPollAttempt((attempt) => attempt + 1);
    setStage('awaiting_credit');
  }, []);

  const idleLabel =
    effectiveMinor === null ? 'Top up & book' : `Top up ${formatAudShort(effectiveMinor)} & book`;

  let cta: React.ReactNode;
  if (!stripeConfigured) {
    cta = (
      <Button type="button" size="lg" disabled className={cn('min-h-11 w-full', CTA_GRADIENT)}>
        {idleLabel}
      </Button>
    );
  } else if (stage === 'pay') {
    cta = (
      <PayAction
        amountMinor={payAmount}
        promoMinor={promoMinor}
        promoCode={promo?.code ?? null}
        promoCodeId={promo?.promoCodeId ?? null}
        paymentMethodSource={source}
        disabled={ctaDisabled || effectiveMinor === null}
        buildStartInput={buildStartInput}
        onComplete={handleComplete}
        onUseDifferentCard={handleUseDifferentCard}
        onCardDeclined={rotate}
        idleLabel={idleLabel}
        processingLabel={FUNDING_STAGE_COPY.processing}
        onProcessingChange={setPaying}
        surface="booking"
        beforeStart={onBeforePay}
        onFailure={handleFailure}
        errorCopy={BOOKING_PAY_ERROR_COPY}
      />
    );
  } else if (stage === 'credit_unconfirmed') {
    cta = (
      <Button
        type="button"
        size="lg"
        className={cn('min-h-11 w-full', CTA_GRADIENT)}
        disabled={ctaDisabled}
        onClick={handleBookNow}
      >
        Book now
      </Button>
    );
  } else {
    cta = (
      <BusyButton
        label={
          stage === 'awaiting_credit'
            ? FUNDING_STAGE_COPY.awaiting_credit
            : FUNDING_STAGE_COPY.booking
        }
      />
    );
  }

  const statusText = stageStatusText(stage, paying, companyName);

  return (
    <TopUpElements initialAmountMinor={suggested}>
      <div className="space-y-3">
        <FundingSection view={view} caseSaved={caseSaved} draftKept>
          <div className="flex flex-col gap-[18px] p-4 sm:p-[18px]">
            {stripeConfigured ? (
              <>
                <fieldset
                  disabled={pending !== null}
                  className="m-0 min-w-0 space-y-[18px] border-0 p-0"
                >
                  <FundingAmountPicker
                    chips={buildAmountChips(suggested)}
                    amountMinor={amountMinor}
                    onAmountChange={setAmountMinor}
                    other={other}
                    onOtherChange={setOther}
                    otherValue={otherValue}
                    onOtherValueChange={setOtherValue}
                    otherError={parsedOther !== null && !parsedOther.ok ? parsedOther.error : null}
                    minMinor={suggested}
                    effectiveMinor={effectiveMinor}
                    promoMinor={promoMinor}
                    companyLabel={companyLabels(companyName).mid}
                  />
                  <PromoField promo={promo} onApplied={handleApplied} onRemoved={handleRemoved} />
                </fieldset>
                <PaymentMethodSection
                  savedCard={wallet.savedCard}
                  source={source}
                  onSourceChange={handleSourceChange}
                />
              </>
            ) : (
              <p className="text-muted-foreground text-sm font-medium">
                Card payments aren&apos;t configured right now. Please try again later.
              </p>
            )}
          </div>
        </FundingSection>

        <div role="status" aria-live="polite" className="sr-only">
          {statusText}
        </div>
        {stage === 'credit_unconfirmed' && (
          <p className="text-muted-foreground bg-muted/50 rounded-lg px-3 py-2.5 text-sm leading-relaxed">
            {creditPendingCopy(companyName)}
          </p>
        )}

        <FundingFooter
          onBack={onBack}
          backDisabled={stage === 'awaiting_credit' || stage === 'booking'}
          slotRef={ctaSlotRef}
        >
          {cta}
        </FundingFooter>
        <p className="text-muted-foreground text-center text-xs">{FUNDING_AUD_LINE}</p>

        {stage === 'awaiting_credit' && pending !== null && (
          <CreditAwaiter
            key={pollAttempt}
            paymentIntentId={pending.paymentIntentId}
            promoCodeId={pending.promoCodeId}
            onCredited={handleCredited}
            onUnconfirmed={handleUnconfirmed}
          />
        )}
      </div>
    </TopUpElements>
  );
}

/**
 * The funding fix shown inline on Review & confirm when the pre-flight refused the booking.
 *
 * A billing manager of the active company tops up here and the booking follows; a member saves
 * the booking for a billing admin. The block never books on its own say-so: `onFunded` is called
 * only after the wallet shows the credit, and a Stripe return is not credit.
 *
 * Renders nothing for a manager whose view carries no wallet; `resolveFundingDisposition` sends
 * that case to the full panel.
 */
export function BookingFundingBlock({
  view,
  caseSaved,
  ctaDisabled,
  onBeforePay,
  onFunded,
  onSaveForLater,
  onBack,
  draftKept,
  onBusyChange,
}: Readonly<BookingFundingBlockProps>): React.JSX.Element | null {
  const shownKey = `${view.arm}:${view.company.id}`;
  const shownKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (shownKeyRef.current === shownKey) return;
    shownKeyRef.current = shownKey;
    track(BOOKING_EVENTS.FUNDING_SHOWN, {
      arm: view.arm,
      can_manage_billing: view.canManageBilling,
    });
  }, [shownKey, view.arm, view.canManageBilling]);

  if (!view.canManageBilling) {
    return (
      <MemberFunding
        view={view}
        caseSaved={caseSaved}
        ctaDisabled={ctaDisabled}
        onSaveForLater={onSaveForLater}
        onBack={onBack}
        draftKept={draftKept}
      />
    );
  }
  if (view.wallet === null || view.suggestedTopUpMinor === null) return null;
  // Keyed on the amount the booking needs: a re-read that changes it starts the controls afresh,
  // so a stale amount or promo is never charged against a different shortfall.
  return (
    <ManagerFunding
      key={view.suggestedTopUpMinor}
      view={view}
      wallet={view.wallet}
      suggestedMinor={view.suggestedTopUpMinor}
      caseSaved={caseSaved}
      ctaDisabled={ctaDisabled}
      onBeforePay={onBeforePay}
      onFunded={onFunded}
      onBack={onBack}
      onBusyChange={onBusyChange}
    />
  );
}

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import * as Sentry from '@sentry/nextjs';
import { toast } from 'sonner';
import { Loader2, Wallet } from 'lucide-react';
import { companyWorkspaceKey } from '@balo/shared/workspaces';
import { Button } from '@/components/ui/button';
import { BookingFundingBlock } from '@/components/booking/funding/booking-funding-block';
import {
  resolveFundingDisposition,
  type RefusedFundingView,
} from '@/components/booking/funding/funding-disposition';
import type { FundingContext } from '@/components/booking/funding/funding-copy';
import { useBookingFunding } from '@/components/booking/funding/use-booking-funding';
import { bookingSwitchFailedCopy } from '@/components/booking/booking-error-panels';
import { switchWorkspaceAction } from '@/lib/auth/actions/switch-workspace';
import type { BookingFundingRequest } from '@/lib/booking/actions/booking-funding-types';
import { track, CALL_NOW_EVENTS } from '@/lib/analytics';
import { CALL_NOW_COPY, START_FAILURE_COPY } from '@/lib/call-now/call-now-copy';
import { fundingGateReason } from '@/lib/call-now/call-now-funding';
import type { CallNowFundingCode } from '@/lib/call-now/call-now-types';
import type { CallSide } from '@balo/shared/meetings';

export interface CallNowFundingStepProps {
  /** Memoised by the caller: a new object each render would restart the pre-flight read. */
  readonly request: BookingFundingRequest;
  /** The side that placed the call, for the gate-shown event. */
  readonly callerLens: CallSide;
  /**
   * Whose funding this is: `call` for the person placing the call, `answer` for the person
   * answering one. Only the wording differs; both report through the call funding-gate events.
   */
  readonly context?: Extract<FundingContext, 'call' | 'answer'>;
  /** The api's refusal code: the ONE source of the gate-shown event's `reason`. */
  readonly fundingCode: CallNowFundingCode;
  /** Retries the start (or the answer) once credit is in. Resolves `true` when the call went ahead. */
  readonly onFunded: () => Promise<boolean>;
  readonly onBack: () => void;
  /** Offers "Book a time" on the member and panel arms; `null` hides it. */
  readonly onBookInstead: (() => void) | null;
  readonly onBusyChange: (busy: boolean) => void;
  /** `true` only while a payment or the retried start is genuinely running. Optional. */
  readonly onInFlightChange?: (inFlight: boolean) => void;
}

function noopInFlight(): void {}

function FundingFrame({
  title,
  body,
  children,
}: Readonly<{ title: string; body: string; children: React.ReactNode }>) {
  return (
    <section className="border-primary/20 bg-card overflow-hidden rounded-[14px] border">
      <div className="flex items-start gap-3 px-[18px] py-4">
        <span className="bg-primary/10 flex size-9 shrink-0 items-center justify-center rounded-[10px]">
          <Wallet className="text-primary size-[18px]" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h3 className="text-foreground text-[15px] leading-snug font-semibold">{title}</h3>
          <p className="text-muted-foreground mt-1 text-[13.5px] leading-relaxed">{body}</p>
        </div>
      </div>
      <div className="flex flex-col gap-2 px-[18px] pb-4 sm:flex-row-reverse">{children}</div>
    </section>
  );
}

interface FundingActionsProps {
  readonly onBack: () => void;
  readonly onBookInstead: (() => void) | null;
}

/** The two quiet exits every call-funding panel shares: back to the confirm, or book a time. */
function ExitButtons({ onBack, onBookInstead }: Readonly<FundingActionsProps>) {
  return (
    <>
      {onBookInstead !== null && (
        <Button type="button" className="min-h-11 w-full sm:w-auto" onClick={onBookInstead}>
          {CALL_NOW_COPY.bookInstead}
        </Button>
      )}
      <Button
        type="button"
        variant="outline"
        className="min-h-11 w-full sm:w-auto"
        onClick={onBack}
      >
        {CALL_NOW_COPY.back}
      </Button>
    </>
  );
}

function MemberPanel({
  view,
  onBack,
  onBookInstead,
}: Readonly<FundingActionsProps & { view: RefusedFundingView }>) {
  return (
    <FundingFrame
      title={CALL_NOW_COPY.memberFundingTitle}
      body={CALL_NOW_COPY.memberFundingBody(view.company.name ?? 'your company')}
    >
      <ExitButtons onBack={onBack} onBookInstead={onBookInstead} />
    </FundingFrame>
  );
}

/**
 * A manager whose top-up cannot run inline here (another workspace, an amount above one top-up, or
 * no wallet): send them to the top-up page, switching workspace first when the refusing company is
 * not the active one so the top-up never lands on the wrong company.
 */
function ManagerPanel({
  view,
  onBack,
  onBookInstead,
}: Readonly<FundingActionsProps & { view: RefusedFundingView }>) {
  const router = useRouter();
  const [switching, setSwitching] = useState(false);

  const handleAddCredit = useCallback(async () => {
    if (view.company.isActive) {
      router.push('/billing/top-up');
      return;
    }
    setSwitching(true);
    try {
      const result = await switchWorkspaceAction(companyWorkspaceKey(view.company.id));
      if (result.success) {
        router.push('/billing/top-up');
        return;
      }
    } catch (error) {
      Sentry.captureException(error, {
        tags: { feature: 'call_now', step: 'top_up_workspace_switch' },
        extra: { companyId: view.company.id },
      });
    }
    toast.error(bookingSwitchFailedCopy(view.company.name));
    setSwitching(false);
  }, [view.company, router]);

  const onAddCreditClick = useCallback(() => {
    handleAddCredit().catch(() => undefined);
  }, [handleAddCredit]);

  return (
    <FundingFrame title={CALL_NOW_COPY.fundTitle} body={CALL_NOW_COPY.panelFundingBody}>
      <Button
        type="button"
        className="min-h-11 w-full sm:w-auto"
        disabled={switching}
        onClick={onAddCreditClick}
      >
        {switching && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
        {CALL_NOW_COPY.addCredit}
      </Button>
      <ExitButtons onBack={onBack} onBookInstead={onBookInstead} />
    </FundingFrame>
  );
}

function FundingUnavailable({ onBack }: Readonly<{ onBack: () => void }>) {
  return (
    <FundingFrame title={CALL_NOW_COPY.fundTitle} body={START_FAILURE_COPY.funding_unavailable}>
      <Button
        type="button"
        variant="outline"
        className="min-h-11 w-full sm:w-auto"
        onClick={onBack}
      >
        {CALL_NOW_COPY.back}
      </Button>
    </FundingFrame>
  );
}

/**
 * The credit gate for a call that cannot start on the client's credit as it stands. It reuses the
 * shipped booking funding block unchanged for a billing manager, and falls back to a short panel
 * where the block cannot run (another workspace, an oversized top-up) or the viewer cannot top up
 * at all (a member). Once funded — or when the pre-flight finds credit already there — it asks the
 * caller to retry the start exactly once.
 */
export function CallNowFundingStep({
  request,
  callerLens,
  context = 'call',
  fundingCode,
  onFunded,
  onBack,
  onBookInstead,
  onBusyChange,
  onInFlightChange = noopInFlight,
}: Readonly<CallNowFundingStepProps>): React.JSX.Element {
  const { status, view } = useBookingFunding(request);
  const clearedRef = useRef(false);
  const shownRef = useRef(false);

  useEffect(() => {
    if (view?.kind !== 'clear' || clearedRef.current) return;
    clearedRef.current = true;
    onFunded().catch((error: unknown) => {
      Sentry.captureException(error, { tags: { feature: 'call_now', step: 'funding_clear' } });
    });
  }, [view, onFunded]);

  const refused = view?.kind === 'refused';
  useEffect(() => {
    if (!refused || shownRef.current) return;
    shownRef.current = true;
    track(CALL_NOW_EVENTS.FUNDING_GATE_SHOWN, {
      caller_lens: callerLens,
      reason: fundingGateReason(fundingCode),
    });
  }, [refused, callerLens, fundingCode]);

  const handleFunded = useCallback((): Promise<boolean> => {
    clearedRef.current = true;
    return onFunded();
  }, [onFunded]);

  const handleSaveForLater = useCallback((): Promise<void> => Promise.resolve(), []);
  const handleBeforePay = useCallback((): boolean => true, []);

  if (status === 'loading' || status === 'idle' || view?.kind === 'clear') {
    return (
      <div className="space-y-2" aria-busy="true">
        <div className="bg-muted h-20 w-full animate-pulse rounded-[14px] motion-reduce:animate-none" />
        <div className="bg-muted h-11 w-full animate-pulse rounded-md motion-reduce:animate-none" />
      </div>
    );
  }
  if (status === 'error' || view === null || view.kind !== 'refused') {
    return <FundingUnavailable onBack={onBack} />;
  }
  if (!view.canManageBilling) {
    return <MemberPanel view={view} onBack={onBack} onBookInstead={onBookInstead} />;
  }
  if (resolveFundingDisposition(view) === 'panel') {
    return <ManagerPanel view={view} onBack={onBack} onBookInstead={onBookInstead} />;
  }
  return (
    <BookingFundingBlock
      context={context}
      view={view}
      caseSaved={null}
      draftKept={false}
      ctaDisabled={false}
      onBeforePay={handleBeforePay}
      onFunded={handleFunded}
      onSaveForLater={handleSaveForLater}
      onBack={onBack}
      onBusyChange={onBusyChange}
      onInFlightChange={onInFlightChange}
    />
  );
}

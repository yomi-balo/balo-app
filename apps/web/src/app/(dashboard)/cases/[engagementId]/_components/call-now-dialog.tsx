'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Loader2, Phone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { CallNowFundingStep } from '@/components/balo/call-now/call-now-funding-step';
import { track, CALL_NOW_EVENTS } from '@/lib/analytics';
import type { CallNowFundingGateResolution, CallNowAbandonStep } from '@balo/analytics/events';
import type { BookingFundingRequest } from '@/lib/booking/actions/booking-funding-types';
import {
  CALL_NOW_COPY,
  START_FAILURE_COPY,
  type CallNowFailureCode,
} from '@/lib/call-now/call-now-copy';
import { callNowFundingRequest } from '@/lib/call-now/call-now-funding';
import { callNowPresence } from '@/lib/call-now/call-now-presence';
import type { CallNowConfirmView, CallNowFundingCode } from '@/lib/call-now/call-now-types';
import { callNowCallerPath } from '@/lib/call-now/ring-landing-path';
import { useCallNowSurface } from '@/lib/call-now/use-call-now-surface';
import { formatScheduledStartLabel } from '@/lib/meetings/format-scheduled-start';
import { startCallNowAction } from '../_actions/start-call-now';
import type { StartCallNowFailureCode } from '../_actions/_types/call-now-action-types';

/**
 * BAL-651 — the Call now confirm: a dialog on a desktop, a bottom sheet below 768px
 * (`call-now.jsx` ConfirmBody, `call-now-mobile.jsx` ConfirmSheet).
 *
 * Three steps: `confirm`, then `starting` (the call is being placed; closing is locked), then —
 * only when the api refuses on credit — `funding`, where the shipped funding block runs and a
 * successful top-up retries the same start.
 *
 * ⚠ NO "CANCEL" ANYWHERE. Leaving is "Not now" (or the close control, which counts as the same).
 * A call that is already ringing is stopped from the call room with "Stop calling".
 *
 * ⚠ THE ANALYTICS FOR THE FUNDING GATE ARE SPLIT: the step emits `FUNDING_GATE_SHOWN` itself,
 * and this dialog emits only `FUNDING_GATE_RESOLVED`.
 */

type Step = 'confirm' | 'starting' | 'funding';

/** Which button pair the confirm shows, from presence and whether booking is on offer. */
type ActionMode = 'call' | 'book_first' | 'anyway_first';

/** What the funding step needs from the refusal that opened it. */
interface FundingState {
  request: BookingFundingRequest;
  fundingCode: CallNowFundingCode;
}

export interface CallNowDialogProps {
  /** Minted by the entry tap; every event this dialog sends, and the start request, carry it. */
  attemptId: string;
  /**
   * The loader's presence flag, for the events' `callee_presence`. On the expert arm it is `false`
   * by construction: the api never reports a client's presence to an expert.
   */
  calleeOnline: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  calleeLabel: string;
  confirm: CallNowConfirmView;
  /** Opens the case's in-page booking. `null` when the viewer has nowhere to book. */
  onBookTime: (() => void) | null;
}

/** An action code shown as a toast sentence. Codes with no sentence of their own read as `failed`. */
function failureCopyKey(code: StartCallNowFailureCode): CallNowFailureCode {
  switch (code) {
    case 'unavailable':
    case 'in_place_not_eligible':
    case 'funding_unavailable':
    case 'venue_unavailable':
    case 'rate_limited':
    case 'session_expired':
      return code;
    default:
      return 'failed';
  }
}

/** Failures whose own sentence still applies after a top-up; the rest read as "added, try again". */
const OWN_COPY_AFTER_TOP_UP: ReadonlySet<StartCallNowFailureCode> = new Set([
  'unavailable',
  'in_place_not_eligible',
  'session_expired',
]);

function resolveActionMode(confirm: CallNowConfirmView, canBook: boolean): ActionMode {
  if (confirm.kind === 'expert_notice' || confirm.calleeOnline) return 'call';
  return canBook ? 'book_first' : 'anyway_first';
}

function ConfirmBodyText({
  confirm,
  calleeLabel,
}: Readonly<{ confirm: CallNowConfirmView; calleeLabel: string }>) {
  if (confirm.kind === 'expert_notice') {
    return <>{CALL_NOW_COPY.expertConfirm(calleeLabel)}</>;
  }
  return (
    <>
      {confirm.calleeOnline
        ? CALL_NOW_COPY.clientOnline(calleeLabel)
        : CALL_NOW_COPY.clientOffline(calleeLabel)}
    </>
  );
}

function InPlaceChoice({
  time,
  checked,
  disabled,
  onChange,
}: Readonly<{
  time: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}>) {
  const handleChange = useCallback(
    (value: boolean | 'indeterminate') => onChange(value === true),
    [onChange]
  );
  return (
    <label
      htmlFor="call-now-in-place"
      className="border-border flex min-h-11 items-start gap-3 rounded-xl border px-3 py-3"
    >
      <Checkbox
        id="call-now-in-place"
        className="mt-0.5"
        checked={checked}
        disabled={disabled}
        onCheckedChange={handleChange}
      />
      <span>
        <span className="text-foreground block text-sm leading-snug">
          {CALL_NOW_COPY.inPlace(time)}
        </span>
        <span className="text-muted-foreground mt-0.5 block text-xs leading-snug">
          {CALL_NOW_COPY.inPlaceHint}
        </span>
      </span>
    </label>
  );
}

function CallButton({
  label,
  filled,
  busy,
  disabled,
  onClick,
}: Readonly<{
  label: string;
  filled: boolean;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
}>) {
  return (
    <Button
      type="button"
      variant={filled ? 'default' : 'outline'}
      className="min-h-11 w-full gap-2 sm:w-auto"
      disabled={disabled}
      aria-busy={busy}
      onClick={onClick}
    >
      {busy ? (
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
      ) : (
        <Phone className="size-4" aria-hidden="true" />
      )}
      {label}
    </Button>
  );
}

function PlainButton({
  label,
  filled,
  disabled,
  onClick,
}: Readonly<{ label: string; filled: boolean; disabled: boolean; onClick: () => void }>) {
  return (
    <Button
      type="button"
      variant={filled ? 'default' : 'outline'}
      className="min-h-11 w-full sm:w-auto"
      disabled={disabled}
      onClick={onClick}
    >
      {label}
    </Button>
  );
}

interface ConfirmActionsProps {
  mode: ActionMode;
  starting: boolean;
  onCall: () => void;
  onNotNow: () => void;
  onBook: () => void;
}

/** The filled button leads in the DOM, so it is on top when stacked and on the right in a row. */
function ConfirmActions({
  mode,
  starting,
  onCall,
  onNotNow,
  onBook,
}: Readonly<ConfirmActionsProps>) {
  const wrapper = 'mt-1 flex flex-col gap-2 sm:flex-row-reverse sm:justify-start';
  if (mode === 'book_first') {
    return (
      <div className={wrapper}>
        <PlainButton
          label={CALL_NOW_COPY.bookInstead}
          filled
          disabled={starting}
          onClick={onBook}
        />
        <CallButton
          label={CALL_NOW_COPY.callAnyway}
          filled={false}
          busy={starting}
          disabled={starting}
          onClick={onCall}
        />
      </div>
    );
  }
  if (mode === 'anyway_first') {
    return (
      <div className={wrapper}>
        <CallButton
          label={CALL_NOW_COPY.callAnyway}
          filled
          busy={starting}
          disabled={starting}
          onClick={onCall}
        />
        <PlainButton
          label={CALL_NOW_COPY.notNow}
          filled={false}
          disabled={starting}
          onClick={onNotNow}
        />
      </div>
    );
  }
  return (
    <div className={wrapper}>
      <CallButton
        label={CALL_NOW_COPY.entry}
        filled
        busy={starting}
        disabled={starting}
        onClick={onCall}
      />
      <PlainButton
        label={CALL_NOW_COPY.notNow}
        filled={false}
        disabled={starting}
        onClick={onNotNow}
      />
    </div>
  );
}

interface ShellProps {
  isMobile: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: React.ReactNode;
  descriptionHidden: boolean;
  children: React.ReactNode;
}

/** The dialog on a desktop, the bottom sheet on a phone; the body is the same either way. */
function Shell({
  isMobile,
  open,
  onOpenChange,
  title,
  description,
  descriptionHidden,
  children,
}: Readonly<ShellProps>) {
  const descriptionClass = descriptionHidden
    ? 'sr-only'
    : 'text-foreground text-sm leading-relaxed';
  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="bottom" className="gap-3 rounded-t-3xl px-4 pt-4 pb-6">
          <SheetHeader className="p-0 pr-8">
            <SheetTitle className="text-base">{title}</SheetTitle>
            <SheetDescription className={descriptionClass}>{description}</SheetDescription>
          </SheetHeader>
          {children}
        </SheetContent>
      </Sheet>
    );
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className={descriptionClass}>{description}</DialogDescription>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}

export function CallNowDialog({
  attemptId,
  calleeOnline,
  open,
  onOpenChange,
  calleeLabel,
  confirm,
  onBookTime,
}: Readonly<CallNowDialogProps>): React.JSX.Element {
  const router = useRouter();
  const surface = useCallNowSurface();
  const isMobile = surface === 'mobile';
  const [step, setStep] = useState<Step>('confirm');
  const [replace, setReplace] = useState(true);
  const [funding, setFunding] = useState<FundingState | null>(null);
  const [fundingBusy, setFundingBusy] = useState(false);
  const replaceRef = useRef(true);
  const gateShownRef = useRef(false);
  /** The attempt whose commit has been reported: one `call_now_confirmed` per attempt. */
  const confirmedAttemptRef = useRef<string | null>(null);

  const lens = confirm.kind === 'client_terms' ? 'client' : 'expert';
  const presence = callNowPresence({ calleeOnline });
  const candidate = confirm.kind === 'client_terms' ? confirm.inPlaceCandidate : null;
  const candidateTime =
    candidate === null ? null : formatScheduledStartLabel(candidate.scheduledStartIso);
  const canBook = confirm.kind === 'client_terms' && confirm.bookInPage && onBookTime !== null;

  useEffect(() => {
    if (!open) return;
    setStep('confirm');
    setReplace(true);
    replaceRef.current = true;
    setFunding(null);
    setFundingBusy(false);
    gateShownRef.current = false;
  }, [open]);

  const handleReplaceChange = useCallback((checked: boolean) => {
    replaceRef.current = checked;
    setReplace(checked);
  }, []);

  /** Ends the funding gate once, however it ended; a no-op when no gate is showing. */
  const resolveGate = useCallback((via: CallNowFundingGateResolution) => {
    if (!gateShownRef.current) return;
    gateShownRef.current = false;
    track(CALL_NOW_EVENTS.FUNDING_GATE_RESOLVED, { via });
  }, []);

  const handleFailure = useCallback(
    (code: StartCallNowFailureCode, afterTopUp = false) => {
      toast.error(
        afterTopUp && !OWN_COPY_AFTER_TOP_UP.has(code)
          ? CALL_NOW_COPY.fundedRetryToast
          : START_FAILURE_COPY[failureCopyKey(code)]
      );
      setStep('confirm');
      if (code === 'unavailable' || code === 'in_place_not_eligible') {
        onOpenChange(false);
        router.refresh();
      }
    },
    [onOpenChange, router]
  );

  /** Places the call with the viewer's current same-day choice. `true` when the ring started. */
  const attempt = useCallback(
    async (fromFunding: boolean): Promise<boolean> => {
      const inPlace = candidate !== null && replaceRef.current;
      const result = await startCallNowAction({
        engagementId: confirm.engagementId,
        attemptId,
        ...(inPlace ? { inPlaceOfMeetingId: candidate.meetingId } : {}),
      });

      if (result.ok) {
        resolveGate(inPlace ? 'booking_in_place' : 'top_up');
        router.push(callNowCallerPath(result.meetingId, result.ringId));
        return true;
      }

      if (result.code === 'funding' && confirm.kind === 'client_terms' && !fromFunding) {
        gateShownRef.current = true;
        setFunding({
          request: callNowFundingRequest({
            expertProfileId: confirm.expertProfileId,
            engagementId: confirm.engagementId,
            nowMs: Date.now(),
          }),
          fundingCode: result.fundingCode,
        });
        setStep('funding');
        return false;
      }
      handleFailure(result.code, fromFunding);
      return false;
    },
    [attemptId, candidate, confirm, router, handleFailure, resolveGate]
  );

  // R3: the commit is the click, so it is tracked before the start resolves, and a funded retry
  // (`attempt(true)`) is the same commit and tracks nothing more. It is also tracked once per
  // attempt: going Back from the funding step and committing again sends no second event.
  // `call_anyway` is the commit from the offline confirm; every other button reads "Call now".
  const handleCall = useCallback(() => {
    if (confirmedAttemptRef.current !== attemptId) {
      confirmedAttemptRef.current = attemptId;
      track(CALL_NOW_EVENTS.CONFIRMED, {
        attempt_id: attemptId,
        lens,
        callee_presence: presence,
        choice: resolveActionMode(confirm, canBook) === 'call' ? 'call_now' : 'call_anyway',
        in_place_of_booking: candidate !== null && replaceRef.current,
        surface,
      });
    }
    setStep('starting');
    attempt(false).catch(() => handleFailure('failed'));
  }, [attemptId, lens, presence, confirm, canBook, candidate, surface, attempt, handleFailure]);

  const abandonAndClose = useCallback(
    (via: 'not_now' | 'close') => {
      const abandonStep: CallNowAbandonStep = step === 'funding' ? 'funding' : 'confirm';
      track(CALL_NOW_EVENTS.ABANDONED, {
        attempt_id: attemptId,
        lens,
        callee_presence: presence,
        step: abandonStep,
        via,
        surface,
      });
      resolveGate('abandoned');
      onOpenChange(false);
    },
    [attemptId, lens, presence, step, surface, onOpenChange, resolveGate]
  );

  const handleNotNow = useCallback(() => abandonAndClose('not_now'), [abandonAndClose]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (next) {
        onOpenChange(true);
        return;
      }
      if (step === 'starting' || fundingBusy) return;
      abandonAndClose('close');
    },
    [step, fundingBusy, onOpenChange, abandonAndClose]
  );

  // Booking instead is not an abandoned attempt: the viewer carries on to the booking.
  const leaveForBooking = useCallback(() => {
    resolveGate('abandoned');
    onOpenChange(false);
    onBookTime?.();
  }, [resolveGate, onOpenChange, onBookTime]);

  const handleBook = useCallback(() => {
    track(CALL_NOW_EVENTS.BOOK_INSTEAD_CLICKED, {
      attempt_id: attemptId,
      lens,
      from: 'confirm_offline',
      surface,
    });
    leaveForBooking();
  }, [attemptId, lens, surface, leaveForBooking]);

  const handleFundingBack = useCallback(() => setStep('confirm'), []);
  const handleFunded = useCallback(
    () =>
      attempt(true).catch(() => {
        handleFailure('failed', true);
        return false;
      }),
    [attempt, handleFailure]
  );

  // The funding step's "Book a time" is a way out of the gate, not the offline confirm's steer, so
  // it leaves for the booking without a `BOOK_INSTEAD_CLICKED`.
  const bookInstead = useMemo(() => (canBook ? leaveForBooking : null), [canBook, leaveForBooking]);

  const inFunding = step === 'funding' && funding !== null;
  const title = CALL_NOW_COPY.confirmTitle(calleeLabel);

  return (
    <Shell
      isMobile={isMobile}
      open={open}
      onOpenChange={handleOpenChange}
      title={title}
      description={
        inFunding ? (
          CALL_NOW_COPY.fundTitle
        ) : (
          <ConfirmBodyText confirm={confirm} calleeLabel={calleeLabel} />
        )
      }
      descriptionHidden={inFunding}
    >
      {inFunding ? (
        <CallNowFundingStep
          request={funding.request}
          callerLens="client"
          fundingCode={funding.fundingCode}
          onFunded={handleFunded}
          onBack={handleFundingBack}
          onBookInstead={bookInstead}
          onBusyChange={setFundingBusy}
        />
      ) : (
        <>
          {confirm.kind === 'client_terms' && (
            <p className="text-muted-foreground text-sm leading-relaxed">
              {confirm.rateLine === null
                ? CALL_NOW_COPY.clientTermsNoRate
                : CALL_NOW_COPY.clientTerms(confirm.rateLine)}
            </p>
          )}
          {candidateTime !== null && (
            <InPlaceChoice
              time={candidateTime}
              checked={replace}
              disabled={step === 'starting'}
              onChange={handleReplaceChange}
            />
          )}
          <p role="status" aria-live="polite" className="sr-only">
            {step === 'starting' ? CALL_NOW_COPY.callingTitle(calleeLabel) : ''}
          </p>
          <ConfirmActions
            mode={resolveActionMode(confirm, canBook)}
            starting={step === 'starting'}
            onCall={handleCall}
            onNotNow={handleNotNow}
            onBook={handleBook}
          />
        </>
      )}
    </Shell>
  );
}

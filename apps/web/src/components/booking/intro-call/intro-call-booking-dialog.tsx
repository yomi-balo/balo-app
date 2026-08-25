'use client';

import { useCallback, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { useIsMobile } from '@/hooks/use-mobile';
import { track, CONVERSATION_EVENTS, type ConversationCallSurface } from '@/lib/analytics';
import { bookIntroCallAction } from '@/lib/booking/actions/book-intro-call';
import type {
  BookIntroCallInput,
  IntroCallBookingFailureCode,
} from '@/lib/booking/actions/book-intro-call-types';
import { StepPickTime } from '../step-pick-time';
import { HardFailurePanel } from '../booking-error-panels';
import type { GuestDraft } from '../guest-invite-composer';
import type { AvailabilitySlotSelection } from '@/components/availability';
import { IntroCallHeader, type IntroCallStep } from './intro-call-header';
import { StepConfirmIntroCall, type ConfirmIntroCallSlot } from './step-confirm-intro-call';
import { StepBookedIntroCall } from './step-booked-intro-call';

type Phase = 'pick_time' | 'confirm' | 'booked' | 'error_hard';

interface BookedSnapshot {
  meetingId: string;
  joinPath: string;
  provisioned: boolean;
  scheduledStartIso: string;
  durationMinutes: number;
  guestsInvited: number;
  guestInviteFailed: boolean;
}

/** The booking facts the CALLER needs to re-derive its own thread state, without a refetch. */
export interface IntroCallBookedSummary {
  /**
   * ⚠ THE THREAD THE DIALOG ACTUALLY BOOKED AGAINST — echoed back rather than left for the
   * caller to re-read from its own `activeThreadId`, which a tab switch could have moved while
   * the request was in flight.
   */
  relationshipId: string;
  meetingId: string;
  scheduledStartIso: string;
}

/**
 * BAL-283 (round-1 W9) — per-failure hard-panel copy. The client path used to collapse
 * EVERYTHING that was not `slot_unavailable` into one generic "Something went wrong · Try
 * again", even though `IntroCallBookingFailureCode` distinguishes the cases and the design's edge-case
 * table specifies distinct, non-retry-inviting copy for `not_permitted`. The EXPERT path
 * already honoured this (`conversation-stage.tsx`); this is the client half catching up.
 *
 * ⚠ A LOOKUP OBJECT, NOT A CHAIN OF TERNARIES (SonarCloud S3358; the house pattern is recorded
 * on `local-date-time.tsx`). Total over the code union by TYPE, so a new failure code is a
 * compile error here rather than a silent fall-through to the generic panel.
 *
 * ⚠ NO MONEY IN ANY VARIANT (Ruling 2) — the shared default body says "Nothing was charged",
 * which is both wrong and a non-sequitur on a free call.
 */
const HARD_FAILURE_COPY: Readonly<
  Record<
    Exclude<IntroCallBookingFailureCode, 'slot_unavailable'>,
    { title: string; body: string; hideRetry: boolean }
  >
> = {
  not_permitted: {
    title: 'This request has moved on',
    body: "The call is no longer needed here. Head back to the conversation and you'll see what changed.",
    // Retrying cannot fix a decided request or a withdrawn relationship — offering it would be
    // a dead end that fails identically.
    hideRetry: true,
  },
  rate_limited: {
    title: 'Too many booking attempts',
    body: "You've booked a lot in a short window. Give it a minute, then try again.",
    hideRetry: true,
  },
  invalid_request: {
    title: "We couldn't book that time",
    body: "Something about that slot didn't add up. Pick a time again and we'll retry.",
    hideRetry: true,
  },
  booking_failed: {
    title: 'Something went wrong',
    body: "We couldn't book your call. Nothing was scheduled — try again.",
    hideRetry: false,
  },
};

/** Which visual step the header's progress indicator is on, per phase. */
const STEP_FOR_PHASE: Readonly<Record<Phase, IntroCallStep>> = {
  pick_time: 'pick_time',
  confirm: 'confirm',
  booked: 'booked',
  error_hard: 'confirm',
};

const pageTransition = {
  initial: { opacity: 0, x: 16 },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: -16 },
  transition: { duration: 0.2, ease: 'easeInOut' as const },
};

function randomNonce(): string {
  return crypto.randomUUID();
}

export interface IntroCallBookingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  requestId: string;
  relationshipId: string;
  expertProfileId: string;
  expertName: string;
  expertFirstName: string | null;
  expertInitials: string;
  requestTitle: string;
  clientCompanyName: string | null;
  viewerEmailDomain: string | null;
  viewerTimezone: string;
  /** Which surface opened the dialog — analytics only, never authorization. */
  surface: ConversationCallSurface;
  /**
   * Called once, after a successful booking, WITH the booked meeting's facts.
   *
   * ⚠ IT CARRIES A PAYLOAD ON PURPOSE (round-1 C1). A bare `() => void` left the caller with
   * only `router.refresh()`, and a refresh PRESERVES client component state by design — so the
   * client's thread kept `bookedCall === null`, the CTA never disappeared, the nudge never
   * became the done cell, and a second call could be booked immediately. The caller flips its
   * own thread optimistically from this.
   */
  onBooked: (booked: IntroCallBookedSummary) => void;
  /** Closes the dialog AND focuses the message composer (the calendar's `emptyAction` escape). */
  onMessage: () => void;
}

/**
 * BAL-283 — `IntroCallBookingDialog` (plan §12.1/§12.5). A NEW ~200-line sibling of
 * `BookingFlowDialog`, not a third `entry` arm on it: that container is 858 lines with a
 * six-member `Phase` union and reads `entry.mode === 'fixed_case'` in five places; a third arm
 * would thread `null` through every one of them (the same "80% dead branches" argument the
 * design makes for `StepConfirm`, applied to the container).
 *
 * Phases: `pick_time → confirm → booked`, plus `error_hard`. NO `onboarding` phase (no
 * credit-eligibility gate exists for an unbilled call) and NO `error_partial` (there is no
 * case to half-create — Ruling 2, no money anywhere on this surface).
 *
 * ⚠ KNOWN GAP, DELIBERATELY NOT FIXED HERE — NO FOCUS MANAGEMENT ACROSS PHASE TRANSITIONS
 * (BAL-283 round 1, UX-3). On `pick_time → confirm → booked` the focused element unmounts and
 * focus drops to `<body>`, so a keyboard user must re-tab from the top of the dialog on every
 * step. It is INHERITED, not introduced: `BookingFlowDialog` (BAL-400) has the identical gap
 * with the identical `AnimatePresence mode="wait"` structure. Fixing it in one place only would
 * leave the two booking dialogs behaving differently for exactly the users who most need them
 * to agree, so it is deferred to a follow-up ticket covering BOTH. The axe sweep in
 * `intro-call-booking-dialog.a11y.test.tsx` covers every other shape and would catch a
 * regression in the markup itself.
 */
export function IntroCallBookingDialog({
  open,
  onOpenChange,
  requestId,
  relationshipId,
  expertProfileId,
  expertName,
  expertFirstName,
  expertInitials,
  requestTitle,
  clientCompanyName,
  viewerEmailDomain,
  viewerTimezone,
  surface,
  onBooked,
  onMessage,
}: Readonly<IntroCallBookingDialogProps>): React.JSX.Element | null {
  const isMobile = useIsMobile(768);
  const [phase, setPhase] = useState<Phase>('pick_time');
  const [slot, setSlot] = useState<ConfirmIntroCallSlot | null>(null);
  const [guests, setGuests] = useState<readonly GuestDraft[]>([]);
  const [staleSlot, setStaleSlot] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [bookedResult, setBookedResult] = useState<BookedSnapshot | null>(null);
  // Which failure produced `error_hard` — drives the panel's copy and whether Retry is offered.
  const [failureCode, setFailureCode] =
    useState<Exclude<IntroCallBookingFailureCode, 'slot_unavailable'>>('booking_failed');
  const nonceRef = useRef<string>(randomNonce());

  const resetForReopen = useCallback((): void => {
    setPhase('pick_time');
    setSlot(null);
    setGuests([]);
    setStaleSlot(false);
    setSubmitting(false);
    setBookedResult(null);
    setFailureCode('booking_failed');
    nonceRef.current = randomNonce();
  }, []);

  const handleClose = useCallback((): void => {
    onOpenChange(false);
    resetForReopen();
  }, [onOpenChange, resetForReopen]);

  const handleSlotSelect = useCallback((selection: AvailabilitySlotSelection): void => {
    setSlot({
      startIso: selection.start,
      endIso: selection.end,
      durationMinutes: selection.duration,
    });
    setStaleSlot(false);
    setPhase('confirm');
  }, []);

  const handleChangeTime = useCallback((): void => {
    setStaleSlot(false);
    setPhase('pick_time');
  }, []);

  const handleSubmit = useCallback(async (): Promise<void> => {
    if (slot === null || submitting) return;
    setSubmitting(true);
    setStaleSlot(false);

    const input: BookIntroCallInput = {
      requestId,
      relationshipId,
      slot,
      bookingNonce: nonceRef.current,
      guests: guests.map((g) => ({ email: g.email, name: g.name })),
      surface,
    };

    try {
      const result = await bookIntroCallAction(input);
      if (!result.ok) {
        if (result.code === 'slot_unavailable') {
          setStaleSlot(true);
          setSubmitting(false);
          return;
        }
        setFailureCode(result.code);
        setPhase('error_hard');
        setSubmitting(false);
        return;
      }

      setBookedResult({
        meetingId: result.meetingId,
        joinPath: result.joinPath,
        provisioned: result.provisioned,
        scheduledStartIso: result.scheduledStartIso,
        durationMinutes: result.durationMinutes,
        guestsInvited: result.guestsInvited,
        guestInviteFailed: result.guestInviteFailed,
      });
      track(CONVERSATION_EVENTS.CONVERSATION_INTRO_CALL_BOOKED, {
        request_id: requestId,
        relationship_id: relationshipId,
        expert_profile_id: expertProfileId,
        surface,
        duration_minutes: result.durationMinutes,
        guest_count: guests.length,
        provisioned: result.provisioned,
      });
      toast.success('Booked', {
        description: `${result.durationMinutes}-minute intro call with ${expertFirstName ?? expertName} confirmed.`,
      });
      setPhase('booked');
      setSubmitting(false);
      onBooked({
        relationshipId,
        meetingId: result.meetingId,
        scheduledStartIso: result.scheduledStartIso,
      });
    } catch {
      setFailureCode('booking_failed');
      setPhase('error_hard');
      setSubmitting(false);
    }
  }, [
    slot,
    submitting,
    requestId,
    relationshipId,
    guests,
    surface,
    expertProfileId,
    expertFirstName,
    expertName,
    onBooked,
  ]);

  if (!open) return null;

  const step: IntroCallStep = STEP_FOR_PHASE[phase];
  const hardFailure = HARD_FAILURE_COPY[failureCode];

  const body = (
    <div className="flex h-full flex-col">
      <IntroCallHeader expertName={expertName} expertInitials={expertInitials} step={step} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <AnimatePresence mode="wait">
          {phase === 'pick_time' && (
            <motion.div key="pick_time" {...pageTransition}>
              <StepPickTime
                expertProfileId={expertProfileId}
                expertFirstName={expertFirstName}
                onSlotSelect={handleSlotSelect}
                onMessage={onMessage}
              />
            </motion.div>
          )}
          {phase === 'confirm' && slot !== null && (
            <motion.div key="confirm" {...pageTransition}>
              <StepConfirmIntroCall
                slot={slot}
                viewerTimezone={viewerTimezone}
                requestTitle={requestTitle}
                onChangeTime={handleChangeTime}
                guests={guests}
                onGuestsChange={setGuests}
                viewerEmailDomain={viewerEmailDomain}
                clientCompanyName={clientCompanyName}
                staleSlot={staleSlot}
                submitting={submitting}
                onBack={handleChangeTime}
                onSubmit={() => {
                  handleSubmit().catch(() => {});
                }}
              />
            </motion.div>
          )}
          {phase === 'booked' && bookedResult !== null && (
            <motion.div key="booked" {...pageTransition}>
              <StepBookedIntroCall
                expertFirstName={expertFirstName}
                startIso={bookedResult.scheduledStartIso}
                viewerTimezone={viewerTimezone}
                durationMinutes={bookedResult.durationMinutes}
                provisioned={bookedResult.provisioned}
                joinPath={bookedResult.joinPath}
                guestsInvited={bookedResult.guestsInvited}
                guestInviteFailed={bookedResult.guestInviteFailed}
                onDone={handleClose}
              />
            </motion.div>
          )}
          {phase === 'error_hard' && (
            <motion.div key="error_hard" {...pageTransition}>
              <HardFailurePanel
                title={hardFailure.title}
                body={hardFailure.body}
                hideRetry={hardFailure.hideRetry}
                onRetry={() => {
                  setPhase('confirm');
                  handleSubmit().catch(() => {});
                }}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={(next) => !next && handleClose()}>
        <SheetContent side="bottom" className="max-h-[94dvh] overflow-hidden rounded-t-2xl p-0">
          <SheetTitle className="sr-only">Book an intro call with {expertName}</SheetTitle>
          <SheetDescription className="sr-only">
            Pick a time — this is a free intro call, no commitment.
          </SheetDescription>
          {body}
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && handleClose()}>
      <DialogContent className="max-h-[85vh] overflow-hidden rounded-xl p-0 sm:max-w-[640px]">
        <DialogTitle className="sr-only">Book an intro call with {expertName}</DialogTitle>
        <DialogDescription className="sr-only">
          Pick a time — this is a free intro call, no commitment.
        </DialogDescription>
        {body}
      </DialogContent>
    </Dialog>
  );
}

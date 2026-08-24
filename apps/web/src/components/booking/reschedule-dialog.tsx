'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { toast } from 'sonner';
import * as Sentry from '@sentry/nextjs';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { useIsMobile } from '@/hooks/use-mobile';
import { track, BOOKING_EVENTS } from '@/lib/analytics';
import { SLOT_DURATION_LADDER, type SlotDurationMinutes } from '@balo/shared/availability';
import {
  ExpertAvailabilityCalendar,
  type AvailabilitySlotSelection,
} from '@/components/availability';
import { LocalDateTime } from '@/components/balo/date/local-date-time';
import { rescheduleConsultationAction } from '@/app/(dashboard)/cases/[engagementId]/_actions/reschedule-consultation';
import type { RescheduleFailureCode } from '@/app/(dashboard)/cases/[engagementId]/_actions/_types/case-action-types';

/**
 * BAL-409 — the client-initiated reschedule dialog. Wires the ALREADY-SHIPPED BAL-236 slot
 * picker into the ALREADY-SHIPPED BAL-421 case surface. There is no new screen (D-E — Phase 0
 * design was deliberately skipped for this reason).
 *
 * ⚠ NOT a third `BookingEntry` arm on `BookingFlowDialog` — that flow drags in case choice,
 * products, guests and billing-company resolution, none of which apply to MOVING an existing
 * booking.
 *
 * Structure copies the house pattern from `booking-flow-dialog.tsx`: desktop `Dialog` / mobile
 * `Sheet` via `useIsMobile(768)` — never a right-edge `Drawer`. Two steps with
 * `AnimatePresence` + a shared page transition.
 */

const pageTransition = {
  initial: { opacity: 0, x: 16 },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: -16 },
  transition: { duration: 0.2, ease: 'easeInOut' as const },
};

type Step = 'pick_time' | 'confirm';

export interface RescheduleDialogProps {
  open: boolean;
  onClose: () => void;
  /** Called after a successful move — the caller refreshes the page and closes the dialog. */
  onRescheduled: () => void;
  /**
   * N14(c) — called INSTEAD OF `onClose` when the dialog closes itself after a TERMINAL,
   * no-longer-actionable failure (`meeting_not_reschedulable` / `meeting_not_found` —
   * `copyForFailure`'s `closeOnAcknowledge: true` codes). Before this, `resetAndClose()` always
   * called plain `onClose`, which on the case surface is JUST `setRescheduleOpen(false)` — no
   * refresh. The case's CTA/nudge is now stale (the meeting that was reschedulable a moment ago
   * no longer is, or is gone), so it kept inviting a click that would fail again with the exact
   * same error, with nothing explaining why. Falls back to `onClose` when omitted, so this is
   * additive and every existing caller keeps compiling.
   */
  onTerminalFailure?: () => void;
  engagementId: string;
  meetingId: string;
  expertProfileId: string;
  /** The meeting's CURRENT scheduled start, ISO — rendered as the "from" side of the confirm step. */
  currentScheduledStartIso: string;
  /** The meeting's CURRENT length, minutes — pins the picker (D-A item 4); the server pins the
   *  actual write regardless of what the picker returns. */
  durationMinutes: number;
  caseTitle: string;
}

/** Server-literal → user copy. Never echoes a server literal verbatim. */
function copyForFailure(code: RescheduleFailureCode): {
  message: string;
  closeOnAcknowledge: boolean;
} {
  switch (code) {
    case 'slot_unavailable':
      return { message: 'That time was just taken. Pick another.', closeOnAcknowledge: false };
    case 'meeting_not_reschedulable':
      return {
        message: 'This consultation can no longer be moved.',
        closeOnAcknowledge: true,
      };
    case 'meeting_not_found':
      return { message: "We couldn't find that consultation.", closeOnAcknowledge: true };
    case 'rate_limited':
      return {
        message: 'Too many changes just now — try again shortly.',
        closeOnAcknowledge: false,
      };
    case 'unauthenticated':
    case 'invalid_request':
    case 'not_permitted':
    case 'unknown':
    default:
      return { message: 'Something went wrong. Please try again.', closeOnAcknowledge: false };
  }
}

function hoursBetween(fromIso: string, toIso: string): number {
  const diffMs = Math.abs(new Date(toIso).getTime() - new Date(fromIso).getTime());
  return Math.round(diffMs / 3_600_000);
}

export function RescheduleDialog({
  open,
  onClose,
  onRescheduled,
  onTerminalFailure,
  engagementId,
  meetingId,
  expertProfileId,
  currentScheduledStartIso,
  durationMinutes,
  caseTitle,
}: Readonly<RescheduleDialogProps>): React.JSX.Element {
  const isMobile = useIsMobile(768);
  const [step, setStep] = useState<Step>('pick_time');
  const [picked, setPicked] = useState<AvailabilitySlotSelection | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Bumped on a `slot_unavailable` retry so the picker REMOUNTS and re-fetches rather than
  // re-showing the stale list that included the now-taken slot.
  const [pickerKey, setPickerKey] = useState(0);

  /**
   * N14(b) — FOCUS FOLLOWS THE STEP, mirroring `availability-slots-panel.tsx`'s `backRef`/
   * `headingRef` pattern one level down. Before this, neither step transition moved focus:
   * `pick_time → confirm` UNMOUNTS the picker button focus was just on, and `confirm →
   * pick_time` (via "Choose a different time") unmounts THAT button — either way, focus falls
   * silently back to `<body>`, and a keyboard or screen-reader user loses their place at both
   * transitions of this two-step flow. `hasTransitionedRef` guards the FIRST render (`step`
   * starts at `'pick_time'` and nothing has transitioned yet) so mounting the dialog never
   * steals focus from wherever the "Reschedule" click left it.
   */
  const backButtonRef = useRef<HTMLButtonElement>(null);
  const pickTimeHeadingRef = useRef<HTMLHeadingElement>(null);
  const hasTransitionedRef = useRef(false);
  useEffect(() => {
    if (!hasTransitionedRef.current) {
      hasTransitionedRef.current = true;
      return;
    }
    if (step === 'confirm') {
      backButtonRef.current?.focus();
    } else {
      pickTimeHeadingRef.current?.focus();
    }
  }, [step]);

  // A4 — only pin the picker's filter when the CURRENT duration is a real ladder value. A
  // seeded/admin-created meeting off-ladder omits the prop; the picker renders its normal
  // free-choice pills and the server still pins the length regardless.
  const fixedDurationMinutes: SlotDurationMinutes | undefined = (
    SLOT_DURATION_LADDER as readonly number[]
  ).includes(durationMinutes)
    ? (durationMinutes as SlotDurationMinutes)
    : undefined;

  /**
   * N14(c) — `terminal: true` routes to `onTerminalFailure` (falling back to `onClose`) instead
   * of always `onClose`. See the prop's own docblock for why: a terminal failure means the case
   * surface's CTA is stale and must refresh, not just dismiss.
   */
  const resetAndClose = useCallback(
    (options?: { terminal?: boolean }) => {
      setStep('pick_time');
      setPicked(null);
      setSubmitting(false);
      if (options?.terminal === true && onTerminalFailure) {
        onTerminalFailure();
      } else {
        onClose();
      }
    },
    [onClose, onTerminalFailure]
  );

  const handleSlotSelect = useCallback((selection: AvailabilitySlotSelection) => {
    setPicked(selection);
    setStep('confirm');
  }, []);

  /**
   * N14(a) — HONEST ABOUT WHAT IT DOES. `AnimatePresence mode="wait"` renders `pick_time` and
   * `confirm` as MUTUALLY EXCLUSIVE children by construction, so "Back" UNMOUNTS
   * `<ExpertAvailabilityCalendar>` — its selected day/slot/duration-filter state is gone, and
   * the picker remounts fresh. Keeping it mounted (hidden via CSS instead) would mean
   * duplicating the whole two-step layout and animation choreography for a "resume where I left
   * off" affordance nobody asked for on a two-tap flow. The button is labelled for what it
   * actually does instead of what "Back" implies.
   */
  const handleBack = useCallback(() => {
    setStep('pick_time');
    setPicked(null);
  }, []);

  const handleConfirm = useCallback((): void => {
    if (picked === null || submitting) return;
    setSubmitting(true);

    (async () => {
      const result = await rescheduleConsultationAction({
        engagementId,
        meetingId,
        startIso: picked.start,
      });

      if (!result.success) {
        const { message, closeOnAcknowledge } = copyForFailure(result.code);
        toast.error(message);
        if (result.code === 'unknown') {
          Sentry.captureException(new Error(`reschedule failed: ${result.code}`));
        }
        setSubmitting(false);
        if (closeOnAcknowledge) {
          // `closeOnAcknowledge: true` ⇒ `meeting_not_reschedulable` / `meeting_not_found` —
          // both TERMINAL (see N14(c) on `resetAndClose` and the prop docblock).
          resetAndClose({ terminal: true });
        } else if (result.code === 'slot_unavailable') {
          setStep('pick_time');
          setPicked(null);
          setPickerKey((key) => key + 1);
        }
        return;
      }

      track(BOOKING_EVENTS.RESCHEDULED, {
        initiated_by: 'client',
        hours_before_start: hoursBetween(new Date().toISOString(), currentScheduledStartIso),
      });
      // N5 — the SAME viewer-local component the dialog itself uses two lines up
      // (`<LocalDateTime>`, `day-month-time`), never a raw `toUTCString()`. `toUTCString()`
      // renders a GMT string like "Tue, 08 Sep 2026 10:00:00 GMT" straight to the user — the
      // one thing this whole dialog otherwise takes care never to do.
      toast.success('Consultation moved', {
        description: (
          <>
            New time: <LocalDateTime iso={result.scheduledStart} variant="day-month-time" />
          </>
        ),
      });
      setSubmitting(false);
      setStep('pick_time');
      setPicked(null);
      onRescheduled();
    })().catch((error: unknown) => {
      toast.error('Something went wrong. Please try again.');
      Sentry.captureException(error);
      setSubmitting(false);
    });
  }, [
    picked,
    submitting,
    engagementId,
    meetingId,
    currentScheduledStartIso,
    onRescheduled,
    resetAndClose,
  ]);

  const body = (
    <div className="flex min-h-[420px] flex-col p-6">
      <AnimatePresence mode="wait">
        {step === 'pick_time' && (
          <motion.div key="pick_time" {...pageTransition}>
            {/* N14(b) — `tabIndex={-1}`: programmatically focusable (where focus lands after
                "Choose a different time" or a slot_unavailable retry) without entering the tab
                order, matching `availability-slots-panel.tsx`'s `headingRef` convention. */}
            <h2
              ref={pickTimeHeadingRef}
              tabIndex={-1}
              className="text-foreground mb-1 text-base font-semibold"
            >
              Reschedule consultation
            </h2>
            <p className="text-muted-foreground mb-4 text-sm">
              Pick a new time with the expert on {caseTitle} — same length, same link.
            </p>
            <ExpertAvailabilityCalendar
              key={pickerKey}
              expertProfileId={expertProfileId}
              mode="selectable"
              viewerType="client"
              fixedDurationMinutes={fixedDurationMinutes}
              onSlotSelect={handleSlotSelect}
            />
          </motion.div>
        )}
        {step === 'confirm' && picked !== null && (
          <motion.div key="confirm" {...pageTransition} className="flex flex-1 flex-col">
            <h2 className="text-foreground mb-4 text-base font-semibold">Confirm the new time</h2>
            <div className="border-border bg-muted/30 mb-2 rounded-lg border px-4 py-3">
              <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                Currently
              </p>
              <p className="text-foreground text-sm">
                <LocalDateTime iso={currentScheduledStartIso} variant="day-month-time" />
              </p>
            </div>
            <div className="border-primary/30 bg-primary/5 mb-5 rounded-lg border px-4 py-3">
              <p className="text-primary text-xs font-medium tracking-wide uppercase">Moving to</p>
              <p className="text-primary text-sm font-semibold">
                <LocalDateTime iso={picked.start} variant="day-month-time" />
              </p>
            </div>
            <p className="text-muted-foreground mb-5 text-sm">
              Same length, same link — nothing else about this consultation changes.
            </p>
            <div className="mt-auto flex gap-2">
              <Button
                ref={backButtonRef}
                type="button"
                variant="outline"
                onClick={handleBack}
                disabled={submitting}
              >
                {/* N14(a) — "Choose a different time", not "Back": the picker REMOUNTS fresh
                    (mutually exclusive `AnimatePresence` children), so this is honest about
                    starting the pick over rather than implying a resumable history stack. */}
                Choose a different time
              </Button>
              <Button
                type="button"
                className="flex-1"
                onClick={handleConfirm}
                disabled={submitting}
              >
                {submitting ? 'Moving…' : 'Move consultation'}
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={(next) => !next && resetAndClose()}>
        <SheetContent side="bottom" className="max-h-[94dvh] overflow-hidden rounded-t-2xl p-0">
          <SheetTitle className="sr-only">Reschedule consultation</SheetTitle>
          <SheetDescription className="sr-only">
            Pick a new time for this consultation and confirm the move.
          </SheetDescription>
          {body}
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && resetAndClose()}>
      <DialogContent className="max-h-[85vh] overflow-hidden rounded-xl p-0 sm:max-w-[560px]">
        <DialogTitle className="sr-only">Reschedule consultation</DialogTitle>
        <DialogDescription className="sr-only">
          Pick a new time for this consultation and confirm the move.
        </DialogDescription>
        {body}
      </DialogContent>
    </Dialog>
  );
}

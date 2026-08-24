'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { toast } from 'sonner';
import * as Sentry from '@sentry/nextjs';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { useIsMobile } from '@/hooks/use-mobile';
import { track, BOOKING_EVENTS } from '@/lib/analytics';
import { SLOT_DURATION_LADDER, type SlotDurationMinutes } from '@balo/shared/availability';
import { RESCHEDULE_PROPOSAL_MAX_OPTIONS } from '@balo/shared/meetings';
import {
  ExpertAvailabilityCalendar,
  type AvailabilitySlotSelection,
} from '@/components/availability';
import { LocalDateTime } from '@/components/balo/date/local-date-time';
import { proposeRescheduleAction } from '@/app/(dashboard)/cases/[engagementId]/_actions/propose-reschedule';
import { isTerminalProposalFailure } from '@/lib/meetings/is-terminal-proposal-failure';

/**
 * BAL-411 (§Component architecture) — the EXPERT's ≤3-slot picker.
 *
 * COMPOSES the shipped single-select `ExpertAvailabilityCalendar` — it does NOT change it
 * (that component is shared with the booking flow and is single-select by construction). Each
 * `onSlotSelect` appends to a local `picked` list (max
 * `RESCHEDULE_PROPOSAL_MAX_OPTIONS`), then bumps `pickerKey` to REMOUNT the calendar so the
 * next pick starts fresh — the `reschedule-dialog.tsx` precedent. `fixedDurationMinutes` is
 * pinned exactly the same way: a reschedule (proposed or direct) MOVES a booking, it does not
 * resize it, and the server re-pins the length regardless of what the picker returns.
 *
 * Once the max is reached, the calendar is replaced by a note — "remove one to add another" —
 * rather than trying to teach `ExpertAvailabilityCalendar` a `max` concept it was never built
 * for.
 */

export interface ProposeTimesDialogProps {
  open: boolean;
  onClose: () => void;
  /** Called after a successful propose — the caller refreshes the page and closes the dialog. */
  onProposed: () => void;
  engagementId: string;
  meetingId: string;
  expertProfileId: string;
  /** The meeting's CURRENT scheduled start, ISO — for the `hours_before_start` analytics prop. */
  currentScheduledStartIso: string;
  /** The meeting's CURRENT length, minutes — pins the picker; the server pins the write. */
  durationMinutes: number;
  caseTitle: string;
}

function hoursBetween(fromIso: string, toIso: string): number {
  return Math.round(Math.abs(new Date(toIso).getTime() - new Date(fromIso).getTime()) / 3_600_000);
}

export function ProposeTimesDialog({
  open,
  onClose,
  onProposed,
  engagementId,
  meetingId,
  expertProfileId,
  currentScheduledStartIso,
  durationMinutes,
  caseTitle,
}: Readonly<ProposeTimesDialogProps>): React.JSX.Element {
  const isMobile = useIsMobile(768);
  const [picked, setPicked] = useState<AvailabilitySlotSelection[]>([]);
  const [submitting, setSubmitting] = useState(false);
  // Bumped on every accepted pick (and on a retry) so the picker REMOUNTS and re-fetches
  // rather than re-showing a list that already includes a just-picked or just-lost slot.
  const [pickerKey, setPickerKey] = useState(0);

  const fixedDurationMinutes: SlotDurationMinutes | undefined = (
    SLOT_DURATION_LADDER as readonly number[]
  ).includes(durationMinutes)
    ? (durationMinutes as SlotDurationMinutes)
    : undefined;

  /**
   * Item 20 — the `reschedule-dialog.tsx` precedent (`backButtonRef`/`headingRef`), applied to
   * this dialog's ONE transition: hitting the `RESCHEDULE_PROPOSAL_MAX_OPTIONS` cap UNMOUNTS
   * `ExpertAvailabilityCalendar` in place of a `<p>` note. The click that triggered it came
   * from a button INSIDE the calendar, and that node is now gone — without this, focus falls
   * silently to `<body>` with no announcement to a keyboard or screen-reader user. The reverse
   * transition (removing a pick to drop back under the cap) returns focus to the dialog's own
   * heading — the one anchor stable across both states. `hasTransitionedRef` guards the FIRST
   * render so mounting/opening the dialog never steals focus from wherever the "Propose a new
   * time" click left it.
   */
  const capNoteRef = useRef<HTMLParagraphElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const hasTransitionedRef = useRef(false);

  const resetAndClose = useCallback(() => {
    setPicked([]);
    setSubmitting(false);
    setPickerKey((key) => key + 1);
    onClose();
  }, [onClose]);

  const handleSlotSelect = useCallback((selection: AvailabilitySlotSelection) => {
    setPicked((prev) => {
      if (prev.some((existing) => existing.start === selection.start)) return prev;
      return [...prev, selection].slice(0, RESCHEDULE_PROPOSAL_MAX_OPTIONS);
    });
    setPickerKey((key) => key + 1);
  }, []);

  const handleRemove = useCallback((start: string) => {
    setPicked((prev) => prev.filter((option) => option.start !== start));
  }, []);

  const handleSend = useCallback((): void => {
    if (picked.length === 0 || submitting) return;
    setSubmitting(true);

    (async () => {
      const result = await proposeRescheduleAction({
        engagementId,
        meetingId,
        optionStartIsos: picked.map((option) => option.start),
      });

      if (!result.success) {
        toast.error(result.error);
        setSubmitting(false);
        if (result.code === 'slot_unavailable') {
          // One of the picked slots was taken between pick and send — reset the picker so the
          // stale list (which included the now-taken slot) is not re-shown.
          setPicked([]);
          setPickerKey((key) => key + 1);
        } else if (isTerminalProposalFailure(result.code)) {
          // BAL-409's `copyForFailure`/`closeOnAcknowledge` precedent, carried over: the state
          // this dialog was rendered from is gone — close and refresh instead of re-offering a
          // Send that will fail again with the exact same error.
          resetAndClose();
          onProposed();
        }
        return;
      }

      track(BOOKING_EVENTS.RESCHEDULE_PROPOSED, {
        proposal_id: result.proposalId,
        option_count: result.options.length,
        hours_before_start: hoursBetween(new Date().toISOString(), currentScheduledStartIso),
      });
      toast.success(
        result.options.length === 1 ? 'Time proposed' : `${result.options.length} times proposed`,
        { description: 'Your client can accept one, or keep the original time.' }
      );
      setSubmitting(false);
      resetAndClose();
      onProposed();
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
    onProposed,
    resetAndClose,
  ]);

  const atMax = picked.length >= RESCHEDULE_PROPOSAL_MAX_OPTIONS;

  useEffect(() => {
    if (!hasTransitionedRef.current) {
      hasTransitionedRef.current = true;
      return;
    }
    if (atMax) {
      capNoteRef.current?.focus();
    } else {
      headingRef.current?.focus();
    }
  }, [atMax]);

  const sendButtonLabel = picked.length > 0 ? `Send proposal (${picked.length})` : 'Send proposal';

  const body = (
    <div className="flex min-h-[420px] flex-col p-6">
      <h2
        ref={headingRef}
        tabIndex={-1}
        className="text-foreground mb-1 text-base font-semibold focus-visible:outline-none"
      >
        Propose new times
      </h2>
      <p className="text-muted-foreground mb-4 text-sm">
        Suggest up to {RESCHEDULE_PROPOSAL_MAX_OPTIONS} alternative times for {caseTitle}. Your
        client picks one, or keeps the original time — nothing moves until they answer.
      </p>

      {picked.length > 0 && (
        <ul className="mb-3 list-none space-y-2">
          {picked.map((option) => (
            <li
              key={option.start}
              className="border-border bg-muted/30 flex items-center justify-between rounded-lg border px-3 py-2 text-sm"
            >
              <LocalDateTime iso={option.start} variant="day-month-time" />
              {/* Item 21 — `size="icon-sm"` grows the hit area to 32×32px without changing the
                  icon's own size (the skill's 44×44px minimum rule; a bare 14px `<X>` with no
                  padding was the one un-tokenized, hard-to-hit control on this card). */}
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => handleRemove(option.start)}
                aria-label="Remove this time"
                className="text-muted-foreground hover:text-foreground"
              >
                <X size={14} aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      {atMax ? (
        <p
          ref={capNoteRef}
          tabIndex={-1}
          className="text-muted-foreground text-sm focus-visible:outline-none"
        >
          You&apos;ve picked the maximum of {RESCHEDULE_PROPOSAL_MAX_OPTIONS} times. Remove one
          above to pick a different time.
        </p>
      ) : (
        <ExpertAvailabilityCalendar
          key={pickerKey}
          expertProfileId={expertProfileId}
          mode="selectable"
          viewerType="expert"
          fixedDurationMinutes={fixedDurationMinutes}
          onSlotSelect={handleSlotSelect}
        />
      )}

      <div className="mt-auto flex gap-2 pt-4">
        <Button type="button" variant="outline" onClick={resetAndClose} disabled={submitting}>
          Cancel
        </Button>
        <Button
          type="button"
          className="flex-1"
          onClick={handleSend}
          disabled={submitting || picked.length === 0}
        >
          {submitting ? 'Sending…' : sendButtonLabel}
        </Button>
      </div>
    </div>
  );

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={(next) => !next && resetAndClose()}>
        <SheetContent side="bottom" className="max-h-[94dvh] overflow-hidden rounded-t-2xl p-0">
          <SheetTitle className="sr-only">Propose new times</SheetTitle>
          <SheetDescription className="sr-only">
            Pick up to three alternative times and send them to your client.
          </SheetDescription>
          {body}
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && resetAndClose()}>
      <DialogContent className="max-h-[85vh] overflow-hidden rounded-xl p-0 sm:max-w-[560px]">
        <DialogTitle className="sr-only">Propose new times</DialogTitle>
        <DialogDescription className="sr-only">
          Pick up to three alternative times and send them to your client.
        </DialogDescription>
        {body}
      </DialogContent>
    </Dialog>
  );
}

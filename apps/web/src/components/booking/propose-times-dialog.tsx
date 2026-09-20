'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
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
import { AvailabilitySkeleton } from '@/components/availability/availability-states';
import { LocalDateTime } from '@/components/balo/date/local-date-time';
import { proposeRescheduleAction } from '@/app/(dashboard)/cases/[engagementId]/_actions/propose-reschedule';
import { isTerminalProposalFailure } from '@/lib/meetings/is-terminal-proposal-failure';
import { localDayKey } from './suggest-times';
import { SuggestedTimesList, SuggestedTimesBackLink } from './suggested-times-list';
import { useSuggestedTimesPicker } from './use-suggested-times-picker';

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
 *
 * ⚠ Terminal failures route through `onTerminalFailure` rather than falling back to
 * `focusTrigger`, because `focusTrigger(selection.meetingId)` is a silent no-op for
 * `meeting_not_found` / `case_closed`, where the row itself may already be gone.
 *
 * ⚠ THE SAME SUGGESTED-FIRST VIEW AS `RescheduleDialog`, except a pick ADDS to `picked` instead
 * of advancing a step. Suggestions exclude any day already IN `picked` — three options
 * should be three different days, not 6:00 and 6:15 on the same evening — and once picking has
 * exhausted every suggested day the calendar takes over automatically, not only on "See more
 * times": `showingCalendar` re-derives from `suggestions.length` on every render, it is never a
 * one-time decision the way the FIRST view is.
 */

export interface ProposeTimesDialogProps {
  open: boolean;
  onClose: () => void;
  /** Called after a successful propose — the caller refreshes the page and closes the dialog. */
  onProposed: () => void;
  /** Called instead of `onClose` after a terminal, no-longer-actionable failure. Falls back to
   *  `onClose` when omitted — mirrors `CancelConsultationDialogProps.onTerminalFailure`. */
  onTerminalFailure?: () => void;
  engagementId: string;
  meetingId: string;
  expertProfileId: string;
  /** The meeting's CURRENT scheduled start, ISO — for the `hours_before_start` analytics prop. */
  currentScheduledStartIso: string;
  /** The meeting's CURRENT length, minutes — pins the picker; the server pins the write. */
  durationMinutes: number;
  caseTitle: string;
  /** 1-based, or `null`. With a menu on every upcoming row, Propose isn't only ever about "the"
   *  meeting the nudge names — this identifies which one. */
  ordinal: number | null;
  /** Where a terminal close sends focus (optional; omitting it keeps Radix's default restore) —
   *  the `reschedule-dialog.tsx` / `cancel-consultation-dialog.tsx` `onCloseAutoFocus` pattern. */
  headingRef?: RefObject<HTMLElement | null>;
}

function hoursBetween(fromIso: string, toIso: string): number {
  return Math.round(Math.abs(new Date(toIso).getTime() - new Date(fromIso).getTime()) / 3_600_000);
}

export function ProposeTimesDialog({
  open,
  onClose,
  onProposed,
  onTerminalFailure,
  engagementId,
  meetingId,
  expertProfileId,
  currentScheduledStartIso,
  durationMinutes,
  caseTitle,
  ordinal,
  headingRef,
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

  // A day already in `picked` leaves the candidate pool: three options should be three
  // different days, not 6:00 and 6:15 on the same evening (which also structurally excludes
  // re-suggesting an already-picked slot — same day, so same exclusion).
  const pickedDays = new Set(picked.map((option) => localDayKey(option.start)));
  const { availabilityView, suggestions, pickerView, setPickerView, reload } =
    useSuggestedTimesPicker({
      expertProfileId,
      fixedDurationMinutes,
      originalStartIso: currentScheduledStartIso,
      extraFilter: (slot) => !pickedDays.has(localDayKey(slot.start)),
    });
  // Reactive, unlike `pickerView`'s own initial decision: the LAST suggested day being picked
  // must fall through to the calendar immediately, not only on the next "See more times" click.
  const showingCalendar = pickerView === 'calendar' || suggestions.length === 0;

  /**
   * Item 20 — the `reschedule-dialog.tsx` precedent (`backButtonRef`/`headingRef`), applied to
   * this dialog's ONE transition: hitting the `RESCHEDULE_PROPOSAL_MAX_OPTIONS` cap UNMOUNTS
   * `ExpertAvailabilityCalendar` in place of a `<p>` note. The click that triggered it came
   * from a button INSIDE the calendar, and that node is now gone — without this, focus falls
   * silently to `<body>` with no announcement to a keyboard or screen-reader user. The reverse
   * transition (removing a pick to drop back under the cap) returns focus to the dialog's own
   * heading — the one anchor stable across both states. `hasTransitionedRef` guards the FIRST
   * render so mounting/opening the dialog never steals focus from wherever the "Propose a new
   * time" click left it. `pickerView` joins the same effect for the SAME reason: "See more
   * times" and "Suggested times" each unmount the button that was just clicked.
   */
  const capNoteRef = useRef<HTMLParagraphElement>(null);
  const stepHeadingRef = useRef<HTMLHeadingElement>(null);
  const hasTransitionedRef = useRef(false);
  /** Set before the one close that must land on the `headingRef` PROP; cleared by
   *  `handleCloseAutoFocus`. Same race as `RescheduleDialog` / `CancelConsultationDialog`. */
  const terminalCloseRef = useRef(false);

  const resetAndClose = useCallback(
    (options: { terminal?: boolean } = {}) => {
      setPicked([]);
      setSubmitting(false);
      setPickerKey((key) => key + 1);
      // The component instance is reused across a different meeting's dialog (no `key` at the
      // `case-surface.tsx` call site) — a stale decision here would carry the wrong meeting's
      // view into a fresh open.
      setPickerView(null);
      if (options.terminal === true && onTerminalFailure !== undefined) {
        terminalCloseRef.current = true;
        onTerminalFailure();
        return;
      }
      onClose();
    },
    [onClose, onTerminalFailure, setPickerView]
  );

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
          // stale list (which included the now-taken slot) is not re-shown, and refetch so the
          // suggestion list (fed by this hook's own `availabilityView`, not `pickerKey`) drops it.
          setPicked([]);
          setPickerKey((key) => key + 1);
          reload();
        } else if (isTerminalProposalFailure(result.code)) {
          // BAL-409's `copyForFailure`/`closeOnAcknowledge` precedent, carried over: the state
          // this dialog was rendered from is gone — close (via `onTerminalFailure`) instead
          // of re-offering a Send that will fail again with the exact same error.
          resetAndClose({ terminal: true });
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
    reload,
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
      stepHeadingRef.current?.focus();
    }
  }, [atMax, pickerView]);

  const handleCloseAutoFocus = useCallback(
    (event: Event) => {
      if (terminalCloseRef.current) {
        event.preventDefault();
        headingRef?.current?.focus();
      }
      terminalCloseRef.current = false;
    },
    [headingRef]
  );

  const sendButtonLabel = picked.length > 0 ? `Send proposal (${picked.length})` : 'Send proposal';

  let pickerPanel: React.JSX.Element;
  if (atMax) {
    pickerPanel = (
      <p
        ref={capNoteRef}
        tabIndex={-1}
        className="text-muted-foreground text-sm focus-visible:outline-none"
      >
        You&apos;ve picked the maximum of {RESCHEDULE_PROPOSAL_MAX_OPTIONS} times. Remove one above
        to pick a different time.
      </p>
    );
  } else if (availabilityView.kind === 'loading' || pickerView === null) {
    pickerPanel = <AvailabilitySkeleton />;
  } else if (!showingCalendar && fixedDurationMinutes !== undefined) {
    pickerPanel = (
      <SuggestedTimesList
        slots={suggestions}
        durationMinutes={fixedDurationMinutes}
        adds
        onPick={handleSlotSelect}
        onSeeMore={() => setPickerView('calendar')}
      />
    );
  } else {
    pickerPanel = (
      <>
        {suggestions.length > 0 && (
          <SuggestedTimesBackLink onClick={() => setPickerView('suggested')} />
        )}
        <ExpertAvailabilityCalendar
          key={pickerKey}
          expertProfileId={expertProfileId}
          mode="selectable"
          viewerType="expert"
          fixedDurationMinutes={fixedDurationMinutes}
          onSlotSelect={handleSlotSelect}
        />
      </>
    );
  }

  const body = (
    <div className="flex min-h-[420px] flex-col p-6">
      <h2
        ref={stepHeadingRef}
        tabIndex={-1}
        className="text-foreground mb-1 text-base font-semibold focus-visible:outline-none"
      >
        Propose new times
      </h2>
      {/* Names the meeting before any time gets picked — Propose is reachable from any row now. */}
      <p className="text-muted-foreground mb-1 text-xs">
        Currently <LocalDateTime iso={currentScheduledStartIso} variant="day-month-time" /> ·{' '}
        {durationMinutes} min
      </p>
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
              {/* The ORIGINAL length, not `option.duration`: the server re-pins it regardless of
                  what the picker returns, so this is what will actually be proposed. */}
              <LocalDateTime
                iso={option.start}
                variant="day-month-time-range"
                durationMinutes={durationMinutes}
              />
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

      {pickerPanel}

      <div className="mt-auto flex gap-2 pt-4">
        <Button
          type="button"
          variant="outline"
          onClick={() => resetAndClose()}
          disabled={submitting}
        >
          {/* "Cancel" reads as the CONSULTATION on this surface, which is reachable from the
              cancel confirmation itself. */}
          Keep this time
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

  // The programmatic name, mirroring `RescheduleDialog`'s.
  const programmaticTitle = (
    <>
      Propose new times for consultation{ordinal === null ? '' : ` ${ordinal}`} — currently{' '}
      <LocalDateTime iso={currentScheduledStartIso} variant="day-month-time" />
    </>
  );

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={(next) => !next && resetAndClose()}>
        <SheetContent
          side="bottom"
          className="max-h-[94dvh] overflow-y-auto rounded-t-2xl p-0"
          onCloseAutoFocus={handleCloseAutoFocus}
        >
          <SheetTitle className="sr-only">{programmaticTitle}</SheetTitle>
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
      {/* Same width as `reschedule-dialog.tsx` DialogContent, same reason — this dialog embeds
          the identical two-pane `ExpertAvailabilityCalendar`, unmodified. */}
      <DialogContent
        className="max-h-[85vh] overflow-y-auto rounded-xl p-0 sm:max-w-[min(92vw,840px)]"
        onCloseAutoFocus={handleCloseAutoFocus}
      >
        <DialogTitle className="sr-only">{programmaticTitle}</DialogTitle>
        <DialogDescription className="sr-only">
          Pick up to three alternative times and send them to your client.
        </DialogDescription>
        {body}
      </DialogContent>
    </Dialog>
  );
}

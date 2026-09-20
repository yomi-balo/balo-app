'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { toast } from 'sonner';
import * as Sentry from '@sentry/nextjs';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { track, BOOKING_EVENTS } from '@/lib/analytics';
import { LocalDateTime } from '@/components/balo/date/local-date-time';
import { cancelConsultationAction } from '@/app/(dashboard)/cases/[engagementId]/_actions/cancel-consultation';
import type { CancelFailureCode } from '@/app/(dashboard)/cases/[engagementId]/_actions/_types/case-action-types';

/**
 * BAL-410 — the cancel-a-consultation confirmation. Free until the scheduled start.
 *
 * ⚠ `AlertDialog`, NOT `Dialog`/`Sheet`. `RescheduleDialog` uses the latter because it is a
 * two-step PICKER; this is a single destructive CONFIRMATION, and the shipped in-repo pattern
 * for that is `_components/case-actions.tsx`'s `MarkResolvedButton` — `AlertDialogAction` +
 * `AlertDialogCancel`, with the dismiss labelled in the user's own words ("Keep it").
 *
 * ⚠ THERE ARE EXACTLY **TWO** DISMISS PATHS HERE, NOT FOUR — ESC and "Keep it" are the only ways
 * to leave with nothing changed; "Reschedule instead" / "Propose a new time" and
 * "Cancel consultation" both DO something, so neither counts as a dismissal. Radix's
 * `AlertDialogContent` hardcodes `onPointerDownOutside`/`onInteractOutside` to
 * `event.preventDefault()`, so an OVERLAY CLICK does NOT dismiss an `AlertDialog` the way it
 * dismisses a plain `Dialog`; and an X close button is a `Dialog`-only affordance that this
 * component correctly does not render (`MarkResolvedButton` does not either). That is
 * intentional Radix behaviour for a destructive confirmation — force an explicit response — not
 * a gap. Focus trapping and the initial focus land on the SAFE button and do come free.
 * `booking_cancel_abandoned` observes the `open` PROP rather than any particular gesture, so it
 * covers both real paths and would cover a third if Radix ever grew one.
 *
 * ── ALL FOUR ASYNC STATES ────────────────────────────────────────────────────────────────
 *   · LOADING — `submitting`; the confirm label swaps to "Cancelling…" and both buttons
 *     disable. `AlertDialogCancel` stays mounted (not removed) so focus is never orphaned.
 *   · EMPTY   — STRUCTURALLY IMPOSSIBLE, and stated rather than shipped as a dead branch: the
 *     dialog only mounts when `case-surface.tsx`'s selection names a `'cancel'` verb, which by
 *     construction carries a resolved `meetingId`. There is nothing to render an empty state FOR.
 *   · ERROR   — `copyForFailure(code)`, cloned from `reschedule-dialog.tsx`. NEVER echoes a
 *     server literal. `Sentry.captureException` on `'unknown'` only.
 *   · SUCCESS — `track` → `toast.success` → reset → `onCancelled()`.
 *
 * ⚠⚠ TERMINAL-FAILURE HANDLING IS MANDATORY HERE, for a SHARPER reason than in reschedule.
 * `caseConsultationIsUpcoming` excludes `'cancelled'`, so a successful cancel — or a 409
 * `meeting_not_cancellable` — makes whichever selection opened this dialog stale; it must
 * close-and-refresh rather than stay attached to a subject that is about to disappear.
 *
 * ⚠⚠ The subject sits inside the header because Radix wires `aria-describedby` only to
 * `AlertDialogDescription` — content outside it is never announced to a screen reader. The
 * title already carries the absolute date, so the description's "Scheduled for …" would repeat
 * it; the description instead opens with the ordinal/duration clause the title doesn't carry.
 *
 * ⚠ The free-to-cancel facts hedge on "any credit held for the call" — deliberately, because
 * whether a hold exists is not known client-side until the server answers.
 *
 * ⚠⚠ A terminal close sets focus via `onCloseAutoFocus`, not a synchronous `.focus()` call: the
 * caller's call would fire while Radix's `FocusScope` is still trapping and get overridden the
 * instant the trap releases. `terminalCloseRef` marks the two closes that must land on
 * `headingRef` once that release fires.
 *
 * ⚠⚠ THE MOVE HOP IS A THIRD, DIFFERENT UNMOUNT — for either verb. Choosing "Reschedule
 * instead" / "Propose a new time" swaps `case-surface.tsx`'s selection to `verb: 'reschedule'` /
 * `'propose'` while `dialogOpen` stays `true`, so this component unmounts WITHOUT `open` ever
 * going `false` — yet Radix's `FocusScope` still tears down and still fires `onCloseAutoFocus`.
 * `moveHopRef` marks that case so the handler does nothing at all: the mounting dialog is
 * mounting in the same commit and must be the one to claim focus, never `headingRef` and never
 * Radix's own default restore. For the same reason the divert fires `booking_cancel_abandoned`
 * directly at click time, tagged with the verb — the `open`-watching effect below never runs on
 * this unmount (it registers no cleanup function), so nothing else would report the decision.
 */
export interface CancelConsultationDialogProps {
  open: boolean;
  onClose: () => void;
  /** Called after a successful cancel — the caller refreshes the page and closes the dialog. */
  onCancelled: () => void;
  /**
   * Called INSTEAD OF `onClose` when the dialog closes itself after a TERMINAL, no-longer-
   * actionable failure. Falls back to `onClose` when omitted, so this is additive.
   */
  onTerminalFailure?: () => void;
  /** "Reschedule instead" / "Propose a new time". The dialog has no idea what either opens —
   *  the caller re-keys its own selection so the matching picker mounts for the same meeting. */
  onMoveInstead: (verb: 'reschedule' | 'propose') => void;
  lens: 'client' | 'expert';
  engagementId: string;
  meetingId: string;
  /** Party label — the expert's agency (or their own name when independent) on the client
   *  lens, the client company on the expert lens. Prospective copy names the PARTY. */
  counterpartyLabel: string;
  /** The counterparty's first name — the retrospective, person-addressed register. Used only
   *  in the `pending_reschedule` client lead, which refers back to who made that proposal. */
  counterpartyFirstName: string;
  /** The meeting's CURRENT scheduled start, ISO — quoted in the title and used for analytics. */
  scheduledStartIso: string;
  /** 1-based, or `null` (cancelled / outside the set) — drops the ordinal clause instead of
   *  rendering "Consultation null". */
  ordinal: number | null;
  /** `scheduled_end − scheduled_start` for this meeting; part of the subject line. */
  scheduledMinutes: number;
  /** Where this confirmation was opened from, for `BOOKING_EVENTS.CANCELLED`. */
  source: 'nudge' | 'row';
  /** Same per-meeting flags the row menu reads. At most one move button ever renders — client's
   *  axis wins when both are somehow true, mirroring the row menu's own item order. */
  canReschedule: boolean;
  canProposeReschedule: boolean;
  /** Whether THIS meeting currently carries a live reschedule proposal — drives the
   *  proposal-specific lead sentence when no move button is offered. */
  isPendingReschedule: boolean;
  /** Where a terminal close sends focus (optional; omitting it keeps Radix's default
   *  focus-restore). */
  headingRef?: RefObject<HTMLElement | null>;
}

/** Server-literal → user copy. Never echoes a server literal verbatim. */
function copyForFailure(code: CancelFailureCode): {
  message: string;
  closeOnAcknowledge: boolean;
} {
  switch (code) {
    case 'unauthenticated':
      return { message: 'You are not signed in.', closeOnAcknowledge: true };
    case 'not_permitted':
      return {
        message: "You don't have permission to cancel this consultation.",
        closeOnAcknowledge: true,
      };
    case 'invalid_request':
      return { message: "That request wasn't valid.", closeOnAcknowledge: true };
    case 'meeting_not_found':
      return { message: "We couldn't find that consultation.", closeOnAcknowledge: true };
    case 'meeting_not_cancellable':
      return {
        message: 'This consultation has already started or was already cancelled. Nothing to do.',
        closeOnAcknowledge: true,
      };
    case 'rate_limited':
      return {
        message: 'Too many changes just now — try again shortly.',
        closeOnAcknowledge: false,
      };
    case 'unknown':
    default:
      return { message: 'Something went wrong. Please try again.', closeOnAcknowledge: false };
  }
}

/**
 * NOTICE GIVEN: `now` → the meeting's EXISTING start. ⚠ Can be NEGATIVE, and that is not bad
 * data — the server's guard reads no clock, so a never-joined meeting whose start has passed is
 * still cancellable. See `BOOKING_EVENTS.CANCELLED`'s own docblock.
 *
 * ⚠ `Math.round`, NOT `Math.abs` — unlike `reschedule-dialog.tsx`'s helper, the SIGN is the
 * entire point of this number for the v2-cutoff analysis.
 */
function hoursUntil(iso: string): number {
  return Math.round((new Date(iso).getTime() - Date.now()) / 3_600_000);
}

function subjectLine(ordinal: number | null, scheduledMinutes: number): string {
  return ordinal === null
    ? `${scheduledMinutes} minutes.`
    : `Consultation ${ordinal} · ${scheduledMinutes} minutes.`;
}

type MoveOption = { verb: 'reschedule' | 'propose'; label: string };

function resolveMove(canReschedule: boolean, canProposeReschedule: boolean): MoveOption | null {
  if (canReschedule) return { verb: 'reschedule', label: 'Reschedule instead' };
  if (canProposeReschedule) return { verb: 'propose', label: 'Propose a new time' };
  return null;
}

/**
 * The alternative, stated BEFORE the free-to-cancel facts. `null` when there is nothing to
 * offer: no move is possible and no proposal is outstanding on this meeting.
 */
function leadCopy(
  lens: 'client' | 'expert',
  move: MoveOption | null,
  isPendingReschedule: boolean,
  partyLabel: string,
  counterpartyFirstName: string
): string | null {
  if (move !== null) {
    return lens === 'client'
      ? `If it's the time that doesn't work, you can move this consultation to another of ${partyLabel}'s open times instead.`
      : `If a different time would work, propose one instead — ${partyLabel} picks a new time, or keeps this one.`;
  }
  if (isPendingReschedule) {
    return lens === 'client'
      ? `${counterpartyFirstName} has suggested some new times above — picking one of those keeps the call.`
      : 'Cancelling also withdraws the suggested times.';
  }
  return null;
}

/** Free is a promise, not a pitch — it stays, it just follows the alternative instead of
 *  opening on it. "If you DO cancel" only reads naturally once an alternative has been offered. */
function factsCopy(lens: 'client' | 'expert', partyLabel: string, hasLead: boolean): string {
  const ifCancel = hasLead ? 'If you do cancel' : 'If you cancel';
  return lens === 'client'
    ? `${ifCancel}, nothing is charged and any credit held for the call goes back to your balance.`
    : `${ifCancel}, ${partyLabel} is told and the slot reopens on your calendar. Nothing is charged either way.`;
}

export function CancelConsultationDialog({
  open,
  onClose,
  onCancelled,
  onTerminalFailure,
  onMoveInstead,
  lens,
  engagementId,
  meetingId,
  counterpartyLabel,
  counterpartyFirstName,
  scheduledStartIso,
  ordinal,
  scheduledMinutes,
  source,
  canReschedule,
  canProposeReschedule,
  isPendingReschedule,
  headingRef,
}: Readonly<CancelConsultationDialogProps>): React.JSX.Element {
  const [submitting, setSubmitting] = useState(false);
  const move = resolveMove(canReschedule, canProposeReschedule);
  const lead = leadCopy(lens, move, isPendingReschedule, counterpartyLabel, counterpartyFirstName);
  const facts = factsCopy(lens, counterpartyLabel, lead !== null);

  /** Set before the two closes that must land on `headingRef`; cleared by `onCloseAutoFocus`. */
  const terminalCloseRef = useRef(false);
  /** Set by the move hop; cleared by `onCloseAutoFocus`. See the module docblock. */
  const moveHopRef = useRef(false);

  /**
   * ⚠⚠ THE PER-DECISION LATCH for `booking_cancel_abandoned`. Without it the abandon event
   * fires on every render that observes a closed dialog, and an open→close→open cycle reports
   * several abandons for ONE decision. Modelled on BAL-416's `resolvedRef` reasoning, but
   * simpler: the confirm is a single call, so there is no in-flight-dismiss ambiguity to
   * resolve — the only question is "did this OPENING end in a resolution?" (a cancel, or a
   * divert to a move dialog — both resolve the decision; only a plain dismiss abandons it).
   */
  const resolvedRef = useRef(false);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (open) {
      // A fresh opening is a fresh decision.
      wasOpenRef.current = true;
      resolvedRef.current = false;
      return;
    }
    if (!wasOpenRef.current) {
      // Never opened — a mount, not a dismissal. Emitting here would report an abandon for a
      // dialog the user has not seen.
      return;
    }
    wasOpenRef.current = false;
    if (!resolvedRef.current) {
      track(BOOKING_EVENTS.CANCEL_ABANDONED, { diverted_to: null });
    }
  }, [open]);

  const resetAndClose = useCallback(
    (options: { terminal?: boolean } = {}) => {
      setSubmitting(false);
      if (options.terminal === true && onTerminalFailure !== undefined) {
        // Must land on `headingRef`, not a plain dismiss.
        terminalCloseRef.current = true;
        onTerminalFailure();
        return;
      }
      onClose();
    },
    [onClose, onTerminalFailure]
  );

  const handleOpenChange = useCallback(
    (next: boolean) => {
      // ⚠ A dismissal WHILE SUBMITTING is ignored rather than raced: the action is already in
      // flight and its own resolution owns the close.
      if (!next && !submitting) {
        resetAndClose();
      }
    },
    [resetAndClose, submitting]
  );

  /**
   * A plain button, not `AlertDialogAction`/`AlertDialogCancel` — it does not participate in
   * Radix's close lifecycle at all, so nothing here needs to fight or prevent it. Fires the
   * abandon event itself, tagged with the verb — see the module docblock.
   */
  const handleMoveInstead = useCallback(
    (verb: 'reschedule' | 'propose') => {
      resolvedRef.current = true;
      moveHopRef.current = true;
      track(BOOKING_EVENTS.CANCEL_ABANDONED, { diverted_to: verb });
      onMoveInstead(verb);
    },
    [onMoveInstead]
  );

  /**
   * ⚠⚠ `event.preventDefault()` IS LOAD-BEARING, NOT DEFENSIVE. Radix's `AlertDialogAction`
   * CLOSES the dialog on click by default. Left alone it fires `onOpenChange(false)` in the same
   * event as this handler, so the parent unmounts the dialog before the action resolves: the
   * "Cancelling…" state is never seen, and — worse — a TERMINAL failure would close through
   * `onClose` (no refresh) instead of `onTerminalFailure`, leaving a stale CTA on the page.
   * Preventing the default keeps the dialog mounted until one of the resolution paths below
   * decides how it should close.
   */
  const confirm = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      if (submitting) return;
      setSubmitting(true);

      (async () => {
        const result = await cancelConsultationAction({ engagementId, meetingId });

        if (!result.success) {
          const { message, closeOnAcknowledge } = copyForFailure(result.code);
          toast.error(message);
          if (result.code === 'unknown') {
            Sentry.captureException(new Error(`cancel failed: ${result.code}`));
          }
          setSubmitting(false);
          if (closeOnAcknowledge) {
            // ⚠ `meeting_not_cancellable` / `meeting_not_found` are TERMINAL: the nudge that
            // mounts this dialog is now stale, so close AND refresh rather than inviting a click
            // that would fail again with the identical error.
            resolvedRef.current = true;
            resetAndClose({ terminal: true });
          }
          return;
        }

        // ⚠ `initiated_by` COMES FROM THE ACTION'S RESPONSE — the API's own arm. Re-deriving it
        // from `lens` here would let the funnel disagree with the audit row.
        track(BOOKING_EVENTS.CANCELLED, {
          initiated_by: result.initiatedBy,
          hours_before_start: hoursUntil(scheduledStartIso),
          source,
        });
        toast.success('Consultation cancelled', { description: 'Nothing was charged.' });
        resolvedRef.current = true;
        setSubmitting(false);
        // This close must land on `headingRef` too; the meeting is gone either way.
        terminalCloseRef.current = true;
        onCancelled();
      })().catch((error: unknown) => {
        toast.error('Something went wrong. Please try again.');
        Sentry.captureException(error);
        setSubmitting(false);
      });
    },
    [submitting, engagementId, meetingId, scheduledStartIso, source, onCancelled, resetAndClose]
  );

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent
        onCloseAutoFocus={(event) => {
          // Timed to Radix's own trap teardown — see the module docblock.
          if (moveHopRef.current) {
            event.preventDefault();
            moveHopRef.current = false;
            return;
          }
          if (terminalCloseRef.current) {
            event.preventDefault();
            headingRef?.current?.focus();
          }
          terminalCloseRef.current = false;
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>
            Cancel the consultation on{' '}
            <LocalDateTime iso={scheduledStartIso} variant="day-month-time" />?
          </AlertDialogTitle>
          {/* asChild + a <div> so aria-describedby still points at one element across the
              paragraphs. */}
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>{subjectLine(ordinal, scheduledMinutes)}</p>
              {lead !== null && <p>{lead}</p>}
              <p>{facts}</p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {/* Destructive sits apart on the left at dialog width, and LAST when the footer
            stacks — both come from `AlertDialogFooter`'s own `flex-col-reverse …
            sm:flex-row` acting on these two direct children in this DOM order. */}
        <AlertDialogFooter className="sm:items-center sm:justify-between">
          <AlertDialogAction
            onClick={confirm}
            disabled={submitting}
            className={cn(
              buttonVariants({ variant: 'ghost' }),
              'text-destructive hover:bg-destructive/10 hover:text-destructive bg-transparent sm:-ml-3.5'
            )}
          >
            {submitting ? 'Cancelling…' : 'Cancel consultation'}
          </AlertDialogAction>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <AlertDialogCancel disabled={submitting}>Keep it</AlertDialogCancel>
            {move !== null && (
              <Button
                type="button"
                onClick={() => handleMoveInstead(move.verb)}
                disabled={submitting}
              >
                {move.label}
              </Button>
            )}
          </div>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

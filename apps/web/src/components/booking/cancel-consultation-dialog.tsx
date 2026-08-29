'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
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
 * ⚠ THERE ARE EXACTLY **TWO** DISMISS PATHS HERE, NOT FOUR — ESC and "Keep it". Radix's
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
 *     dialog only mounts under the `'upcoming'` nudge, which by construction has a resolved
 *     `meetingId`. There is nothing to render an empty state FOR.
 *   · ERROR   — `copyForFailure(code)`, cloned from `reschedule-dialog.tsx`. NEVER echoes a
 *     server literal. `Sentry.captureException` on `'unknown'` only.
 *   · SUCCESS — `track` → `toast.success` → reset → `onCancelled()`.
 *
 * ⚠⚠ TERMINAL-FAILURE HANDLING IS MANDATORY HERE, for a SHARPER reason than in reschedule.
 * `caseConsultationIsUpcoming` excludes `'cancelled'`, so a successful cancel drops the meeting
 * out of `selectNextScheduled` and THE `'upcoming'` NUDGE UNMOUNTS THIS DIALOG ITSELF. A 409
 * `meeting_not_cancellable` means the CTA is already stale, so it must close-and-refresh rather
 * than leave a dialog attached to a node that is about to disappear.
 *
 * ⚠ COPY: warm, non-adversarial, gender-neutral. No countdown, no deadline, no penalty. The
 * expert is named by PARTY label (prospective copy names the party — CLAUDE.md); no pronoun is
 * used for anybody. "any credit we were holding" avoids blame framing and — deliberately —
 * hedges, because the client-side flag for whether a hold EXISTS is not known until the server
 * answers. Copy checkpoint with MJ is noted in the PR body.
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
  lens: 'client' | 'expert';
  engagementId: string;
  meetingId: string;
  /** Expert party label (client lens) or the client company (expert lens). Never a person. */
  counterpartyLabel: string;
  /** The meeting's CURRENT scheduled start, ISO — quoted in the body and used for analytics. */
  scheduledStartIso: string;
  /**
   * The nudge's join window (`CaseNudgeView.live`) — TRUE from 15 minutes before the start.
   *
   * ⚠ IT GATES THE *ALTERNATIVE*, NEVER THE CANCEL ITSELF. Cancel deliberately stays available
   * inside the join window ("free until scheduled start"), but `case-nudge.tsx` HIDES both
   * Reschedule (client) and Propose a new time (expert) there. Without this, the dialog spends
   * that window pointing at an action that is not on the page the reader is looking at.
   * Optional and defaulted to `false` so every existing call site keeps compiling.
   */
  live?: boolean;
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

/**
 * ⚠ `offerAlternative` IS THE JOIN-WINDOW TERM (N1). Both lenses name a MOVE action as the
 * gentler option — "Reschedule instead" (client) / "propose a new time" (expert) — and
 * `case-nudge.tsx` hides BOTH once `nudge.live` turns true. Naming an action the reader cannot
 * find is worse than saying nothing, so the sentence drops rather than the whole dialog changing
 * shape. The FREE/nothing-is-charged promise is unconditional and never drops.
 */
function bodyCopy(
  lens: 'client' | 'expert',
  counterpartyLabel: string,
  offerAlternative: boolean
): string {
  if (lens === 'client') {
    return `It's free to cancel any time before the start — nothing is charged. Any credit we were holding for the call goes straight back to your balance, and ${counterpartyLabel} will see the slot open up again.`;
  }
  const base = `${counterpartyLabel} will be told, and the slot reopens on your calendar. Nothing is charged either way.`;
  return offerAlternative
    ? `${base} If a different time would work better, propose a new time instead of cancelling.`
    : base;
}

export function CancelConsultationDialog({
  open,
  onClose,
  onCancelled,
  onTerminalFailure,
  lens,
  engagementId,
  meetingId,
  counterpartyLabel,
  scheduledStartIso,
  live = false,
}: Readonly<CancelConsultationDialogProps>): React.JSX.Element {
  const [submitting, setSubmitting] = useState(false);
  // The move action the copy would point at is on the page only OUTSIDE the join window.
  const offerAlternative = !live;

  /**
   * ⚠⚠ THE PER-DECISION LATCH for `booking_cancel_abandoned`. Without it the abandon event
   * fires on every render that observes a closed dialog, and an open→close→open cycle reports
   * several abandons for ONE decision. Modelled on BAL-416's `resolvedRef` reasoning, but
   * simpler: the confirm is a single call, so there is no in-flight-dismiss ambiguity to
   * resolve — the only question is "did this OPENING end in a success?".
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
      track(BOOKING_EVENTS.CANCEL_ABANDONED, {});
    }
  }, [open]);

  const resetAndClose = useCallback(
    (options: { terminal?: boolean } = {}) => {
      setSubmitting(false);
      if (options.terminal === true && onTerminalFailure !== undefined) {
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
        });
        toast.success('Consultation cancelled', { description: 'Nothing was charged.' });
        resolvedRef.current = true;
        setSubmitting(false);
        onCancelled();
      })().catch((error: unknown) => {
        toast.error('Something went wrong. Please try again.');
        Sentry.captureException(error);
        setSubmitting(false);
      });
    },
    [submitting, engagementId, meetingId, scheduledStartIso, onCancelled, resetAndClose]
  );

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Cancel this consultation?</AlertDialogTitle>
          <AlertDialogDescription>
            {bodyCopy(lens, counterpartyLabel, offerAlternative)}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <p className="text-muted-foreground text-sm">
          Scheduled for <LocalDateTime iso={scheduledStartIso} variant="day-month-time" />.
          {lens === 'client' && offerAlternative
            ? ' Changed your mind about the time rather than the call? Reschedule instead.'
            : ''}
        </p>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={submitting}>Keep it</AlertDialogCancel>
          <AlertDialogAction onClick={confirm} disabled={submitting}>
            {submitting ? 'Cancelling…' : 'Cancel consultation'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

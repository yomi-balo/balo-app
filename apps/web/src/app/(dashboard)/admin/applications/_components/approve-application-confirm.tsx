'use client';

import { Loader2 } from 'lucide-react';
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
import { cn } from '@/lib/utils';

interface ApproveApplicationConfirmProps {
  readonly firstName: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly pending: boolean;
  readonly onConfirm: () => void;
}

/**
 * BAL-549 FIX ROUND (F9, user-ruled) — the approve confirmation.
 *
 * ⚠ DELIBERATELY LIGHTWEIGHT, AND DELIBERATELY NOT `DeclineApplicationSheet`. An approve has
 * nothing to collect — no reason, no note, no required field — so this is one confirming action
 * and a way out, nothing more. Adeeb works a queue of mostly-good applications; the happy path
 * stays two clicks. What it buys is the one thing the decline arm already had: a beat between
 * the pointer and an act that grants marketplace access, moves the applicant into the expert
 * workspace and emails them, with no true undo.
 *
 * The shipped confirm-before-a-consequential-act primitive is `AlertDialog`
 * (`CalendarDisconnectConfirm`, `RemoveCardConfirm`, `DateOverrideDeleteConfirm`): Radix gives
 * the focus trap, the ESC/overlay dismiss, the `role="alertdialog"` and the title/description
 * wiring. Fully controlled — `DecisionControls` owns `open` and `pending`; this owns no state.
 *
 * ⚠ THE CONFIRM ACTION IS NOT DESTRUCTIVE-VARIANT (unlike the two precedents above): approving
 * is the good outcome, so it keeps the default primary styling. Copy is warm and names the
 * applicant as a PERSON, gender-neutral throughout — no pronoun appears at all.
 */
export function ApproveApplicationConfirm({
  firstName,
  open,
  onOpenChange,
  pending,
  onConfirm,
}: Readonly<ApproveApplicationConfirmProps>): React.JSX.Element {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          {/* pending-MJ */}
          <AlertDialogTitle>Approve {firstName} as an expert on Balo?</AlertDialogTitle>
          <AlertDialogDescription>
            {/* pending-MJ */}
            {firstName} moves straight into the expert workspace, becomes visible to clients, and
            gets an email saying so. There is no undo, so it is worth a second look — the
            application stays right here if you would rather come back to it.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          {/* pending-MJ */}
          <AlertDialogCancel disabled={pending}>Not yet</AlertDialogCancel>
          <AlertDialogAction
            onClick={(event) => {
              // The dialog closes on the caller's terms (after the action settles), not on the
              // primitive's default — same reason `RemoveCardConfirm` preventDefaults here.
              event.preventDefault();
              onConfirm();
            }}
            disabled={pending}
            className="relative"
          >
            {/*
              The full label stays in normal flow (visually hidden while pending) so the button
              never resizes mid-action — the `RemoveCardConfirm` idiom.
            */}
            {/* pending-MJ */}
            <span className={cn('inline-flex items-center gap-2', pending && 'invisible')}>
              Approve
            </span>
            {pending && (
              <span className="absolute inset-0 flex items-center justify-center gap-2">
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                {/* pending-MJ */}
                Approving…
              </span>
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

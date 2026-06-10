'use client';

import { useCallback, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
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
import type { RequestProposalResult } from '@/app/(dashboard)/projects/[requestId]/_actions/request-proposal';

type RequestProposalSuccess = Extract<RequestProposalResult, { success: true }>;

interface ProposalRequestDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  expertFirstName: string;
  /** Runs the Server Action (the stage wraps it to reconcile `already_requested`). */
  onConfirm: () => Promise<RequestProposalResult>;
  /** Called AFTER a successful action, just before the dialog closes. */
  onConfirmed: (result: RequestProposalSuccess) => void;
}

/**
 * The A5 confirmation beat (BAL-272): requesting a proposal is a COMMITTING
 * action, so it gets a confirm — friction proportional to consequence (design
 * principle L24–25). Plain shadcn `AlertDialog` (the sanctioned structural
 * overlay). Owns the pending state; stays open on a generic failure so the user
 * can retry, closes on `already_requested` (the stage reconciles local state).
 */
export function ProposalRequestDialog({
  open,
  onOpenChange,
  expertFirstName,
  onConfirm,
  onConfirmed,
}: Readonly<ProposalRequestDialogProps>): React.JSX.Element {
  const [pending, setPending] = useState(false);

  const handleOpenChange = useCallback(
    (next: boolean): void => {
      // Commit in flight — no Escape-away mid-action; close on completion only.
      if (pending && !next) return;
      onOpenChange(next);
    },
    [pending, onOpenChange]
  );

  const handleConfirm = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>): void => {
      // Keep the dialog mounted while the action runs — close manually.
      event.preventDefault();
      if (pending) return;
      setPending(true);
      onConfirm()
        .then((result) => {
          if (result.success) {
            onConfirmed(result);
            onOpenChange(false);
            return;
          }
          if (result.code === 'already_requested') {
            // Stale UI — the stage reconciled local state; nothing to retry.
            onOpenChange(false);
            return;
          }
          // Generic failure: surface it and stay open so the user can retry.
          toast.error(result.error);
        })
        .catch(() => {
          toast.error('Could not request the proposal. Please try again.');
        })
        .finally(() => setPending(false));
    },
    [pending, onConfirm, onConfirmed, onOpenChange]
  );

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Request a proposal from {expertFirstName}?</AlertDialogTitle>
          <AlertDialogDescription>
            This asks {expertFirstName} to prepare a formal proposal — scope, deliverables, and
            price. They&apos;ll be notified right away. You can keep messaging and meeting while
            they build it.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Not yet</AlertDialogCancel>
          <AlertDialogAction onClick={handleConfirm} disabled={pending}>
            {pending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            Request proposal
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
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
import { track, PROJECT_EVENTS } from '@/lib/analytics';
import { submitProposalAction } from '@/app/(dashboard)/projects/[requestId]/_actions/submit-proposal';

interface SubmitProposalDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  requestId: string;
  relationshipId: string;
  proposalId: string | null;
  clientFirstName: string;
  /**
   * Flush a final autosave before submitting (Q2: trust the persisted draft).
   * Resolves to the proposalId that the server will submit, or null on failure.
   */
  onBeforeSubmit: () => Promise<string | null>;
}

/**
 * The submit confirm beat (A6.2 / BAL-288) — mirrors `proposal-request-dialog`.
 * Owns its pending state, blocks Escape while in flight. On confirm it flushes a
 * final autosave (`onBeforeSubmit`, Q2), calls `submitProposalAction` against the
 * persisted draft, fires analytics on success, toasts, then routes back to the
 * request detail and refreshes. Stays open on a generic failure so the user can
 * retry; closes on the stale-UI path (nothing to retry).
 */
export function SubmitProposalDialog({
  open,
  onOpenChange,
  requestId,
  relationshipId,
  proposalId,
  clientFirstName,
  onBeforeSubmit,
}: Readonly<SubmitProposalDialogProps>): React.JSX.Element {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  const handleOpenChange = useCallback(
    (next: boolean): void => {
      if (pending && !next) return; // no Escape-away mid-submit
      onOpenChange(next);
    },
    [pending, onOpenChange]
  );

  const handleConfirm = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>): void => {
      event.preventDefault();
      if (pending) return;
      setPending(true);

      const run = async (): Promise<void> => {
        try {
          // Q2: flush a final autosave so the server submits what's stored.
          const flushedProposalId = await onBeforeSubmit();
          const effectiveProposalId = flushedProposalId ?? proposalId;
          if (effectiveProposalId === null) {
            toast.error('Could not submit your proposal. Please try again.');
            return;
          }

          const result = await submitProposalAction({
            requestId,
            relationshipId,
            proposalId: effectiveProposalId,
          });

          if (!result.success) {
            // Stale-UI copy → close (nothing to retry); otherwise stay open.
            if (result.error === 'This proposal can no longer be submitted.') {
              toast.error(result.error);
              onOpenChange(false);
              router.refresh();
              return;
            }
            toast.error(result.error);
            return;
          }

          track(PROJECT_EVENTS.PROJECT_PROPOSAL_SUBMITTED, {
            request_id: requestId,
            relationship_id: relationshipId,
            expert_id: result.expertProfileId,
            price_cents: result.analytics.priceCents,
            currency: result.analytics.currency,
          });
          if (result.transitioned) {
            track(PROJECT_EVENTS.PROJECT_REQUEST_STATUS_TRANSITIONED, {
              request_id: requestId,
              from: 'proposal_requested',
              to: 'proposal_submitted',
              actor: 'expert',
            });
          }

          toast.success(`Proposal sent to ${clientFirstName}`);
          onOpenChange(false);
          router.push(`/projects/${requestId}`);
          router.refresh();
        } catch {
          toast.error('Could not submit your proposal. Please try again.');
        } finally {
          setPending(false);
        }
      };
      run();
    },
    [
      pending,
      onBeforeSubmit,
      proposalId,
      requestId,
      relationshipId,
      clientFirstName,
      onOpenChange,
      router,
    ]
  );

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Submit your proposal to {clientFirstName}?</AlertDialogTitle>
          <AlertDialogDescription>
            {clientFirstName} will be notified and can review your scope, milestones, and price. You
            won&apos;t be able to edit this draft after submitting.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Keep editing</AlertDialogCancel>
          <AlertDialogAction onClick={handleConfirm} disabled={pending}>
            {pending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            Submit proposal
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

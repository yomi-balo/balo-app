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
import {
  resubmitProposalAction,
  type ResubmitProposalInput,
} from '@/app/(dashboard)/projects/[requestId]/_actions/resubmit-proposal';

/**
 * Revise-mode payload (A6.4 / BAL-290). When present, the dialog confirms a
 * RESUBMIT instead of a first submit: it calls `resubmitProposalAction` with the
 * composer's full payload (built by the composer at confirm time), fires the
 * `PROPOSAL_RESUBMITTED` analytics, and routes/refreshes on success.
 */
interface ResubmitConfig {
  /** The version this resubmit will write (for the confirm copy) — defaults to 2. */
  nextVersion: number;
  /** Build the full resubmit payload at confirm time (latest composer state). */
  getPayload: () => ResubmitProposalInput;
}

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
   * Submit mode only (revise mode is local-only until the atomic resubmit).
   */
  onBeforeSubmit: () => Promise<string | null>;
  /** When present, the dialog confirms a RESUBMIT (revise mode), not a first submit. */
  resubmit?: ResubmitConfig;
}

const SUBMIT_STALE_COPY = 'This proposal can no longer be submitted.';
const RESUBMIT_STALE_COPY = 'This proposal has already been resubmitted. Refresh to continue.';

/**
 * The submit/resubmit confirm beat (A6.2 / BAL-288 + A6.4 / BAL-290). Owns its
 * pending state, blocks Escape while in flight. In SUBMIT mode it flushes a final
 * autosave (`onBeforeSubmit`, Q2), calls `submitProposalAction`, and fires
 * `PROJECT_PROPOSAL_SUBMITTED`. In RESUBMIT mode (the `resubmit` prop) it calls
 * `resubmitProposalAction` with the composer's full payload and fires
 * `PROPOSAL_RESUBMITTED`. On success it toasts, routes back to the request detail,
 * and refreshes; on a generic failure it stays open to retry; on the stale-UI path
 * it closes (nothing to retry).
 */
export function SubmitProposalDialog({
  open,
  onOpenChange,
  requestId,
  relationshipId,
  proposalId,
  clientFirstName,
  onBeforeSubmit,
  resubmit,
}: Readonly<SubmitProposalDialogProps>): React.JSX.Element {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  const isResubmit = resubmit !== undefined;

  const handleOpenChange = useCallback(
    (next: boolean): void => {
      if (pending && !next) return; // no Escape-away mid-submit
      onOpenChange(next);
    },
    [pending, onOpenChange]
  );

  const routeOnSuccess = useCallback((): void => {
    onOpenChange(false);
    router.push(`/projects/${requestId}`);
    router.refresh();
  }, [onOpenChange, router, requestId]);

  const runSubmit = useCallback(async (): Promise<void> => {
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
      if (result.error === SUBMIT_STALE_COPY) {
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
    routeOnSuccess();
  }, [
    onBeforeSubmit,
    proposalId,
    requestId,
    relationshipId,
    clientFirstName,
    onOpenChange,
    router,
    routeOnSuccess,
  ]);

  const runResubmit = useCallback(
    async (config: ResubmitConfig): Promise<void> => {
      const result = await resubmitProposalAction(config.getPayload());

      if (!result.success) {
        // Stale-UI copy → close (nothing to retry); otherwise stay open.
        if (result.error === RESUBMIT_STALE_COPY) {
          toast.error(result.error);
          onOpenChange(false);
          router.refresh();
          return;
        }
        toast.error(result.error);
        return;
      }

      track(PROJECT_EVENTS.PROPOSAL_RESUBMITTED, {
        request_id: requestId,
        relationship_id: relationshipId,
        expert_id: result.expertProfileId,
        version: result.version,
        price_cents: result.analytics.priceCents,
        currency: result.analytics.currency,
      });

      toast.success(`Resubmitted as v${result.version}`);
      routeOnSuccess();
    },
    [requestId, relationshipId, onOpenChange, router, routeOnSuccess]
  );

  const handleConfirm = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>): void => {
      event.preventDefault();
      if (pending) return;
      setPending(true);

      const run = async (): Promise<void> => {
        try {
          if (resubmit === undefined) {
            await runSubmit();
          } else {
            await runResubmit(resubmit);
          }
        } catch {
          toast.error(
            isResubmit
              ? 'Could not resubmit your proposal. Please try again.'
              : 'Could not submit your proposal. Please try again.'
          );
        } finally {
          setPending(false);
        }
      };
      run();
    },
    [pending, resubmit, runResubmit, runSubmit, isResubmit]
  );

  const title = isResubmit
    ? `Resubmit your revised proposal to ${clientFirstName}?`
    : `Submit your proposal to ${clientFirstName}?`;
  const description = isResubmit
    ? `${clientFirstName} will be notified and can review your revised scope, milestones, and price as a new version.`
    : `${clientFirstName} will be notified and can review your scope, milestones, and price. You won't be able to edit this draft after submitting.`;
  const confirmLabel = isResubmit ? `Resubmit as v${resubmit.nextVersion}` : 'Submit proposal';

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Keep editing</AlertDialogCancel>
          <AlertDialogAction onClick={handleConfirm} disabled={pending}>
            {pending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

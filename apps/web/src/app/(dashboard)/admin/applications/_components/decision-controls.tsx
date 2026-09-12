'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Check, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { track, ADMIN_APPLICATIONS_EVENTS } from '@/lib/analytics';
import { approveExpertApplicationAction } from '../_actions/approve-expert-application';
import { decisionOutcomeIsStale } from '../_lib/decision-staleness';
import { ApproveApplicationConfirm } from './approve-application-confirm';
import { DeclineApplicationSheet } from './decline-application-sheet';

/**
 * BAL-549 — the review page's decision controls. Rendered when and only when the application
 * is `'submitted'` or `'under_review'` (D4) — the page decides that, this component just acts.
 *
 * Approve = primary `Button` → `<ApproveApplicationConfirm />`, a LIGHTWEIGHT `AlertDialog`.
 * Decline = `variant="ghost"` → `<DeclineApplicationSheet />`.
 *
 * ⚠ APPROVE CONFIRMS TOO (fix round F9, user-ruled). It originally fired straight from the
 * button, on the reasoning that an approve has no reason or note to collect — which is true of
 * what it COLLECTS and says nothing about what it DOES. Approving grants marketplace access,
 * moves the applicant into the expert workspace and emails them, and has no undo; the asymmetry
 * put the only confirmation in front of the reversible half. The two dialogs stay deliberately
 * different in weight: the decline sheet gathers a reason and a Balo-only note, this one asks a
 * single question.
 */

interface DecisionControlsProps {
  readonly expertProfileId: string;
  readonly firstName: string;
}

export function DecisionControls({
  expertProfileId,
  firstName,
}: Readonly<DecisionControlsProps>): React.JSX.Element {
  const router = useRouter();
  const [approving, setApproving] = useState(false);
  const [approveOpen, setApproveOpen] = useState(false);
  const [declineOpen, setDeclineOpen] = useState(false);

  // ⚠ THE ONLY CALLER OF THE APPROVE ACTION IS THE DIALOG'S CONFIRM. The button below opens the
  // dialog and nothing else — pinned in `decision-controls.test.tsx`.
  const handleConfirmApprove = useCallback((): void => {
    if (approving) return;
    setApproving(true);

    const run = async (): Promise<void> => {
      try {
        const result = await approveExpertApplicationAction({ expertProfileId });

        if (!result.success) {
          toast.error(result.error);
          // W3 — a lost race means this page is stale; re-render it into its decided state.
          if (decisionOutcomeIsStale(result.code)) router.refresh();
          return;
        }

        track(ADMIN_APPLICATIONS_EVENTS.REVIEWED, result.analytics);

        // pending-MJ
        toast.success(`Approved — ${firstName} is now an expert on Balo`);
        router.refresh();
      } catch {
        toast.error('Could not record the decision. Please try again.'); // pending-MJ
      } finally {
        setApproving(false);
        setApproveOpen(false);
      }
    };
    run();
  }, [approving, expertProfileId, firstName, router]);

  const handleOpenApprove = useCallback((): void => setApproveOpen(true), []);

  return (
    <div className="flex items-center gap-2">
      <Button onClick={handleOpenApprove} disabled={approving}>
        {approving ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        ) : (
          <Check className="h-4 w-4" aria-hidden="true" />
        )}
        {/* pending-MJ */}
        Approve
      </Button>
      <Button variant="ghost" onClick={() => setDeclineOpen(true)} disabled={approving}>
        <X className="h-4 w-4" aria-hidden="true" />
        {/* pending-MJ */}
        Decline
      </Button>
      <ApproveApplicationConfirm
        firstName={firstName}
        open={approveOpen}
        onOpenChange={setApproveOpen}
        pending={approving}
        onConfirm={handleConfirmApprove}
      />
      <DeclineApplicationSheet
        open={declineOpen}
        onOpenChange={setDeclineOpen}
        expertProfileId={expertProfileId}
        firstName={firstName}
      />
    </div>
  );
}

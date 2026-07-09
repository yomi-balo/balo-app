'use client';

import { useCallback, useState } from 'react';
import { RotateCcw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import type { EngagementLens } from '@/lib/engagement/resolve-engagement-lens';
import { withdrawCompletionRequestAction } from '@/app/(dashboard)/engagements/[id]/_actions/withdraw-completion-request';
import { WithdrawCompletionModal } from './withdraw-completion-modal';
import { useEngagementLifecycleAction } from './use-engagement-lifecycle-action';

interface ReviewBannerActionsProps {
  lens: EngagementLens;
  engagementId: string;
  clientCompanyName: string;
}

/**
 * The per-lens action row inside the `pending_acceptance` {@link ReviewBanner}
 * (BAL-334 / D4). EXPERT lens → "Withdraw request" (+ modal), taking the project back
 * out of review. CLIENT + ADMIN lenses render nothing: the client accept /
 * request-changes decision buttons + `acceptProject` / `projectChanges` modals are the
 * D7 seam (BAL-338) — the informational banner already sets expectation, so no
 * dead/disabled buttons are rendered here.
 */
export function ReviewBannerActions({
  lens,
  engagementId,
  clientCompanyName,
}: Readonly<ReviewBannerActionsProps>): React.JSX.Element | null {
  const { isPending, run } = useEngagementLifecycleAction();
  const [modalOpen, setModalOpen] = useState(false);

  const openModal = useCallback((): void => setModalOpen(true), []);
  const closeModal = useCallback((): void => setModalOpen(false), []);
  const handleConfirm = useCallback((): void => {
    setModalOpen(false);
    run(withdrawCompletionRequestAction({ engagementId }), 'Completion request withdrawn');
  }, [run, engagementId]);

  // D7 (BAL-338): client accept / request-changes decision buttons + modals mount here.
  if (lens !== 'expert') {
    return null;
  }

  return (
    <div className="mt-3">
      <Button variant="ghost" size="sm" type="button" onClick={openModal} disabled={isPending}>
        <RotateCcw className="size-3.5" aria-hidden />
        Withdraw request
      </Button>

      <WithdrawCompletionModal
        open={modalOpen}
        clientCompanyName={clientCompanyName}
        pending={isPending}
        onConfirm={handleConfirm}
        onCancel={closeModal}
      />
    </div>
  );
}

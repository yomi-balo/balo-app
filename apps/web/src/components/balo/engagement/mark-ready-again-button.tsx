'use client';

import { useCallback, useState } from 'react';
import { Loader2, Send } from 'lucide-react';

import { cn } from '@/lib/utils';
import { PROPOSAL_CTA_GRADIENT_CLASS } from '@/lib/project-request/proposal-cta';
import { requestCompletionAction } from '@/app/(dashboard)/engagements/[id]/_actions/request-completion';
import { RequestCompletionModal } from './request-completion-modal';
import { useEngagementLifecycleAction } from './use-engagement-lifecycle-action';

interface MarkReadyAgainButtonProps {
  engagementId: string;
  ctaLabel: string;
  /** Pre-derived confirm-dialog body (window + plan-lock + invoice) from the server view. */
  modalBody: string;
  clientCompanyName: string;
}

/**
 * The "Mark project ready again" control inside the `changes_made` change-request banner.
 * Same flow as the {@link ExpertCompletionCard}: a confirm dialog, then
 * `requestCompletionAction`, a toast, and a refresh that swaps the workspace to the
 * in-review state. The banner owns the action while it is showing, so the completion
 * card is not rendered beside it.
 */
export function MarkReadyAgainButton({
  engagementId,
  ctaLabel,
  modalBody,
  clientCompanyName,
}: Readonly<MarkReadyAgainButtonProps>): React.JSX.Element {
  const { isPending, run } = useEngagementLifecycleAction();
  const [modalOpen, setModalOpen] = useState(false);

  const openModal = useCallback((): void => setModalOpen(true), []);
  const closeModal = useCallback((): void => setModalOpen(false), []);
  const handleConfirm = useCallback((): void => {
    setModalOpen(false);
    run(requestCompletionAction({ engagementId }), 'Project sent for review');
  }, [run, engagementId]);

  return (
    <>
      <button
        type="button"
        onClick={openModal}
        disabled={isPending}
        className={cn(
          'focus-visible:ring-ring inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-md px-4 text-sm font-semibold hover:opacity-90 focus-visible:ring-2 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50',
          PROPOSAL_CTA_GRADIENT_CLASS
        )}
      >
        {isPending ? (
          <Loader2 className="size-4 animate-spin" aria-hidden />
        ) : (
          <Send className="size-4" aria-hidden />
        )}
        {ctaLabel}
      </button>

      <RequestCompletionModal
        open={modalOpen}
        title={ctaLabel}
        modalBody={modalBody}
        clientCompanyName={clientCompanyName}
        pending={isPending}
        onConfirm={handleConfirm}
        onCancel={closeModal}
      />
    </>
  );
}

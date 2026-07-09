'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Loader2 } from 'lucide-react';

import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { PROPOSAL_CTA_GRADIENT_CLASS } from '@/lib/project-request/proposal-cta';
import { track, ENGAGEMENT_EVENTS } from '@/lib/analytics';
import type { CompletionCardView } from '@/lib/engagement/engagement-view';
import { requestCompletionAction } from '@/app/(dashboard)/engagements/[id]/_actions/request-completion';
import { RequestCompletionModal } from './request-completion-modal';
import { useEngagementLifecycleAction } from './use-engagement-lifecycle-action';

interface ExpertCompletionCardProps {
  engagementId: string;
  /** Pre-derived server view slice — copy, counts, and the enabled flag. */
  card: CompletionCardView;
  clientCompanyName: string;
}

/**
 * The expert "Finish the project" card (BAL-334 / D4). A gradient "Mark project
 * complete" CTA whose DISABLED state EXPLAINS (the pre-derived `bodyCopy` names the
 * blocker); confirming opens {@link RequestCompletionModal} → `requestCompletionAction`.
 *
 * This island is SEPARATE from the milestone rail, so completing the final milestone
 * flips `canRequest` after `router.refresh()` (not instantly). Acceptable — the D0
 * guard is the real gate; the disabled state is a UX nicety that self-heals within one
 * refresh. Takes ONLY primitive props (`AUTO_ACCEPT_DAYS` is baked into the
 * server-derived copy) — never `@balo/db`.
 *
 * Fires the one CLIENT engagement analytics event: an impression of the blocked state,
 * once per mount, when the card renders disabled.
 */
export function ExpertCompletionCard({
  engagementId,
  card,
  clientCompanyName,
}: Readonly<ExpertCompletionCardProps>): React.JSX.Element {
  const { isPending, run } = useEngagementLifecycleAction();
  const [modalOpen, setModalOpen] = useState(false);
  const blockedTracked = useRef(false);

  useEffect(() => {
    if (card.hasMilestones && !card.canRequest && !blockedTracked.current) {
      blockedTracked.current = true;
      track(ENGAGEMENT_EVENTS.COMPLETION_BLOCKED_VIEW, {
        engagement_id: engagementId,
        milestones_remaining: card.milestonesRemaining,
      });
    }
  }, [card.hasMilestones, card.canRequest, card.milestonesRemaining, engagementId]);

  const openModal = useCallback((): void => setModalOpen(true), []);
  const closeModal = useCallback((): void => setModalOpen(false), []);
  const handleConfirm = useCallback((): void => {
    setModalOpen(false);
    run(requestCompletionAction({ engagementId }), 'Project sent for review');
  }, [run, engagementId]);

  const disabled = !card.canRequest || isPending;

  return (
    <>
      <Card className="border-border bg-card px-[22px] py-[18px]">
        <div className="flex flex-wrap items-center gap-4">
          <div className="min-w-[200px] flex-1">
            <p className="text-foreground text-sm font-semibold">Finish the project</p>
            <p className="text-muted-foreground mt-1 text-xs leading-relaxed">{card.bodyCopy}</p>
          </div>
          <button
            type="button"
            onClick={openModal}
            disabled={disabled}
            className={cn(
              'focus-visible:ring-ring inline-flex h-9 items-center justify-center gap-2 rounded-md px-4 text-sm font-semibold hover:opacity-90 focus-visible:ring-2 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50',
              PROPOSAL_CTA_GRADIENT_CLASS
            )}
          >
            {isPending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <Check className="size-4" aria-hidden />
            )}
            Mark project complete
          </button>
        </div>
      </Card>

      <RequestCompletionModal
        open={modalOpen}
        modalBody={card.modalBody}
        clientCompanyName={clientCompanyName}
        pending={isPending}
        onConfirm={handleConfirm}
        onCancel={closeModal}
      />
    </>
  );
}

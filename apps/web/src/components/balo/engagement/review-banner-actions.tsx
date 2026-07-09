'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { MessageSquare, RotateCcw, ThumbsUp } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { PROPOSAL_CTA_GRADIENT_CLASS } from '@/lib/project-request/proposal-cta';
import type { EngagementLens } from '@/lib/engagement/resolve-engagement-lens';
import type { ReviewClientDecisionView } from '@/lib/engagement/engagement-view';
import { withdrawCompletionRequestAction } from '@/app/(dashboard)/engagements/[id]/_actions/withdraw-completion-request';
import { acceptProjectAction } from '@/app/(dashboard)/engagements/[id]/_actions/accept-project';
import { requestProjectChangesAction } from '@/app/(dashboard)/engagements/[id]/_actions/request-changes';
import { WithdrawCompletionModal } from './withdraw-completion-modal';
import { AcceptProjectModal } from './accept-project-modal';
import { RequestChangesModal } from './request-changes-modal';
import { celebrationStorageKey } from './accept-celebration';
import { useEngagementLifecycleAction } from './use-engagement-lifecycle-action';

/** The email dual-CTA deep-link intent (`?action=accept|request-changes`). */
export type ReviewInitialAction = 'accept' | 'request-changes';

interface ReviewBannerActionsProps {
  lens: EngagementLens;
  engagementId: string;
  clientCompanyName: string;
  /** Client-lens decision copy (server-derived); null for expert/admin. */
  clientDecision: ReviewClientDecisionView | null;
  /** Email deep-link intent — auto-opens the matching modal once (client lens only). */
  initialAction: ReviewInitialAction | null;
}

type ClientModal = 'accept' | 'changes' | null;

/**
 * The per-lens action row inside the `pending_acceptance` {@link ReviewBanner}. EXPERT →
 * "Withdraw request" (D4). CLIENT → the project-level decision: "Accept project" (sticky
 * gradient confirm) + "Request changes" (required-note modal) — the D7 gate. ADMIN →
 * nothing (the informational banner suffices). The email dual-CTA deep-link
 * (`?action=accept|request-changes`) auto-opens the matching modal ONCE and strips the
 * param so a client-side nav back can't re-open it.
 */
export function ReviewBannerActions({
  lens,
  engagementId,
  clientCompanyName,
  clientDecision,
  initialAction,
}: Readonly<ReviewBannerActionsProps>): React.JSX.Element | null {
  const { isPending, run } = useEngagementLifecycleAction();
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [clientModal, setClientModal] = useState<ClientModal>(null);

  // Auto-open from the email deep-link — once, client lens only. Strip `?action` so a
  // client-side back-nav can't re-trigger it (and a stale link after accept is inert
  // because the review banner unmounts on the RSC refresh).
  const consumed = useRef(false);
  useEffect(() => {
    if (consumed.current) return;
    if (lens !== 'client' || clientDecision === null || initialAction === null) return;
    consumed.current = true;
    setClientModal(initialAction === 'accept' ? 'accept' : 'changes');
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.delete('action');
      window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    }
  }, [lens, clientDecision, initialAction]);

  const closeClientModal = useCallback((): void => setClientModal(null), []);
  const handleAccept = useCallback((): void => {
    setClientModal(null);
    run(acceptProjectAction({ engagementId }), 'Project accepted 🎉', () => {
      // Arm the one-shot completed-banner celebration (survives the RSC refresh).
      try {
        window.sessionStorage.setItem(celebrationStorageKey(engagementId), '1');
      } catch {
        // sessionStorage unavailable (private mode) — no confetti, no error.
      }
    });
  }, [run, engagementId]);
  const handleChanges = useCallback(
    (note: string): void => {
      setClientModal(null);
      run(requestProjectChangesAction({ engagementId, note }), 'Change request sent');
    },
    [run, engagementId]
  );

  const openWithdraw = useCallback((): void => setWithdrawOpen(true), []);
  const closeWithdraw = useCallback((): void => setWithdrawOpen(false), []);
  const handleWithdraw = useCallback((): void => {
    setWithdrawOpen(false);
    run(withdrawCompletionRequestAction({ engagementId }), 'Completion request withdrawn');
  }, [run, engagementId]);

  if (lens === 'expert') {
    return (
      <div className="mt-3">
        <Button variant="ghost" size="sm" type="button" onClick={openWithdraw} disabled={isPending}>
          <RotateCcw className="size-3.5" aria-hidden />
          Withdraw request
        </Button>

        <WithdrawCompletionModal
          open={withdrawOpen}
          clientCompanyName={clientCompanyName}
          pending={isPending}
          onConfirm={handleWithdraw}
          onCancel={closeWithdraw}
        />
      </div>
    );
  }

  // Admin lens (or a client view missing its decision copy) renders no actions.
  if (lens !== 'client' || clientDecision === null) {
    return null;
  }

  return (
    <div className="mt-3 flex flex-wrap gap-2">
      <button
        type="button"
        onClick={() => setClientModal('accept')}
        disabled={isPending}
        className={cn(
          'focus-visible:ring-ring inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-3 text-sm font-semibold text-white hover:opacity-90 focus-visible:ring-2 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-70',
          PROPOSAL_CTA_GRADIENT_CLASS
        )}
      >
        <ThumbsUp className="size-3.5" aria-hidden />
        Accept project
      </button>
      <Button
        variant="ghost"
        size="sm"
        type="button"
        onClick={() => setClientModal('changes')}
        disabled={isPending}
      >
        <MessageSquare className="size-3.5" aria-hidden />
        Request changes
      </Button>

      <AcceptProjectModal
        open={clientModal === 'accept'}
        body={clientDecision.acceptModalBody}
        pending={isPending}
        onConfirm={handleAccept}
        onCancel={closeClientModal}
      />
      <RequestChangesModal
        open={clientModal === 'changes'}
        intro={clientDecision.requestChangesIntro}
        fieldHint={clientDecision.requestChangesFieldHint}
        pending={isPending}
        onConfirm={handleChanges}
        onCancel={closeClientModal}
      />
    </div>
  );
}

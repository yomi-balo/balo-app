'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Loader2, Shield, X } from 'lucide-react';
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
import {
  declineBodyFor,
  declineTitleFor,
  declineVerbFor,
  type TrackStage,
} from '@/lib/project-request/close-copy';
import { declineTrackAction } from '@/app/(dashboard)/projects/[requestId]/_actions/decline-track';
import { declineTrackAsAdminAction } from '@/app/(dashboard)/projects/[requestId]/_actions/decline-track-as-admin';

/**
 * DeclineTrackDialog — BAL-540 Phase 6.2 (design ref `DeclineConfirm`, `:590-641`). One control
 * per live track, both lenses: the verb follows the stage ("Withdraw invite" for an invitation
 * never answered, "Decline" for an EOI or a proposal). Self-contained — calls the right Server
 * Action for its `variant` directly.
 */

interface DeclineTrackDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  requestId: string;
  relationshipId: string;
  expertName: string;
  partyLabel: string;
  companyName: string;
  stage: TrackStage;
  variant: 'client' | 'admin';
}

export function DeclineTrackDialog({
  open,
  onOpenChange,
  requestId,
  relationshipId,
  expertName,
  partyLabel,
  companyName,
  stage,
  variant,
}: Readonly<DeclineTrackDialogProps>): React.JSX.Element {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const isAdmin = variant === 'admin';
  const noVerb = declineVerbFor(stage);

  const handleOpenChange = useCallback(
    (next: boolean): void => {
      if (pending && !next) return;
      onOpenChange(next);
    },
    [pending, onOpenChange]
  );

  const handleConfirm = useCallback((): void => {
    if (pending) return;
    setPending(true);

    const run = async (): Promise<void> => {
      try {
        const result = isAdmin
          ? await declineTrackAsAdminAction({ requestId, relationshipId })
          : await declineTrackAction({ requestId, relationshipId });

        if (!result.success) {
          toast.error(result.error);
          return;
        }

        track(PROJECT_EVENTS.PROJECT_TRACK_DECLINED, {
          request_id: requestId,
          relationship_id: relationshipId,
          stage: result.analytics.stage,
          actor_kind: result.analytics.actorKind,
          had_open_proposal: result.analytics.hadOpenProposal,
        });

        toast.success(
          stage === 'invited'
            ? `Invite withdrawn — ${partyLabel} has been told` // pending-MJ
            : `Declined — ${partyLabel} has been told` // pending-MJ
        );
        handleOpenChange(false);
        router.refresh();
      } catch {
        toast.error('Could not decline this track. Please try again.'); // pending-MJ
      } finally {
        setPending(false);
      }
    };
    run();
  }, [pending, isAdmin, requestId, relationshipId, stage, partyLabel, handleOpenChange, router]);

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{declineTitleFor(stage, expertName)}</AlertDialogTitle>
          <AlertDialogDescription>{declineBodyFor(stage, partyLabel)}</AlertDialogDescription>
        </AlertDialogHeader>
        {isAdmin && (
          <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
            <Shield className="text-accent-foreground h-3 w-3" aria-hidden="true" />
            {/* pending-MJ */}
            Recorded as you, on {companyName}’s behalf.
          </p>
        )}
        <AlertDialogFooter>
          {/* pending-MJ */}
          <AlertDialogCancel disabled={pending}>Keep</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              handleConfirm();
            }}
            disabled={pending}
          >
            {pending ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <X className="h-4 w-4" aria-hidden="true" />
            )}
            {noVerb}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

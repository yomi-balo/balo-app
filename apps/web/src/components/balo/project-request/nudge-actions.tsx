'use client';

import { useCallback, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { track, PROJECT_EVENTS } from '@/lib/analytics';
import type { RequestLens } from '@/lib/project-request/resolve-request-lens';
import { requestExploratoryMeetingAction } from '@/app/(dashboard)/projects/[requestId]/_actions/request-exploratory-meeting';
import { bookExploratoryMeetingAction } from '@/app/(dashboard)/projects/[requestId]/_actions/book-exploratory';
import { ExpertInviteDialog } from './expert-invite-dialog';

export interface NudgeButtonDescriptor {
  label: string;
  icon: LucideIcon;
}

interface NudgeActionsProps {
  lens: RequestLens;
  status: string;
  requestId: string;
  /**
   * The viewer-expert's own relationship id (`ctx.relationshipId`) — required to
   * deep-link the `build-proposal` CTA to the composer. `null`/absent for the
   * client/admin lenses, which never reach that wired action.
   */
  viewerRelationshipId?: string | null;
  primary?: NudgeButtonDescriptor;
  secondary?: NudgeButtonDescriptor;
}

/**
 * The A2-wired CTAs that live in {@link NudgeActions}, keyed by `${lens}:${status}`.
 * Each names which presentational button slot ('primary'/'secondary') is live and
 * the behavior. Any CTA NOT listed here renders DISABLED (its owning slice wires
 * it later). This keeps `nudgeFor` copy presentational while A2 only lights up the
 * triage/invite/book CTAs it owns.
 */
type WiredAction = 'invite' | 'request-exploratory' | 'book-exploratory' | 'build-proposal';

const WIRED: Record<string, { primary?: WiredAction; secondary?: WiredAction }> = {
  'admin:requested': { primary: 'invite', secondary: 'request-exploratory' },
  'admin:exploratory_meeting_requested': { primary: 'invite' },
  'admin:experts_invited': { secondary: 'invite' },
  'client:exploratory_meeting_requested': { primary: 'book-exploratory' },
  // A6.2 activation gate: copy alone won't enable the CTA — this WIRED entry +
  // the `build-proposal` handler navigate the expert to the proposal composer.
  'expert:proposal_requested': { primary: 'build-proposal' },
};

const PRIMARY_CLASS =
  'from-primary inline-flex min-h-9 items-center gap-2 rounded-[10px] bg-gradient-to-r to-violet-600 px-4 text-[13.5px] font-semibold text-white transition-opacity dark:to-violet-500';
const SECONDARY_CLASS =
  'border-border bg-card text-muted-foreground hover:text-foreground inline-flex min-h-9 items-center gap-1.5 rounded-[10px] border px-3.5 text-[13px] font-medium transition-colors';

/**
 * Interactive CTA island for the nudge bar. Renders the primary/secondary buttons
 * the presentational `NudgeBar` would otherwise draw disabled, wiring the A2 CTAs
 * (invite, request-exploratory, book-exploratory) to Server Actions with toasts +
 * analytics. Unwired CTAs stay disabled.
 */
export function NudgeActions({
  lens,
  status,
  requestId,
  viewerRelationshipId = null,
  primary,
  secondary,
}: Readonly<NudgeActionsProps>): React.JSX.Element {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [inviteOpen, setInviteOpen] = useState(false);
  const wired = WIRED[`${lens}:${status}`] ?? {};

  const runRequestExploratory = useCallback((): void => {
    startTransition(async () => {
      const result = await requestExploratoryMeetingAction({ requestId });
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      track(PROJECT_EVENTS.PROJECT_REQUEST_STATUS_TRANSITIONED, {
        request_id: requestId,
        from: result.from,
        to: result.to,
        actor: 'admin',
        time_to_first_admin_action_ms: result.firstAdminActionMs,
      });
      toast.success('Exploratory call requested — the client has been notified.');
    });
  }, [requestId]);

  const runBookExploratory = useCallback((): void => {
    startTransition(async () => {
      const result = await bookExploratoryMeetingAction({ requestId });
      if (result.success) {
        toast.success(result.confirmation.message);
      } else {
        toast.error(result.error);
      }
    });
  }, [requestId]);

  // A6.2: navigate the expert to the proposal composer. Pure navigation (no
  // status transition), so — matching the local pattern where only state-
  // changing CTAs fire analytics — this fires no event here.
  const runBuildProposal = useCallback((): void => {
    if (viewerRelationshipId === null) return;
    router.push(`/projects/${requestId}/proposal/${viewerRelationshipId}`);
  }, [router, requestId, viewerRelationshipId]);

  const handlerFor = (action: WiredAction | undefined): (() => void) | undefined => {
    if (action === 'invite') return () => setInviteOpen(true);
    if (action === 'request-exploratory') return runRequestExploratory;
    if (action === 'book-exploratory') return runBookExploratory;
    if (action === 'build-proposal') {
      return viewerRelationshipId === null ? undefined : runBuildProposal;
    }
    return undefined;
  };

  const primaryHandler = handlerFor(wired.primary);
  const secondaryHandler = handlerFor(wired.secondary);

  return (
    <div className="mt-3.5 ml-8 flex flex-wrap items-center gap-2.5">
      {primary && (
        <button
          type="button"
          disabled={primaryHandler === undefined || isPending}
          onClick={primaryHandler}
          className={cn(
            PRIMARY_CLASS,
            primaryHandler === undefined && 'opacity-60',
            isPending && 'opacity-70'
          )}
        >
          <primary.icon className="h-3.5 w-3.5" aria-hidden="true" />
          {primary.label}
        </button>
      )}
      {secondary && (
        <button
          type="button"
          disabled={secondaryHandler === undefined || isPending}
          onClick={secondaryHandler}
          className={cn(
            SECONDARY_CLASS,
            secondaryHandler === undefined && 'opacity-60',
            isPending && 'opacity-70'
          )}
        >
          <secondary.icon className="h-3.5 w-3.5" aria-hidden="true" />
          {secondary.label}
        </button>
      )}

      {(wired.primary === 'invite' || wired.secondary === 'invite') && (
        <ExpertInviteDialog
          open={inviteOpen}
          onOpenChange={setInviteOpen}
          requestId={requestId}
          alreadyInvitedIds={[]}
        />
      )}
    </div>
  );
}

'use client';

import { FileText } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { UpcomingCallView } from '@/lib/project-request/conversation-view-types';
import type { CallSlot, RailProposalSlot } from './thread-actions';
import { CallGroup, NextCallLine } from './thread-call-group';

interface MobileActionRailProps {
  /** Hidden while the composer is focused (keyboard up — thumb zone is busy). */
  visible: boolean;
  callSlot: CallSlot;
  callPending: boolean;
  /** The active thread's expert, named above the next-call line while a call is upcoming. */
  expertName: string;
  expertFirstName: string;
  /** The active thread's upcoming calls, soonest first (the "+N more" list). */
  upcomingCalls: readonly UpcomingCallView[];
  /** `/experts/{u}?book=1&src=request_thread`; non-null only when the client books via the profile. */
  profileBookingHref: string | null;
  /** Non-null once kickoff materialized the engagement — the target of a project call's link. */
  deliveryEngagementId: string | null;
  /** Names the other party in the Join button's accessible name. */
  joinPartyLabel: string;
  /** The proposal CTA slot (null = none; `quiet` defers to the nudge). */
  proposalCta: RailProposalSlot | null;
  onCall: () => void;
  onBookAnother: () => void;
  onJoin: (call: UpcomingCallView) => void;
  /**
   * `kind:'request'` proposal CTA handler (client lens, A5). Non-null → the CTA
   * renders; null → the CTA renders nothing.
   */
  onProposal: (() => void) | null;
  /**
   * `kind:'build'` proposal CTA handler (expert lens, A6.2 — opens the
   * composer). Non-null → the CTA renders; null → the CTA renders nothing.
   */
  onBuildProposal: (() => void) | null;
  /**
   * `kind:'view'` proposal CTA handler (BAL-289 / A6.3 — opens the read-only
   * review/submitted surface). Non-null → the CTA renders; null → the CTA
   * renders nothing.
   */
  onViewProposal: (() => void) | null;
}

/** Picks the live handler for the proposal CTA kind. */
function proposalHandlerFor(
  proposalCta: RailProposalSlot | null,
  onProposal: (() => void) | null,
  onBuildProposal: (() => void) | null,
  onViewProposal: (() => void) | null
): (() => void) | null {
  if (proposalCta?.kind === 'request') return onProposal;
  if (proposalCta?.kind === 'build') return onBuildProposal;
  if (proposalCta?.kind === 'view') return onViewProposal;
  return null;
}

/**
 * Mobile action rail (`lg:hidden`) — BELOW the composer, anchored at the true
 * bottom (thumb zone). Surfaces the call group (book / join / propose times) and
 * the primary proposal action (LIVE for the client per BAL-272 / A5, for the expert per
 * BAL-288 / A6.2, and the `kind:'view'` review/submitted link per BAL-289 /
 * A6.3). A proposal CTA whose handler is `null` renders nothing. Returns null when nothing is
 * actionable; hides while the composer is focused (keyboard up).
 */
export function MobileActionRail({
  visible,
  callSlot,
  callPending,
  expertName,
  expertFirstName,
  upcomingCalls,
  profileBookingHref,
  deliveryEngagementId,
  joinPartyLabel,
  proposalCta,
  onCall,
  onBookAnother,
  onJoin,
  onProposal,
  onBuildProposal,
  onViewProposal,
}: Readonly<MobileActionRailProps>): React.JSX.Element | null {
  // Map the handler by kind: `request` → client A5, `build` → expert A6.2,
  // `view` → the A6.3 review/submitted link (mirrors the desktop header).
  const proposalHandler = proposalHandlerFor(
    proposalCta,
    onProposal,
    onBuildProposal,
    onViewProposal
  );
  const showProposal = proposalCta !== null && proposalHandler !== null;
  if (!visible || (callSlot.kind === 'none' && !showProposal)) return null;

  return (
    <div className="border-border bg-muted/40 flex flex-col gap-2 border-t px-3.5 py-2.5 lg:hidden">
      {callSlot.kind === 'upcoming' && (
        <div className="min-w-0">
          <p className="text-foreground truncate text-sm font-semibold">{expertName}</p>
          <NextCallLine
            slot={callSlot}
            upcomingCalls={upcomingCalls}
            deliveryEngagementId={deliveryEngagementId}
          />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <CallGroup
          slot={callSlot}
          mobile
          callPending={callPending}
          profileBookingHref={profileBookingHref}
          expertFirstName={expertFirstName}
          joinPartyLabel={joinPartyLabel}
          onCall={onCall}
          onBookAnother={onBookAnother}
          onJoin={onJoin}
        />
        {showProposal && (
          <button
            type="button"
            onClick={proposalHandler}
            className={cn(
              'focus-visible:ring-ring inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-[11px] px-4 text-sm font-bold transition-opacity focus-visible:ring-2 focus-visible:outline-none active:opacity-90',
              proposalCta.kind === 'view' || proposalCta.quiet
                ? 'border-primary/30 bg-primary/5 text-primary border'
                : 'bg-primary text-primary-foreground'
            )}
          >
            <FileText className="h-4 w-4" aria-hidden="true" />
            {proposalCta.label}
          </button>
        )}
      </div>
    </div>
  );
}

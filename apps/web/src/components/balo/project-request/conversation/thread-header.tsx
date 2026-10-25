'use client';

import { Clock, FileText, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type {
  ConversationThreadView,
  UpcomingCallView,
} from '@/lib/project-request/conversation-view-types';
import type { ThreadActions } from './thread-actions';
import { CallGroup, NextCallLine } from './thread-call-group';
import { InitialsAvatar } from '@/components/balo/conversation/initials-avatar';
import { declineVerbFor } from '@/lib/project-request/close-copy';

interface ThreadHeaderProps {
  thread: ConversationThreadView;
  showYouSuffix: boolean;
  actions: ThreadActions;
  callPending: boolean;
  /** `/experts/{u}?book=1&src=request_thread`; non-null only when the client books via the profile. */
  profileBookingHref: string | null;
  /** Non-null once kickoff materialized the engagement — the target of a project call's link. */
  deliveryEngagementId: string | null;
  /** Names the other party in the Join button's accessible name. */
  joinPartyLabel: string;
  onCall: () => void;
  onBookAnother: () => void;
  onJoin: (call: UpcomingCallView) => void;
  /**
   * The `kind:'request'` proposal CTA handler (client lens, A5). Non-null →
   * the slot renders; null → the slot renders nothing.
   */
  onRequestProposal: (() => void) | null;
  /**
   * The `kind:'build'` proposal CTA handler (expert lens, A6.2 — opens the
   * composer). Non-null → the slot renders; null → the slot renders nothing.
   */
  onBuildProposal: (() => void) | null;
  /**
   * The `kind:'view'` proposal CTA handler (BAL-289 / A6.3 — opens the read-only
   * review/submitted surface). Non-null → the slot renders; null → the slot
   * renders nothing.
   */
  onViewProposal: (() => void) | null;
  /**
   * BAL-540 — the client's per-track "no" control. Non-null → renders ENABLED with
   * `actions.declineSlot`'s verb ("Decline" / "Withdraw invite"); `null` → the slot is omitted
   * entirely (no `declineSlot`, so nothing to decline from here).
   */
  onDecline: (() => void) | null;
}

/** The solid proposal commit CTA; `quiet` defers to the nudge that already pushes it. */
function ProposalCtaButton({
  label,
  quiet,
  onClick,
}: Readonly<{ label: string; quiet: boolean; onClick: () => void }>): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'focus-visible:ring-ring inline-flex min-h-9 items-center gap-1.5 rounded-[9px] px-3.5 text-[13px] font-bold transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:outline-none',
        quiet
          ? 'border-primary/30 bg-primary/5 text-primary border'
          : 'bg-primary text-primary-foreground'
      )}
    >
      <FileText className="h-3.5 w-3.5" aria-hidden="true" />
      {label}
    </button>
  );
}

/**
 * Desktop-only thread header (`hidden lg:flex` applied by the stage): avatar,
 * expert name with the next-call line, the lens-aware call group (book / join /
 * propose times) and the proposal slot per the gating matrix.
 *
 * ⚠ NO FILES PILL — RETIRED BY BAL-431 (OSD-2), NOT MISSING. The request surface has exactly
 * ONE file home now, `RequestFilesPanel` (request-level, audience-aware), so the in-thread
 * files drawer this pill toggled — and the `fileCount` / `filesOpen` / `onToggleFiles` props
 * that fed it — are gone. Do not reinstate them here; a second file home on this surface is
 * the shape ADR-1048 rejected. The CASE surface keeps its own in-thread files, untouched.
 *
 * The client's "Request proposal" CTA is
 * LIVE (BAL-272 / A5) when `onRequestProposal` is provided; the expert's "Build
 * proposal" CTA is LIVE (BAL-288 / A6.2) when `onBuildProposal` is provided; the
 * "View proposal"/"View submitted proposal" CTA is LIVE (BAL-289 / A6.3) when
 * `onViewProposal` is provided. A proposal CTA whose handler is `null` renders nothing — there
 * is no disabled stub. Deliberate cut (recorded): no rating/role subline — that data isn't
 * hydrated.
 */
export function ThreadHeader({
  thread,
  showYouSuffix,
  actions,
  callPending,
  profileBookingHref,
  deliveryEngagementId,
  joinPartyLabel,
  onCall,
  onBookAnother,
  onJoin,
  onRequestProposal,
  onBuildProposal,
  onViewProposal,
  onDecline,
}: Readonly<ThreadHeaderProps>): React.JSX.Element {
  const { headerProposal, declineSlot } = actions;
  return (
    <div className="border-border flex flex-wrap items-center gap-x-2.5 gap-y-2 border-b px-4 py-3">
      <InitialsAvatar initials={thread.expertInitials} size="md" />
      <div className="min-w-[10rem] flex-1">
        <p className="text-foreground truncate text-sm font-semibold">
          {thread.expertName}
          {showYouSuffix && <span className="text-muted-foreground ml-1.5 text-[11px]">(you)</span>}
        </p>
        <NextCallLine
          slot={actions.callSlot}
          upcomingCalls={thread.upcomingCalls}
          deliveryEngagementId={deliveryEngagementId}
        />
      </div>

      <CallGroup
        slot={actions.callSlot}
        mobile={false}
        callPending={callPending}
        profileBookingHref={profileBookingHref}
        expertFirstName={thread.expertFirstName}
        joinPartyLabel={joinPartyLabel}
        onCall={onCall}
        onBookAnother={onBookAnother}
        onJoin={onJoin}
      />

      {headerProposal?.kind === 'pill-requested' && (
        <span className="border-warning/30 bg-warning/10 text-warning animate-in fade-in zoom-in-95 inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3.5 text-xs font-semibold motion-reduce:animate-none">
          <Clock className="h-3.5 w-3.5" aria-hidden="true" />
          Proposal requested
        </span>
      )}
      {headerProposal?.kind === 'pill-awaiting' && (
        <span
          aria-disabled="true"
          className="border-border bg-muted/50 text-muted-foreground inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3.5 text-xs font-medium"
        >
          <FileText className="h-3.5 w-3.5" aria-hidden="true" />
          Awaiting proposal request
        </span>
      )}
      {headerProposal?.kind === 'view' && onViewProposal !== null && (
        <button
          type="button"
          onClick={onViewProposal}
          className="border-primary/30 bg-primary/5 text-primary focus-visible:ring-ring inline-flex min-h-9 items-center gap-1.5 rounded-[9px] border px-3 text-[12.5px] font-semibold transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:outline-none"
        >
          <FileText className="h-3.5 w-3.5" aria-hidden="true" />
          {headerProposal.label}
        </button>
      )}
      {headerProposal?.kind === 'request' && onRequestProposal !== null && (
        <ProposalCtaButton
          label={headerProposal.label}
          quiet={headerProposal.quiet}
          onClick={onRequestProposal}
        />
      )}
      {headerProposal?.kind === 'build' && onBuildProposal !== null && (
        <ProposalCtaButton
          label={headerProposal.label}
          quiet={headerProposal.quiet}
          onClick={onBuildProposal}
        />
      )}
      {declineSlot !== null && onDecline !== null && (
        <button
          type="button"
          onClick={onDecline}
          aria-label={`${declineVerbFor(declineSlot)} ${thread.expertName}`}
          className="border-border bg-card text-muted-foreground hover:border-destructive/40 hover:text-destructive focus-visible:ring-ring flex h-9 w-9 shrink-0 items-center justify-center rounded-[9px] border transition-colors focus-visible:ring-2 focus-visible:outline-none"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

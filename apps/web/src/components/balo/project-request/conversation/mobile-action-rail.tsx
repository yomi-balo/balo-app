'use client';

import { Calendar, FileText, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { CallSlot, RailProposalSlot } from './thread-actions';

interface MobileActionRailProps {
  /** Hidden while the composer is focused (keyboard up — thumb zone is busy). */
  visible: boolean;
  callSlot: CallSlot;
  callPending: boolean;
  /** The proposal CTA slot (null = none; `quiet` defers to the nudge). */
  proposalCta: RailProposalSlot | null;
  onCall: () => void;
  /**
   * `kind:'request'` proposal CTA handler (client lens, A5). Non-null → the CTA
   * renders ENABLED; null → disabled stub.
   */
  onProposal: (() => void) | null;
  /**
   * `kind:'build'` proposal CTA handler (expert lens, A6.2 — opens the
   * composer). Non-null → the CTA renders ENABLED; null → disabled stub.
   */
  onBuildProposal: (() => void) | null;
  /**
   * `kind:'view'` proposal CTA handler (BAL-289 / A6.3 — opens the read-only
   * review/submitted surface). Non-null → the CTA renders ENABLED; null →
   * disabled stub (defensive).
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
 * bottom (thumb zone). Surfaces the call CTA (BAL-283 — real booking / share-availability) +
 * the primary proposal action (LIVE for the client per BAL-272 / A5, for the expert per
 * BAL-288 / A6.2, and the `kind:'view'` review/submitted link per BAL-289 /
 * A6.3). Returns null when nothing is actionable; hides while the composer is
 * focused (keyboard up).
 */
export function MobileActionRail({
  visible,
  callSlot,
  callPending,
  proposalCta,
  onCall,
  onProposal,
  onBuildProposal,
  onViewProposal,
}: Readonly<MobileActionRailProps>): React.JSX.Element | null {
  const showCallButton = callSlot.kind === 'book' || callSlot.kind === 'propose';
  const showSharedPill = callSlot.kind === 'shared';
  if (!visible || (!showCallButton && !showSharedPill && proposalCta === null)) return null;

  // Map the handler by kind: `request` → client A5, `build` → expert A6.2,
  // `view` → the A6.3 review/submitted link (mirrors the desktop header).
  const proposalHandler = proposalHandlerFor(
    proposalCta,
    onProposal,
    onBuildProposal,
    onViewProposal
  );

  return (
    <div className="border-border bg-muted/40 flex items-center gap-2 border-t px-3.5 py-2.5 lg:hidden">
      {showCallButton && (
        <button
          type="button"
          onClick={onCall}
          disabled={callPending}
          className="border-border bg-card text-muted-foreground focus-visible:ring-ring inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-[11px] border px-3.5 text-[13px] font-semibold focus-visible:ring-2 focus-visible:outline-none disabled:opacity-60"
        >
          {callPending ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Calendar className="h-4 w-4" aria-hidden="true" />
          )}
          {callSlot.kind === 'propose' ? 'Propose times' : 'Book a call'}
        </button>
      )}
      {/* BAL-283 — same rail slot, quiet pill treatment; reuses the rail's existing
          disabled-button chrome rather than inventing mobile-specific pill styling. */}
      {showSharedPill && (
        <span
          aria-disabled="true"
          className="border-border bg-card text-muted-foreground inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-[11px] border px-3.5 text-[13px] font-semibold opacity-60"
        >
          <Calendar className="h-4 w-4" aria-hidden="true" />
          Availability shared
        </span>
      )}
      {proposalCta !== null && (
        <button
          type="button"
          onClick={proposalHandler ?? undefined}
          disabled={proposalHandler === null}
          aria-disabled={proposalHandler === null ? true : undefined}
          className={cn(
            'focus-visible:ring-ring inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-[11px] px-4 text-sm font-bold transition-opacity focus-visible:ring-2 focus-visible:outline-none',
            proposalHandler === null ? 'opacity-60' : 'active:opacity-90',
            proposalCta.kind === 'view' || proposalCta.quiet
              ? 'border-primary/30 bg-primary/5 text-primary border'
              : 'from-primary bg-gradient-to-r to-violet-600 text-white dark:to-violet-500'
          )}
        >
          <FileText className="h-4 w-4" aria-hidden="true" />
          {proposalCta.label}
        </button>
      )}
    </div>
  );
}

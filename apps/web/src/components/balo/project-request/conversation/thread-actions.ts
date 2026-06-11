import type { ProjectRequestStatus } from '@/lib/project-request/resolve-request-lens';
import {
  requestStatusRank,
  type ConversationThreadView,
} from '@/lib/project-request/conversation-view-types';

/**
 * Pure deriver for the per-thread action chrome (desktop header + mobile rail)
 * — the design's `callAllowed` / `showProposalAction` matrix over
 * `lens × requestStatus × relationshipStatus`. The client's `kind:'request'`
 * proposal CTA is LIVE (BAL-272 / A5), the expert's `kind:'build'` CTA is LIVE
 * (BAL-288 / A6.2 — navigates to the proposal composer), and the `kind:'view'`
 * CTA is LIVE (BAL-289 / A6.3 — navigates to the read-only review/submitted
 * surface). The call CTA is wired (mock seam).
 */

export type HeaderProposalSlot =
  | { kind: 'pill-requested' } // client, rel proposal_requested — warning pill
  | { kind: 'pill-awaiting' } // expert, rel eoi_submitted — muted pill
  | { kind: 'view'; label: string } // rel ≥ proposal_submitted — live (BAL-289) review/submitted link
  | { kind: 'request'; label: string; quiet: boolean } // client A5 live CTA — gradient
  | { kind: 'build'; label: string; quiet: boolean }; // expert A6 live CTA — gradient

export type RailProposalSlot = {
  /**
   * `request` = the live A5 client commit CTA; `build` = the live A6 expert
   * composer CTA; `view` = the live A6.3 (BAL-289) review/submitted link.
   */
  kind: 'request' | 'view' | 'build';
  label: string;
  quiet: boolean;
};

export interface ThreadActions {
  /** Call CTA renders (header) — before kickoff, active threads only. */
  callAllowed: boolean;
  callLabel: string;
  headerProposal: HeaderProposalSlot | null;
  /** Mobile rail: call button (collapses past acceptance). */
  showCallOnRail: boolean;
  /** Mobile rail: proposal CTA (null = none; quiet defers to the nudge). */
  railProposal: RailProposalSlot | null;
}

function deriveHeaderProposal(
  lens: 'client' | 'expert',
  relationshipStatus: string,
  nudgeIsProposal: boolean
): HeaderProposalSlot | null {
  if (lens === 'client' && relationshipStatus === 'proposal_requested') {
    return { kind: 'pill-requested' };
  }
  if (lens === 'expert' && relationshipStatus === 'eoi_submitted') {
    return { kind: 'pill-awaiting' };
  }
  if (relationshipStatus === 'proposal_submitted' || relationshipStatus === 'accepted') {
    return { kind: 'view', label: lens === 'expert' ? 'View submitted' : 'View proposal' };
  }
  if (lens === 'client' && relationshipStatus === 'eoi_submitted') {
    return { kind: 'request', label: 'Request proposal', quiet: nudgeIsProposal };
  }
  if (lens === 'expert' && relationshipStatus === 'proposal_requested') {
    return { kind: 'build', label: 'Build proposal', quiet: nudgeIsProposal };
  }
  return null;
}

function deriveRailProposal(
  lens: 'client' | 'expert',
  relationshipStatus: string,
  pastAcceptance: boolean,
  nudgeIsProposal: boolean
): RailProposalSlot | null {
  if (pastAcceptance) return null;
  if (lens === 'client' && relationshipStatus === 'eoi_submitted') {
    return { kind: 'request', label: 'Request proposal', quiet: nudgeIsProposal };
  }
  if (lens === 'expert' && relationshipStatus === 'proposal_requested') {
    return { kind: 'build', label: 'Build proposal', quiet: nudgeIsProposal };
  }
  if (lens === 'client' && relationshipStatus === 'proposal_submitted') {
    // The live A6.3 (BAL-289) review link — wired via `onViewProposal`, never
    // to the A5 request-proposal flow (the header's `kind:'view'` twin).
    return { kind: 'view', label: 'View proposal', quiet: nudgeIsProposal };
  }
  return null;
}

export function deriveThreadActions(input: {
  lens: 'client' | 'expert';
  requestStatus: ProjectRequestStatus;
  thread: ConversationThreadView;
  /** True when the active nudge's primary CTA already pushes the proposal. */
  nudgeIsProposal: boolean;
}): ThreadActions {
  const { lens, requestStatus, thread, nudgeIsProposal } = input;
  const rank = requestStatusRank(requestStatus);
  const beforeKickoff = rank < requestStatusRank('kickoff_approved');
  const pastAcceptance = rank >= requestStatusRank('accepted');
  const callAllowed = beforeKickoff && thread.stage === 'active';

  return {
    callAllowed,
    callLabel: lens === 'expert' ? 'Propose times' : 'Book a call',
    // Design: the proposal slot shares the call gate (hidden once decided).
    headerProposal: callAllowed
      ? deriveHeaderProposal(lens, thread.relationshipStatus, nudgeIsProposal)
      : null,
    showCallOnRail: callAllowed && !pastAcceptance,
    railProposal: deriveRailProposal(
      lens,
      thread.relationshipStatus,
      pastAcceptance,
      nudgeIsProposal
    ),
  };
}

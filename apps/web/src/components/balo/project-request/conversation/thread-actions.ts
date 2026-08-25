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
 * surface). The call CTA is wired to real booking (BAL-283).
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

/**
 * BAL-283 (plan §12.3) — the call-CTA slot as ONE derived discriminated union, so header, rail
 * and nudge cannot disagree about what state this thread's call is in.
 *
 *   'none'    — call CTA not offered at all (past kickoff, or thread not active)
 *   'book'    — client, nothing booked yet: "Book a call" opens the live-availability dialog
 *   'propose' — expert, has not yet shared availability: "Propose times" (share + nudge)
 *   'shared'  — expert, `availability_shared_at` is set: quiet, non-interactive pill
 *   'booked'  — either lens, a live request_interaction meeting exists: the slot is REMOVED
 *               from header/rail (there is nothing left to book against this relationship at
 *               this stage); `scheduledStartIso` carries the meeting's window for the nudge's
 *               "done" copy.
 */
export type CallSlot =
  | { kind: 'none' }
  | { kind: 'book' }
  | { kind: 'propose' }
  | { kind: 'shared' }
  | { kind: 'booked'; scheduledStartIso: string };

export interface ThreadActions {
  callSlot: CallSlot;
  headerProposal: HeaderProposalSlot | null;
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

/**
 * BAL-283 — the call-slot derivation, isolated so its precedence is legible in one place:
 * BOOKED beats everything (nothing left to book), then the lens-specific progression.
 *
 * ⚠ `'booked'` IS A REAL LIMIT, NOT ONLY A DISPLAY STATE (round-1 security MEDIUM). The
 * matching server-side guard is `assertNoLiveIntroCall`, called by `bookIntroCallAction`, and
 * it asks the IDENTICAL question through the SAME shared `pickUpcomingContextMeeting` that
 * produced `thread.bookedCall` here. Before that guard existed this precedence was browser-only
 * and a fresh client-minted `bookingNonce` booked straight past it.
 *
 * ⚠ AND `bookedCall` MEANS "an UPCOMING call", never "a call ever happened" — an ENDED intro
 * call resolves to `null` upstream, so the CTA correctly returns for a second conversation.
 */
function deriveCallSlot(input: {
  lens: 'client' | 'expert';
  callAllowed: boolean;
  availabilitySharedAtIso: string | null;
  bookedCall: { meetingId: string; scheduledStartIso: string } | null;
}): CallSlot {
  const { lens, callAllowed, availabilitySharedAtIso, bookedCall } = input;
  if (bookedCall !== null) {
    return { kind: 'booked', scheduledStartIso: bookedCall.scheduledStartIso };
  }
  if (!callAllowed) {
    return { kind: 'none' };
  }
  if (lens === 'client') {
    return { kind: 'book' };
  }
  return availabilitySharedAtIso === null ? { kind: 'propose' } : { kind: 'shared' };
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

  const callSlot = deriveCallSlot({
    lens,
    callAllowed,
    availabilitySharedAtIso: thread.availabilitySharedAtIso,
    bookedCall: thread.bookedCall,
  });

  return {
    callSlot,
    // Design: the proposal slot shares the call gate (hidden once decided).
    headerProposal: callAllowed
      ? deriveHeaderProposal(lens, thread.relationshipStatus, nudgeIsProposal)
      : null,
    railProposal: deriveRailProposal(
      lens,
      thread.relationshipStatus,
      pastAcceptance,
      nudgeIsProposal
    ),
  };
}

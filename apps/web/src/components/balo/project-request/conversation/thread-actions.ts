import type { ConversationCallRoute } from '@/lib/analytics';
import type { ProjectRequestStatus } from '@/lib/project-request/resolve-request-lens';
import {
  requestStatusRank,
  type ConversationThreadView,
  type ThreadStage,
  type UpcomingCallView,
} from '@/lib/project-request/conversation-view-types';
import { narrowToTrackStage, type TrackStage } from '@/lib/project-request/close-copy';

/**
 * Pure deriver for the per-thread action chrome (desktop header + mobile rail)
 * — the design's `callAllowed` / `showProposalAction` matrix over
 * `lens × requestStatus × relationshipStatus`. The client's `kind:'request'`
 * proposal CTA is LIVE (BAL-272 / A5), the expert's `kind:'build'` CTA is LIVE
 * (BAL-288 / A6.2 — navigates to the proposal composer), and the `kind:'view'`
 * CTA is LIVE (BAL-289 / A6.3 — navigates to the read-only review/submitted
 * surface). The call CTA is wired to real booking (BAL-283) and, from BAL-616, is offered on
 * every stage the client can still talk to the expert in.
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
 * The call-CTA slot as ONE derived discriminated union, so header, rail and nudge cannot
 * disagree about what state this thread's call is in (BAL-283, reshaped by BAL-616).
 *
 *   'none'     — no call control (a client with no expert profile to book through; an expert
 *                past kickoff or off an active thread)
 *   'book'     — client, nothing upcoming: "Book a call". `route: 'in_place'` opens the
 *                live-availability dialog; `'profile'` links to the expert's profile, for a
 *                thread the request has moved on from (declined, not selected, closed)
 *   'upcoming' — a call is booked and live in this thread: `next` is the soonest, `more` the
 *                count behind it, `canBookAnother` is client-only
 *   'propose'  — expert, has not yet shared availability: "Propose times" (share + nudge)
 *   'shared'   — expert, `availability_shared_at` is set: quiet, non-interactive pill
 */
export type CallSlot =
  | { kind: 'none' }
  | { kind: 'book'; route: 'in_place' | 'profile' }
  | { kind: 'upcoming'; next: UpcomingCallView; more: number; canBookAnother: boolean }
  | { kind: 'propose' }
  | { kind: 'shared' };

export interface ThreadActions {
  callSlot: CallSlot;
  headerProposal: HeaderProposalSlot | null;
  /** Mobile rail: proposal CTA (null = none; quiet defers to the nudge). */
  railProposal: RailProposalSlot | null;
  /**
   * BAL-540 — the client's "no" control on this thread (plan §6.2's decline placement: on the
   * conversation thread header, client lens only — the admin decline control lives on the
   * observer relationships panel instead, a different component tree entirely). Non-null only
   * when the caller's `canDecline` holds AND `thread.stage === 'active'` (a won/decided/closed
   * thread has nothing left to decline). The `TrackStage` value is `thread.relationshipStatus`
   * narrowed — always one of the four declinable stages while the thread is `'active'`.
   */
  declineSlot: TrackStage | null;
}

function deriveHeaderProposal(
  lens: 'client' | 'expert',
  relationshipStatus: string,
  revising: boolean,
  nudgeIsProposal: boolean
): HeaderProposalSlot | null {
  if (lens === 'client' && relationshipStatus === 'proposal_requested') {
    return { kind: 'pill-requested' };
  }
  if (lens === 'expert' && relationshipStatus === 'eoi_submitted') {
    return { kind: 'pill-awaiting' };
  }
  // The client sent the proposal back — the expert's next step is the revise
  // composer, so it gets the commit CTA rather than a quiet "view" link.
  if (lens === 'expert' && relationshipStatus === 'proposal_submitted' && revising) {
    return { kind: 'build', label: 'Revise proposal', quiet: nudgeIsProposal };
  }
  if (relationshipStatus === 'proposal_submitted' || relationshipStatus === 'accepted') {
    return { kind: 'view', label: lens === 'expert' ? 'View submitted proposal' : 'View proposal' };
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
  revising: boolean,
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
  if (lens === 'expert' && relationshipStatus === 'proposal_submitted' && revising) {
    return { kind: 'build', label: 'Revise proposal', quiet: nudgeIsProposal };
  }
  if (lens === 'client' && relationshipStatus === 'proposal_submitted') {
    // The live A6.3 (BAL-289) review link — wired via `onViewProposal`, never
    // to the A5 request-proposal flow (the header's `kind:'view'` twin).
    return { kind: 'view', label: 'View proposal', quiet: nudgeIsProposal };
  }
  return null;
}

/**
 * The call-slot derivation, isolated so its precedence is legible in one place: an upcoming
 * call on an in-place thread beats everything, then the lens-specific progression.
 *
 * "In place" is `active` or `won` — the stages the conversation is still live in. A thread the
 * request moved on from shows no upcoming call (its calls belong to a relationship the client
 * is no longer working with) and routes the client to the expert's profile to book instead.
 *
 * ⚠ THE SAME ROUTE APPLIES ONCE THE REQUEST IS `kickoff_approved` BUT ITS DELIVERY ENGAGEMENT IS
 * NO LONGER `active` (completed or cancelled — the request status never moves off
 * `kickoff_approved` when the project ends). `apps/api` refuses a `project_call` on a
 * non-`active` engagement, so an in-place dialog would end in "This request has moved on". Calls
 * already booked stay visible; only the ability to book another goes.
 *
 * ⚠ `upcomingCalls` MEANS "UPCOMING", never "a call ever happened": ended calls are filtered
 * upstream by `isUpcomingContextMeeting`, so the CTA returns once a call has happened. The cap
 * on how many may be upcoming is enforced by the booking action, not here — "Book another call"
 * stays visible at the cap and answers with the cap copy.
 */
function deriveCallSlot(input: {
  lens: 'client' | 'expert';
  stage: ThreadStage;
  beforeKickoff: boolean;
  availabilitySharedAtIso: string | null;
  upcomingCalls: readonly UpcomingCallView[];
  expertUsername: string | null;
  deliveryEnded: boolean;
}): CallSlot {
  const {
    lens,
    stage,
    beforeKickoff,
    availabilitySharedAtIso,
    upcomingCalls,
    expertUsername,
    deliveryEnded,
  } = input;
  const inPlace = stage === 'active' || stage === 'won';
  const [next] = upcomingCalls;
  if (inPlace && next !== undefined) {
    return {
      kind: 'upcoming',
      next,
      more: upcomingCalls.length - 1,
      canBookAnother: lens === 'client' && !deliveryEnded,
    };
  }
  if (lens === 'expert') {
    if (!(stage === 'active' && beforeKickoff)) return { kind: 'none' };
    return availabilitySharedAtIso === null ? { kind: 'propose' } : { kind: 'shared' };
  }
  if (inPlace && !deliveryEnded) return { kind: 'book', route: 'in_place' };
  return expertUsername === null ? { kind: 'none' } : { kind: 'book', route: 'profile' };
}

/**
 * The call slot for one thread — the single entry point for both `deriveThreadActions` and the
 * stage's click handlers, so what the header shows and what a click tracks cannot diverge.
 */
export function deriveThreadCallSlot(input: {
  lens: 'client' | 'expert';
  requestStatus: ProjectRequestStatus;
  thread: ConversationThreadView;
  /**
   * True when the request's delivery engagement is `active`. Only read at `kickoff_approved`,
   * where a completed or cancelled engagement stops accepting `project_call` bookings. Defaults
   * `true` so every call site outside the page's kickoff window is unaffected.
   */
  deliveryActive?: boolean;
}): CallSlot {
  const { lens, requestStatus, thread, deliveryActive = true } = input;
  return deriveCallSlot({
    lens,
    stage: thread.stage,
    beforeKickoff: requestStatusRank(requestStatus) < requestStatusRank('kickoff_approved'),
    availabilitySharedAtIso: thread.availabilitySharedAtIso,
    upcomingCalls: thread.upcomingCalls,
    expertUsername: thread.expertUsername,
    deliveryEnded: requestStatus === 'kickoff_approved' && !deliveryActive,
  });
}

/**
 * How a client's call click reaches the booking flow: `in_place` opens the dialog on this page,
 * `profile` navigates to the expert's profile. `null` for slots that book nothing (the expert's
 * propose/shared pill, or no call control at all).
 */
export function callRouteOf(slot: CallSlot): ConversationCallRoute | null {
  if (slot.kind === 'upcoming') return 'in_place';
  if (slot.kind === 'book') return slot.route;
  return null;
}

export function deriveThreadActions(input: {
  lens: 'client' | 'expert';
  requestStatus: ProjectRequestStatus;
  thread: ConversationThreadView;
  /** True when the active nudge's primary CTA already pushes the proposal. */
  nudgeIsProposal: boolean;
  /**
   * BAL-540 — true when the viewer holds `CAPABILITIES.MANAGE_REQUESTS` on the request's
   * company (resolved server-side, threaded down as a boolean — never re-derived here from a
   * lens/role check, ADR-1029). Always `false` for the expert lens (an expert never declines
   * their own track from this control; that is `withdraw-eoi.ts`'s separate surface).
   * Optional, defaulting `false`, so every pre-existing call site (this file's own test suite
   * included) keeps compiling unchanged.
   */
  canDecline?: boolean;
  /** See {@link deriveThreadCallSlot}. */
  deliveryActive?: boolean;
}): ThreadActions {
  const {
    lens,
    requestStatus,
    thread,
    nudgeIsProposal,
    canDecline = false,
    deliveryActive = true,
  } = input;
  const rank = requestStatusRank(requestStatus);
  const beforeKickoff = rank < requestStatusRank('kickoff_approved');
  const pastAcceptance = rank >= requestStatusRank('accepted');
  const proposalAllowed = beforeKickoff && thread.stage === 'active';
  const revising = thread.changeRequest !== null;

  const callSlot = deriveThreadCallSlot({ lens, requestStatus, thread, deliveryActive });

  return {
    callSlot,
    // The proposal slot is hidden once the thread is decided or past kickoff.
    headerProposal: proposalAllowed
      ? deriveHeaderProposal(lens, thread.relationshipStatus, revising, nudgeIsProposal)
      : null,
    railProposal: deriveRailProposal(
      lens,
      thread.relationshipStatus,
      revising,
      pastAcceptance,
      nudgeIsProposal
    ),
    declineSlot:
      canDecline && thread.stage === 'active'
        ? narrowToTrackStage(thread.relationshipStatus)
        : null,
  };
}

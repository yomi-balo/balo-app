import {
  Briefcase,
  Calendar,
  Check,
  Clock,
  DollarSign,
  FileText,
  MessageSquare,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import type { ProjectRequestStatus } from './resolve-request-lens';
import { requestStatusRank, type ConversationThreadView } from './conversation-view-types';

/**
 * Per-thread nudge copy matrices (BAL-271 / A4) — the design reference's
 * `threadNudge` (client lens) + `expertSelfNudge` (expert lens), adapted to
 * real data: names interpolate `thread.expertFirstName`; the design's demo
 * "last message" sub is carried by `thread.latestMessagePreview`.
 *
 * Pure + client-safe. `reply` (focus composer), `call` (mock action) and
 * `build` (open the proposal composer — BAL-288 / A6.2) are wired; `stub`
 * renders disabled (A5/A6.3/billing CTAs).
 *
 * KEYING (BAL-272): the pre-decision proposal cells (`eoi_submitted` /
 * `proposal_requested` / `proposal_submitted`) key off THIS THREAD's
 * `relationshipStatus` — A5 makes relationship statuses diverge across threads,
 * and the request status is the max-progress aggregate (another thread's
 * progress must never change this thread's copy). The `accepted` /
 * `kickoff_approved` cells stay REQUEST-keyed (the decision is request-level;
 * `stage` carries the per-thread outcome).
 */

export type ThreadNudgeAction = 'reply' | 'call' | 'build' | 'stub';

export interface ThreadNudgeButton {
  label: string;
  icon: LucideIcon;
  action: ThreadNudgeAction;
}

export interface ThreadNudgeContent {
  variant: 'action' | 'waiting' | 'commit' | 'done';
  icon: LucideIcon;
  headline: string;
  sub?: string;
  /**
   * Composer placeholder override (design's `placeholder.prefill` mechanism) —
   * set on the client-lens unread nudge so the composer invites the reply.
   */
  composerPlaceholder?: string;
  primary?: ThreadNudgeButton;
  secondary?: ThreadNudgeButton;
}

function clientNudge(
  status: ProjectRequestStatus,
  thread: ConversationThreadView
): ThreadNudgeContent | null {
  const name = thread.expertFirstName;
  const preview = thread.latestMessagePreview ?? undefined;

  // accepted / kickoff_approved — the REQUEST is decided; outcome cells come
  // first so a thread frozen mid-flight (e.g. still `eoi_submitted`) shows the
  // records copy, not a stale pre-decision prompt.
  if (requestStatusRank(status) >= requestStatusRank('accepted')) {
    if (thread.stage === 'not_selected') {
      return {
        variant: 'done',
        icon: MessageSquare,
        headline: `You didn't select ${name}`,
        sub: "They've been notified graciously. The conversation stays here for your records.",
      };
    }
    return {
      variant: 'done',
      icon: Zap,
      headline: `${name} is your expert`,
      sub: preview,
      primary: { label: 'Open project workspace', icon: Briefcase, action: 'stub' },
    };
  }

  // "Reply to keep momentum" while the LATEST message is the expert's — not
  // just while the unread dot shows (activating the tab clears the dot but
  // the inbound message still wants an answer).
  const needsReply =
    thread.unread || (!thread.latestMessageFromViewer && thread.latestMessagePreview !== null);

  if (thread.relationshipStatus === 'eoi_submitted') {
    if (needsReply) {
      return {
        variant: 'action',
        icon: MessageSquare,
        headline: `${name} sent a message — reply to keep momentum`,
        sub: preview,
        composerPlaceholder: `Reply to ${name}…`,
      };
    }
    return {
      variant: 'action',
      icon: Calendar,
      headline: `Meet ${name} — they're keen to help`,
      sub: 'A quick intro call is the fastest way to gauge fit. Meetings are free.',
      primary: { label: `Book a call with ${name}`, icon: Calendar, action: 'call' },
      secondary: { label: 'Reply by message', icon: MessageSquare, action: 'reply' },
    };
  }

  if (thread.relationshipStatus === 'proposal_requested') {
    return {
      variant: 'waiting',
      icon: Clock,
      headline: `${name} is preparing the proposal`,
      sub: preview,
      secondary: { label: 'Send a message', icon: MessageSquare, action: 'reply' },
    };
  }

  if (thread.relationshipStatus === 'proposal_submitted') {
    return {
      variant: 'commit',
      icon: Check,
      headline: `${name}'s proposal is ready`,
      sub: preview,
      primary: { label: `Accept ${name}'s proposal`, icon: Check, action: 'stub' },
      secondary: { label: 'View full proposal', icon: FileText, action: 'stub' },
    };
  }

  return null;
}

function expertNudge(
  status: ProjectRequestStatus,
  thread: ConversationThreadView
): ThreadNudgeContent | null {
  // The expert lost the request — mirror the client's "records" framing
  // (the design's demo expert always wins, so this cell is Balo-added copy).
  if (thread.stage === 'not_selected') {
    return {
      variant: 'done',
      icon: MessageSquare,
      headline: 'The client went with another expert',
      sub: 'Thanks for engaging — the conversation stays here for your records.',
    };
  }

  // Request decided — the surviving (won) thread shows the REQUEST-keyed
  // kickoff cells regardless of its frozen relationship status.
  if (status === 'accepted') {
    return {
      variant: 'action',
      icon: DollarSign,
      headline: 'Confirm payment terms for kickoff',
      sub: 'The client accepted your proposal. Confirm terms so Balo can invoice and kick off.',
      primary: { label: 'Confirm payment terms', icon: Check, action: 'stub' },
    };
  }

  if (status === 'kickoff_approved') {
    return {
      variant: 'done',
      icon: Zap,
      headline: 'Kicked off — time to deliver',
      sub: 'Milestones are in the workspace. Mark them done as you go.',
      primary: { label: 'Open workspace', icon: Briefcase, action: 'stub' },
    };
  }

  if (thread.relationshipStatus === 'eoi_submitted') {
    return {
      variant: 'action',
      icon: Calendar,
      headline: 'Offer the client a time to talk',
      sub: "Clients don't share calendars — propose a couple of times to get ahead.",
      primary: { label: 'Propose meeting times', icon: Calendar, action: 'call' },
      secondary: { label: 'Send a message', icon: MessageSquare, action: 'reply' },
    };
  }

  if (thread.relationshipStatus === 'proposal_requested') {
    return {
      variant: 'action',
      icon: FileText,
      headline: 'The client requested your proposal — build it',
      sub: 'Lay out scope, milestones and pricing. You can save a draft and submit when ready.',
      primary: { label: 'Build proposal', icon: FileText, action: 'build' },
    };
  }

  if (thread.relationshipStatus === 'proposal_submitted') {
    return {
      variant: 'waiting',
      icon: Clock,
      headline: 'Your proposal is with the client',
      sub: "They're reviewing it alongside others. Keep the conversation warm.",
      secondary: { label: 'Send a message', icon: MessageSquare, action: 'reply' },
    };
  }

  return null;
}

/** The single per-thread nudge for a (lens, request status, thread) cell. */
export function threadNudgeFor(
  lens: 'client' | 'expert',
  requestStatus: ProjectRequestStatus,
  thread: ConversationThreadView
): ThreadNudgeContent | null {
  if (lens === 'client') return clientNudge(requestStatus, thread);
  return expertNudge(requestStatus, thread);
}

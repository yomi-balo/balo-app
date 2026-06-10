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
 * Pure + client-safe. Only `reply` (focus composer) and `call` (mock action)
 * are wired in A4 — `stub` renders disabled (A5/A6/billing CTAs).
 */

export type ThreadNudgeAction = 'reply' | 'call' | 'stub';

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
  // "Reply to keep momentum" while the LATEST message is the expert's — not
  // just while the unread dot shows (activating the tab clears the dot but
  // the inbound message still wants an answer).
  const needsReply =
    thread.unread || (!thread.latestMessageFromViewer && thread.latestMessagePreview !== null);

  if (status === 'eoi_submitted') {
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

  if (status === 'proposal_requested') {
    return {
      variant: 'waiting',
      icon: Clock,
      headline: `${name} is preparing the proposal`,
      sub: preview,
      secondary: { label: 'Send a message', icon: MessageSquare, action: 'reply' },
    };
  }

  if (status === 'proposal_submitted') {
    return {
      variant: 'commit',
      icon: Check,
      headline: `${name}'s proposal is ready`,
      sub: preview,
      primary: { label: `Accept ${name}'s proposal`, icon: Check, action: 'stub' },
      secondary: { label: 'View full proposal', icon: FileText, action: 'stub' },
    };
  }

  // accepted / kickoff_approved
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

  if (status === 'eoi_submitted') {
    return {
      variant: 'action',
      icon: Calendar,
      headline: 'Offer the client a time to talk',
      sub: "Clients don't share calendars — propose a couple of times to get ahead.",
      primary: { label: 'Propose meeting times', icon: Calendar, action: 'call' },
      secondary: { label: 'Send a message', icon: MessageSquare, action: 'reply' },
    };
  }

  if (status === 'proposal_requested') {
    return {
      variant: 'action',
      icon: FileText,
      headline: 'The client requested your proposal — build it',
      sub: 'Deliverables, exclusions, terms, payment schedule.',
      primary: { label: 'Build proposal', icon: FileText, action: 'stub' },
    };
  }

  if (status === 'proposal_submitted') {
    return {
      variant: 'waiting',
      icon: Clock,
      headline: 'Your proposal is with the client',
      sub: "They're reviewing it alongside others. Keep the conversation warm.",
      secondary: { label: 'Send a message', icon: MessageSquare, action: 'reply' },
    };
  }

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

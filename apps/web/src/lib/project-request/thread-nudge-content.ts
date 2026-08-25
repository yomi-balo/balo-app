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
  /**
   * BAL-283 (round-1 W4) — an ABSOLUTE INSTANT plus its trailing clause, for the two
   * booked-call cells. Rendered by `<LocalDateTime>`; NEVER pre-formatted into `sub` here.
   *
   * ⚠⚠ THIS IS A HYDRATION FIX, NOT A REFACTOR. The previous code called
   * `new Intl.DateTimeFormat('en-US', {…})` with NO `timeZone` inside `deriveStageRender`, on
   * the first render of an SSR'd `'use client'` component — so the server formatted in UTC, the
   * browser re-formatted in local time, and every viewer outside UTC got a hydration mismatch.
   * `LocalDateTime`'s own docblock says closing exactly that gap is the entire reason it exists.
   * (CI runs `TZ=UTC`, so no test could ever have caught it.) The locale was wrong too — the
   * house locale is `en-AU`, which `LocalDateTime` uses.
   */
  subInstant?: { iso: string; suffix: string };
  primary?: ThreadNudgeButton;
  secondary?: ThreadNudgeButton;
  /**
   * BAL-283 — the de-emphasised "Share again" re-share affordance on the expert's waiting
   * cell (design's re-share case). Deliberately a THIRD slot, not folded into `secondary`:
   * "Send a message" and "Share again" are both legitimate secondary actions on that one
   * cell, and collapsing them would force a choice the design never makes. Text-link
   * treatment only — never button chrome — so it reads as harder to reach than the first
   * share (a deliberate anti-spam-click affordance).
   */
  tertiary?: ThreadNudgeButton;
}

/**
 * BAL-283 — the CLIENT PARTY's display label for expert-facing copy.
 *
 * ⚠ THE PARTY, NOT "the client" (round-1 MUST-FIX). CLAUDE.md: PROSPECTIVE copy — who can act,
 * who is being waited on — names the PARTY. "Waiting on the client" is identical across every
 * thread in an expert's inbox and tells them nothing; "Waiting on Northwind Industrial" does.
 * The generic string survives only as the fallback for a genuinely absent company name.
 */
function clientPartyLabel(clientCompanyName: string | null): string {
  const trimmed = clientCompanyName?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : 'the client';
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
    // BAL-283 — a live call beats everything else on this cell: nothing left to book, and
    // the message-momentum framing above no longer applies once a call exists.
    if (thread.bookedCall !== null) {
      return {
        variant: 'done',
        icon: Calendar,
        headline: `Call booked with ${name}`,
        subInstant: {
          iso: thread.bookedCall.scheduledStartIso,
          suffix: " — you'll get a join link by email.",
        },
        secondary: { label: 'Send a message', icon: MessageSquare, action: 'reply' },
      };
    }
    if (needsReply) {
      return {
        variant: 'action',
        icon: MessageSquare,
        headline: `${name} sent a message — reply to keep momentum`,
        sub: preview,
        composerPlaceholder: `Reply to ${name}…`,
      };
    }
    // BAL-283 — once the expert has shared availability, the ask sharpens from a cold "meet
    // them" prompt to a specific "pick a time" — same handler (`call`), same live-availability
    // dialog; there is no separate "accept the expert's proposed times" path.
    if (thread.availabilitySharedAtIso !== null) {
      return {
        variant: 'action',
        icon: Calendar,
        headline: `${name} is free — pick a time`,
        sub: 'A quick intro call is the fastest way to gauge fit. Meetings are free.',
        primary: { label: 'Book a call', icon: Calendar, action: 'call' },
        secondary: { label: 'Reply by message', icon: MessageSquare, action: 'reply' },
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
  thread: ConversationThreadView,
  clientCompanyName: string | null
): ThreadNudgeContent | null {
  const clientParty = clientPartyLabel(clientCompanyName);
  // The expert lost the request — mirror the client's "records" framing
  // (the design's demo expert always wins, so this cell is Balo-added copy).
  if (thread.stage === 'not_selected') {
    return {
      variant: 'done',
      icon: MessageSquare,
      // ⚠ Sentence-initial, so it is left generic on purpose: `clientPartyLabel`'s fallback is
      // the lowercase `'the client'`, which would read as a typo at the start of a headline.
      // The BAL-283 cells that DO name the party are all mid-sentence.
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
    // BAL-283 — a live call beats everything else (both lenses share this precedence).
    if (thread.bookedCall !== null) {
      return {
        variant: 'done',
        icon: Calendar,
        headline: 'Call booked',
        subInstant: {
          iso: thread.bookedCall.scheduledStartIso,
          suffix: ` with ${clientParty}.`,
        },
        secondary: { label: 'Send a message', icon: MessageSquare, action: 'reply' },
      };
    }
    // BAL-283 (Ruling 3) — "propose times" FINISHED the expert's job; this is explicitly
    // framed as complete, not pending-on-me (design's "why this is not a lesser action").
    if (thread.availabilitySharedAtIso !== null) {
      return {
        variant: 'waiting',
        icon: Clock,
        // ⚠ THE PARTY, NOT "the client" — see `clientPartyLabel`. This is the approved design's
        // exact cell: `Availability shared — waiting on {ClientParty}`.
        headline: `Availability shared — waiting on ${clientParty}`,
        sub: "They can book any open slot on your calendar. You'll be notified the moment they pick a time.",
        secondary: { label: 'Send a message', icon: MessageSquare, action: 'reply' },
        tertiary: { label: 'Share again', icon: Calendar, action: 'call' },
      };
    }
    return {
      variant: 'action',
      icon: Calendar,
      headline: `Offer ${clientParty} a time to talk`,
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

/**
 * The single per-thread nudge for a (lens, request status, thread) cell.
 *
 * `clientCompanyName` is the CLIENT PARTY's display name, used only by the EXPERT lens (the
 * client already knows who they are). Optional so a caller that genuinely has no company name
 * degrades to the generic `'the client'`; the shipped call site always passes
 * `view.companyName`.
 */
export function threadNudgeFor(
  lens: 'client' | 'expert',
  requestStatus: ProjectRequestStatus,
  thread: ConversationThreadView,
  clientCompanyName: string | null = null
): ThreadNudgeContent | null {
  if (lens === 'client') return clientNudge(requestStatus, thread);
  return expertNudge(requestStatus, thread, clientCompanyName);
}

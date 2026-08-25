import type { ContextMeetingSummary, RequestExpertRelationship } from '@balo/db';
import { previewOfPlainText } from '@balo/shared/notifications';
import { htmlToPlainText } from '@/components/balo/rich-text/plain-text';
import type {
  ConversationFileView,
  ConversationMessageView,
} from '@/lib/conversations/conversation-view-types';
import type { ProjectRequestStatus } from './resolve-request-lens';

/**
 * Conversation view-model types + pure derivers (BAL-271 / A4).
 *
 * CLIENT-SAFE on purpose: no server VALUE imports (no `@balo/db` runtime code,
 * no `server-only`) so the conversation client island and its leaf components
 * can import these without dragging postgres-js into the browser bundle —
 * the `@balo/db` import above is `import type` (erased at compile). The server
 * loader lives separately in `conversation-view.ts`.
 */

/** Max PLAIN-TEXT chars per message (UX limit; the server re-enforces after strip). */
export const MESSAGE_MAX_TEXT = 4000;

/**
 * BAL-424: the 140-char truncation rule now lives in `@balo/shared/notifications`, so the
 * API's conversation-unread digest rebuilds an identical preview at fire time. Re-exported
 * here so every existing call site is unchanged.
 */
// ⚠ SPLIT DELIBERATELY. `previewOfPlainText` IS used locally (by `previewOfHtml` below), so
// it must be imported and is re-exported from that binding. `PREVIEW_MAX_CHARS` is not used
// here at all — it goes out via `export ... from`, so it is not imported just to be re-sent.
export { previewOfPlainText };
export { PREVIEW_MAX_CHARS } from '@balo/shared/notifications';

/** Plain-text preview of a sanitised HTML body — null when effectively empty. */
export function previewOfHtml(bodyHtml: string): string | null {
  const text = htmlToPlainText(bodyHtml);
  if (text.length === 0) return null;
  return previewOfPlainText(text);
}

/** Relationship status union, re-derived from the DB schema (type-only — bundle-safe). */
export type RelationshipStatus = RequestExpertRelationship['status'];

/** Relationship statuses whose thread is OPEN (listed, subscribable, postable). */
export const THREAD_OPEN_RELATIONSHIP_STATUSES = [
  'eoi_submitted',
  'proposal_requested',
  'proposal_submitted',
  'accepted',
] as const;

export type ThreadOpenRelationshipStatus = (typeof THREAD_OPEN_RELATIONSHIP_STATUSES)[number];

export function isThreadOpenStatus(status: string): boolean {
  return (THREAD_OPEN_RELATIONSHIP_STATUSES as readonly string[]).includes(status);
}

/** Pipeline order of request statuses — used for "before kickoff" style gating. */
const REQUEST_STATUS_ORDER: readonly ProjectRequestStatus[] = [
  'draft',
  'requested',
  'exploratory_meeting_requested',
  'experts_invited',
  'eoi_submitted',
  'proposal_requested',
  'proposal_submitted',
  'accepted',
  'kickoff_approved',
];

/** Index of a request status in pipeline order (-1 for unknown — fails closed). */
export function requestStatusRank(status: ProjectRequestStatus): number {
  return REQUEST_STATUS_ORDER.indexOf(status);
}

/**
 * A meeting whose parties are in the room RIGHT NOW, so the scheduled window says nothing about
 * whether it is over. Kept next to its only consumer rather than exported: this is a display
 * rule for the call-CTA pick, not a lifecycle predicate — `@balo/shared/meetings` owns those.
 */
function isLiveMeetingStatus(status: ContextMeetingSummary['status']): boolean {
  return status === 'in_progress' || status === 'waiting_for_participants';
}

/**
 * BAL-283 — THE ONE DEFINITION OF "this thread has a live intro call".
 *
 * `listActiveMeetingsForContexts` filters only `status <> 'cancelled'` and deliberately
 * DELEGATES the pick to its caller (see its docblock: "an intro call that ended, then a second
 * one booked"). This is that pick, and it is shared by BOTH consumers so they cannot disagree:
 *   · `loadConversationView` — decides `bookedCall`, i.e. whether the CTA renders;
 *   · `assertNoLiveIntroCall` — the server-side one-call-per-thread guard behind it.
 * A second copy of this rule would let the UI hide a CTA the server still allows, or vice versa.
 *
 * ⚠ TWO INDEPENDENT DISQUALIFIERS, BOTH LOAD-BEARING: `status === 'ended'` (the explicit
 * signal) AND a window already in the past (the clock, for a meeting nobody ever moved off
 * `scheduled`). Rows arrive ordered `scheduled_start, id`, so the first survivor is the soonest
 * upcoming one.
 *
 * ⚠ THE CLOCK DISQUALIFIER IS SUPPRESSED WHILE A CALL IS ACTUALLY LIVE (PR #236 review). A call
 * that runs past its scheduled end stays `in_progress` — `MEETING_TRANSITIONS` only lets that
 * status move to `ended` (`@balo/shared/meetings` lifecycle), so nothing advances it on the
 * clock alone. Judging such a row by `scheduledEnd` alone would drop it from the pick WHILE THE
 * PARTIES ARE STILL IN THE ROOM: the CTA would reappear and `assertNoLiveIntroCall` would pass,
 * letting a second intro call be booked over a call in progress. `waiting_for_participants` is
 * treated the same way — somebody is sitting in the lobby of that exact meeting. Only the
 * explicit `ended` signal (or `cancelled`, already filtered in the repository) retires a row.
 *
 * ⚠ `nowMs` IS A PARAMETER, NEVER `Date.now()` READ INSIDE. Both callers are server-side, but
 * passing the instant keeps this pure and testable, and keeps a clock out of a module that
 * client components import.
 */
export function pickUpcomingContextMeeting(
  meetings: readonly ContextMeetingSummary[],
  nowMs: number
): ContextMeetingSummary | undefined {
  return meetings.find(
    (m) =>
      m.status !== 'ended' && (isLiveMeetingStatus(m.status) || m.scheduledEnd.getTime() > nowMs)
  );
}

/** Derived per-thread display stage. */
export type ThreadStage = 'active' | 'not_selected' | 'won';

/**
 * `'won'` when the relationship itself is accepted; `'not_selected'` when the
 * REQUEST has been decided (`accepted`/`kickoff_approved`) and this thread's
 * relationship isn't the accepted one; `'active'` otherwise.
 */
export function deriveThreadStage(
  relationshipStatus: string,
  requestStatus: ProjectRequestStatus
): ThreadStage {
  if (relationshipStatus === 'accepted') return 'won';
  if (requestStatus === 'accepted' || requestStatus === 'kickoff_approved') return 'not_selected';
  return 'active';
}

export interface ConversationThreadView {
  /**
   * The UI's thread identity, and the id every Server Action still takes as its CLAIM.
   * BAL-424 re-anchored the DB tables onto `conversations` but deliberately left the
   * action surface speaking relationship ids — the IDOR gate keeps its exact shape.
   */
  relationshipId: string;
  /**
   * BAL-424 — the thread this relationship anchors. The Ably CHANNEL and every realtime
   * payload key on this, never on `relationshipId`: a Case has no relationship at all, and a
   * project thread that carries over at kickoff must not change channel mid-life.
   */
  conversationId: string;
  expertProfileId: string;
  /** Full name (fallback 'Invited expert', mirrors `relationshipName()`). */
  expertName: string;
  /** Tab label. */
  expertFirstName: string;
  expertInitials: string;
  /** The expert's public-profile slug — null when not published/available. */
  expertUsername: string | null;
  /** Raw relationship enum, for action gating. */
  relationshipStatus: RelationshipStatus;
  /** Derived: see {@link deriveThreadStage}. */
  stage: ThreadStage;
  /** Stable tab-order key (invite order, never reordered). */
  invitedAtIso: string;
  unread: boolean;
  /** Plain text, ≤140 chars. */
  latestMessagePreview: string | null;
  latestMessageAtIso: string | null;
  latestMessageFromViewer: boolean;
  latestInboundActivityAtIso: string | null;
  lastReadAtIso: string | null;
  fileCount: number;
  /** Client lens only: the expert's live EOI pitch (sanitised HTML). Null for expert lens. */
  eoiHtml: string | null;
  eoiSubmittedAtIso: string | null;
  /**
   * BAL-283 (Ruling 3) — when the expert last shared availability on this thread. `null` ⇒
   * never shared. Drives the header/rail "Availability shared" pill and the nudge's waiting
   * copy; render-path only, never an authorization input.
   */
  availabilitySharedAtIso: string | null;
  /**
   * BAL-283 — the live `request_interaction` meeting for this thread, if one has been booked.
   * `null` ⇒ nothing booked yet. Once set, the call-CTA slot on this thread is `'booked'` and
   * is removed from header/rail (plan §12.3/§12.4).
   */
  bookedCall: { meetingId: string; scheduledStartIso: string } | null;
}

/**
 * ⚠⚠ RE-EXPORTED, NOT DECLARED HERE (BAL-421). Both shapes are ANCHOR-AGNOSTIC — they key
 * on `conversationId` alone — and they are the ABLY WIRE PAYLOADS, so there must be exactly
 * ONE declaration of each on the platform. They now live in
 * `@/lib/conversations/conversation-view-types`, because a CASE has no project request and
 * BAL-421's surface must not import its core conversation contract from a `project-request`
 * path. Re-exporting keeps every existing import in this module's ~20 call sites working
 * unchanged; do NOT re-declare either shape here.
 */
export type {
  ConversationMessageView,
  ConversationFileView,
} from '@/lib/conversations/conversation-view-types';

export interface ConversationView {
  viewerUserId: string;
  /** Invite order (invitedAt asc, id asc tiebreak) — NEVER reorder. */
  threads: ConversationThreadView[];
  defaultThreadId: string | null;
  /** First page for the default thread, chronological. */
  initialMessages: ConversationMessageView[];
  initialHasEarlier: boolean;
  /** Default thread's files, newest first. */
  initialFiles: ConversationFileView[];
  realtimeEnabled: boolean;
}

function timeOf(iso: string | null): number {
  return iso === null ? Number.NEGATIVE_INFINITY : Date.parse(iso);
}

/** Strictly-later pick over a nullable-ISO key, preserving invite order on ties. */
function freshestBy(
  threads: ConversationThreadView[],
  key: (t: ConversationThreadView) => string | null
): ConversationThreadView | null {
  let best: ConversationThreadView | null = null;
  for (const thread of threads) {
    const at = timeOf(key(thread));
    if (at === Number.NEGATIVE_INFINITY) continue;
    if (best === null || at > timeOf(key(best))) best = thread;
  }
  return best;
}

/**
 * Smart default tab — SELECTION ONLY, never reorders `threads`:
 *  1. unread threads → freshest `latestInboundActivityAt` wins;
 *  2. else most-recent `latestMessageAt`;
 *  3. else most-recent `lastReadAt` (last-viewed fallback);
 *  4. else first in invite order.
 * Ties resolve to the earlier thread in invite order (deterministic).
 */
export function pickDefaultThread(threads: ConversationThreadView[]): string | null {
  const [first] = threads;
  if (first === undefined) return null;

  const unread = threads.filter((t) => t.unread);
  const freshestUnread = freshestBy(unread, (t) => t.latestInboundActivityAtIso);
  if (freshestUnread !== null) return freshestUnread.relationshipId;
  // An unread thread always has inbound activity, but fail soft to the first
  // unread one if the data ever disagrees.
  const [firstUnread] = unread;
  if (firstUnread !== undefined) return firstUnread.relationshipId;

  const mostRecentMessage = freshestBy(threads, (t) => t.latestMessageAtIso);
  if (mostRecentMessage !== null) return mostRecentMessage.relationshipId;

  const lastViewed = freshestBy(threads, (t) => t.lastReadAtIso);
  if (lastViewed !== null) return lastViewed.relationshipId;

  return first.relationshipId;
}

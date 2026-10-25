import type { ContextMeetingSummary, RequestExpertRelationship } from '@balo/db';
import {
  isUpcomingContextMeeting,
  UPCOMING_CALL_CAP,
  type UpcomingCallContextType,
} from '@balo/shared/meetings';
import { previewOfPlainText } from '@balo/shared/notifications';
import { relationshipIsOpened } from '@balo/shared/project-requests';
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

/**
 * A closed request keeps its conversation for reading only. This is the one place that says
 * so; the stage, the loader and the access resolver all read it.
 */
export function isConversationReadOnly(requestStatus: ProjectRequestStatus): boolean {
  return requestStatus === 'closed';
}

/**
 * What a caller wants from a thread. `live` is every content write plus realtime; `records`
 * adds the closed request's surviving threads, for reads and the read watermark only.
 */
export type ThreadAdmission = 'live' | 'records';

/**
 * THE thread-admission predicate (BAL-616).
 *
 * - `live`: the request still accepts messages and the thread's status is an open one. The
 *   explicit closed term does not rely on the close cascade, which declines every track — an
 *   `accepted` relationship on a closed request would otherwise be postable.
 * - `records`: `live`, plus on a closed request the threads that were OPEN when the close
 *   landed (declined with `request_closed` after the track had opened). A track declined
 *   before the close, or never opened, stays hidden as it was while the request was live.
 *   On every non-closed request it equals `live`.
 */
export function threadAdmits(
  relationship: Pick<RequestExpertRelationship, 'status' | 'declineReason' | 'openedAt'>,
  requestStatus: ProjectRequestStatus,
  admission: ThreadAdmission
): boolean {
  const readOnly = isConversationReadOnly(requestStatus);
  if (!readOnly && isThreadOpenStatus(relationship.status)) return true;
  if (admission === 'live' || !readOnly) return false;
  return (
    relationship.status === 'declined' &&
    relationship.declineReason === 'request_closed' &&
    relationshipIsOpened(relationship)
  );
}

/**
 * Pipeline rank of every request status — used for "before kickoff" style gating.
 *
 * ⚠ BAL-540 — A `Record`, NOT a plain array walked with `.indexOf`. The array form returned
 * `-1` for any status it didn't enumerate, and `-1` reads as "before everything" to every
 * `rank >= X` gate — which is precisely how a `closed` request stayed bookable
 * (`book-intro-call.ts`) and kept its call/proposal CTAs live (`thread-actions.ts`) before this
 * fix. A `Record<ProjectRequestStatus, number>` is TOTAL: omitting a label here is a compile
 * error, not a silent `-1`. `closed` ranks LAST (9) — the terminal state outranks every other.
 */
const REQUEST_STATUS_RANK: Record<ProjectRequestStatus, number> = {
  draft: 0,
  requested: 1,
  exploratory_meeting_requested: 2,
  experts_invited: 3,
  eoi_submitted: 4,
  proposal_requested: 5,
  proposal_submitted: 6,
  accepted: 7,
  kickoff_approved: 8,
  closed: 9,
};

/** Pipeline rank of a request status. Total — never `-1` (see `REQUEST_STATUS_RANK`). */
export function requestStatusRank(status: ProjectRequestStatus): number {
  return REQUEST_STATUS_RANK[status];
}

/**
 * "Upcoming call" is ONE rule, defined in `@balo/shared/meetings` (`isUpcomingContextMeeting`,
 * BAL-616) so `apps/api`'s booking gate counts the same calls this page does. It has two web
 * consumers, which therefore cannot disagree:
 *   · `loadConversationView` — the thread's `upcomingCalls` list (via {@link mergeUpcomingCalls});
 *   · the cap pre-check (`assertUnderUpcomingCallCap`).
 *
 * ⚠ The rule judges `ended` and the clock only; it does not exclude `cancelled`. Every feed must
 * come from `meetingsRepository.listActiveMeetingsForContexts` (already cancelled-filtered).
 */
export { isUpcomingContextMeeting, UPCOMING_CALL_CAP };

/** The context a call is anchored to: the relationship before kickoff, the engagement after. */
export type { UpcomingCallContextType };

/** One upcoming call on a thread, as the page renders it. */
export interface UpcomingCallView {
  meetingId: string;
  scheduledStartIso: string;
  /**
   * Which context the call was read from. A carried-over meeting holds both contexts and is
   * reported once, as `project_call`.
   */
  contextType: UpcomingCallContextType;
}

function compareUpcomingCalls(a: UpcomingCallView, b: UpcomingCallView): number {
  const byStart = Date.parse(a.scheduledStartIso) - Date.parse(b.scheduledStartIso);
  if (byStart !== 0) return byStart;
  if (a.meetingId < b.meetingId) return -1;
  return a.meetingId > b.meetingId ? 1 : 0;
}

/**
 * Merge the upcoming calls of every context a thread reads into one list, soonest first (id
 * tiebreak). A meeting present in several sources is reported once and `project_call` wins, so
 * a carried-over call counts once everywhere. Pure: the caller supplies `nowMs`.
 */
export function mergeUpcomingCalls(
  sources: ReadonlyArray<{
    contextType: UpcomingCallContextType;
    meetings: readonly ContextMeetingSummary[];
  }>,
  nowMs: number
): UpcomingCallView[] {
  const byMeetingId = new Map<string, UpcomingCallView>();
  for (const { contextType, meetings } of sources) {
    for (const m of meetings) {
      if (!isUpcomingContextMeeting(m, nowMs)) continue;
      const existing = byMeetingId.get(m.meetingId);
      if (existing?.contextType === 'project_call') continue;
      byMeetingId.set(m.meetingId, {
        meetingId: m.meetingId,
        scheduledStartIso: m.scheduledStart.toISOString(),
        contextType,
      });
    }
  }
  return [...byMeetingId.values()].sort(compareUpcomingCalls);
}

/** Insert (or replace, by meeting id) a call, keeping the list soonest first. */
export function insertUpcomingCall(
  list: readonly UpcomingCallView[],
  call: UpcomingCallView
): UpcomingCallView[] {
  return [...list.filter((c) => c.meetingId !== call.meetingId), call].sort(compareUpcomingCalls);
}

/** The cap message: shown as a toast at the cap and as the booking dialog's failure copy. */
export function upcomingCallCapCopy(expertFirstName: string): { title: string; body: string } {
  return {
    title: `You have ${UPCOMING_CALL_CAP} calls booked with ${expertFirstName}.`,
    body: 'Once one has happened you can book another.',
  };
}

/** Derived per-thread display stage. */
export type ThreadStage = 'active' | 'not_selected' | 'won' | 'request_closed';

/**
 * BAL-540 — `'request_closed'` when the REQUEST is `closed`, checked FIRST, before the `'won'`
 * test: a closed request has no winner, even if this thread's relationship happens to still
 * carry `status: 'accepted'` from before the close. Otherwise: `'won'` when the relationship
 * itself is accepted; `'not_selected'` when the REQUEST has been decided
 * (`accepted`/`kickoff_approved`) and this thread's relationship isn't the accepted one;
 * `'active'` otherwise. Consumers narrow with `=== 'active'` / `=== 'not_selected'` so a new
 * arm here cannot silently mis-narrow an existing one.
 */
export function deriveThreadStage(
  relationshipStatus: string,
  requestStatus: ProjectRequestStatus
): ThreadStage {
  if (requestStatus === 'closed') return 'request_closed';
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
  /**
   * The relationship's expert's user id — the sender the nudge copy names ("Priya sent a
   * message"). Lets a realtime message set {@link latestMessageFromExpert} client-side.
   */
  expertUserId: string;
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
  /**
   * The latest message was sent by THIS thread's expert. Not the inverse of
   * `latestMessageFromViewer`: a client teammate's message is from neither, and must never
   * be quoted or prompted for as if the expert wrote it.
   */
  latestMessageFromExpert: boolean;
  /** The viewer has written at least one live message in this thread (any position). */
  viewerHasSentMessage: boolean;
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
   * The thread's upcoming calls, soonest first. Read across the thread's `request_interaction`
   * context and, for a won thread after kickoff, its `project_call` context; "upcoming" is
   * `isUpcomingContextMeeting`. Empty ⇒ nothing booked. Render-path only, never an
   * authorization input.
   */
  upcomingCalls: UpcomingCallView[];
  /**
   * The client's open change request on this thread's CURRENT proposal — non-null while that
   * proposal is `changes_requested`. The relationship stays `proposal_submitted` throughout the
   * changes loop, so `relationshipStatus` alone cannot tell "with the client" from "back with
   * the expert to revise"; every revise-aware nudge and CTA keys on this instead.
   */
  changeRequest: ThreadChangeRequestView | null;
}

export interface ThreadChangeRequestView {
  /** Retrospective attribution of who asked — "Dana @ Northwind" (person @ client company). */
  requestedBy: string;
  /** The client's note, whitespace-collapsed and clipped for nudge display. */
  notePreview: string;
  /** The version number a resubmit will create. */
  nextVersion: number;
}

/**
 * The expert's revise-cell copy — ONE definition shared by the page nudge (`nudge-bar.tsx`)
 * and the thread nudge (`thread-nudge-content.ts`), which differ only in icon/CTA plumbing.
 */
export function reviseProposalCopy(changeRequest: ThreadChangeRequestView): {
  headline: string;
  sub: string;
} {
  return {
    headline: `${changeRequest.requestedBy} requested changes to your proposal`,
    sub: `“${changeRequest.notePreview}” — revise and resubmit as version ${changeRequest.nextVersion}.`,
  };
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

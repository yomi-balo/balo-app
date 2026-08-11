import type { RequestExpertRelationship } from '@balo/db';
import { PREVIEW_MAX_CHARS, previewOfPlainText } from '@balo/shared/notifications';
import { htmlToPlainText } from '@/components/balo/rich-text/plain-text';
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
export { PREVIEW_MAX_CHARS, previewOfPlainText };

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
}

/**
 * ⚠ THIS IS THE ABLY WIRE PAYLOAD. It carries `conversationId`, NOT `relationshipId`
 * (BAL-424) — the channel is keyed on the conversation, and the client hook's structural
 * type guard requires this exact field. The island maps back to a thread via
 * `threads.find((t) => t.conversationId === …)`.
 */
export interface ConversationMessageView {
  id: string;
  conversationId: string;
  /** Sanitised at ingest (plain text → escaped HTML → sanitizeProjectHtml). */
  bodyHtml: string;
  senderUserId: string;
  senderName: string;
  createdAtIso: string;
}

/** Also an Ably wire payload — see {@link ConversationMessageView}. */
export interface ConversationFileView {
  id: string;
  conversationId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  uploadedByUserId: string;
  uploadedByName: string;
  createdAtIso: string;
}

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

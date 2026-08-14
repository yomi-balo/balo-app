import 'server-only';

import {
  conversationContextKey,
  conversationsRepository,
  expertsRepository,
  type ConversationContextRef,
  type ConversationFile,
  type ProjectRequestWithRelations,
} from '@balo/db';
import type { SessionUser } from '@/lib/auth/session';
import { mapMessageRowToView } from '@/lib/conversations/conversation-view';
import { isRealtimeConfigured } from '@/lib/realtime/ably-server';
import { log } from '@/lib/logging';
import type { RequestViewerContext } from './resolve-request-lens';
import {
  deriveThreadStage,
  isThreadOpenStatus,
  pickDefaultThread,
  previewOfHtml,
  type ConversationFileView,
  type ConversationMessageView,
  type ConversationThreadView,
  type ConversationView,
} from './conversation-view-types';

/**
 * Server loader for the conversation stage (BAL-271 / A4 — D6): thread
 * summaries for every OPEN thread + the default thread's first message page
 * and files, in one server render. Tab switches go through the
 * `fetchThreadAction` read Server Action.
 */

type Relationship = ProjectRequestWithRelations['relationships'][number];

const FIRST_PAGE_SIZE = 30;

/** BAL-424 — the `conversation_contexts` anchor a project thread's relationship names. */
function conversationRefForRelationship(relationshipId: string): ConversationContextRef {
  return { contextType: 'relationship', contextId: relationshipId };
}

function fullName(
  firstName: string | null | undefined,
  lastName: string | null | undefined,
  fallback: string
): string {
  const full = [firstName, lastName].filter(Boolean).join(' ').trim();
  return full.length > 0 ? full : fallback;
}

function initialsOf(
  firstName: string | null | undefined,
  lastName: string | null | undefined
): string {
  const initials = [firstName, lastName]
    .map((part) => (part ?? '').trim().charAt(0).toUpperCase())
    .filter(Boolean)
    .join('');
  return initials.length > 0 ? initials : 'EX';
}

/**
 * ⚠ MOVED TO `@/lib/conversations/conversation-view` BY BAL-421 — MOVED, NOT COPIED, and
 * RE-EXPORTED here so every existing import of this path keeps working unchanged.
 *
 * It keys on the joined row alone and mentions no request and no relationship, so it was the
 * one mapper in this module a CASE could reuse verbatim — and a case has neither a project
 * request nor a relationship, so importing it from a `project-request` path would have been a
 * lie about ownership. `participantNames` and `mapFileRowToView` below are genuinely
 * request-shaped and DID NOT move.
 */
export { mapMessageRowToView };

/** The two participants' display names — used to attribute file uploads. */
export interface ConversationParticipantNames {
  clientUserId: string;
  clientName: string;
  expertUserId: string | null;
  expertName: string;
}

export function participantNames(
  request: ProjectRequestWithRelations,
  relationship: Relationship
): ConversationParticipantNames {
  const { createdByUser } = request;
  const expertUser = relationship.expertProfile.user;
  return {
    clientUserId: request.createdByUserId,
    clientName: fullName(createdByUser.firstName, createdByUser.lastName, 'Client'),
    expertUserId: expertUser.id,
    expertName: fullName(expertUser.firstName, expertUser.lastName, 'Invited expert'),
  };
}

/** Repo file row → serialisable view, attributing the uploader by participant. */
export function mapFileRowToView(
  row: ConversationFile,
  names: ConversationParticipantNames
): ConversationFileView {
  let uploadedByName = 'Participant';
  if (row.uploadedByUserId === names.clientUserId) uploadedByName = names.clientName;
  else if (row.uploadedByUserId === names.expertUserId) uploadedByName = names.expertName;
  return {
    id: row.id,
    conversationId: row.conversationId,
    fileName: row.fileName,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    uploadedByUserId: row.uploadedByUserId,
    uploadedByName,
    createdAtIso: row.createdAt.toISOString(),
  };
}

/**
 * Hydrate the expert usernames for the client lens (powers the mobile
 * overflow sheet's "View profile" action). Non-critical: any failure resolves
 * to `null` so a profile hiccup can never break the conversation page.
 */
async function hydrateUsernames(
  relationships: Relationship[],
  lens: RequestViewerContext['lens']
): Promise<Map<string, string | null>> {
  const byProfileId = new Map<string, string | null>();
  if (lens !== 'client') return byProfileId;

  const uniqueIds = [...new Set(relationships.map((r) => r.expertProfileId))];
  await Promise.all(
    uniqueIds.map(async (expertProfileId) => {
      try {
        const profile = await expertsRepository.findProfileById(expertProfileId);
        byProfileId.set(expertProfileId, profile?.username ?? null);
      } catch (error) {
        log.warn('Failed to hydrate expert username for conversation thread', {
          expertProfileId,
          error: error instanceof Error ? error.message : String(error),
        });
        byProfileId.set(expertProfileId, null);
      }
    })
  );
  return byProfileId;
}

/**
 * Build the full `ConversationView` for a participant viewer. Open threads =
 * live relationships in `THREAD_OPEN_RELATIONSHIP_STATUSES` (the expert lens
 * additionally sees ONLY their own). Thread order is invite order
 * (`invitedAt asc, id asc`) — selection, never order, reacts to activity.
 */
export async function loadConversationView(
  request: ProjectRequestWithRelations,
  ctx: RequestViewerContext,
  user: SessionUser
): Promise<ConversationView> {
  const candidateRelationships = request.relationships
    .filter((r) => isThreadOpenStatus(r.status))
    .filter((r) => ctx.lens !== 'expert' || r.id === ctx.relationshipId)
    .sort((a, b) => a.invitedAt.getTime() - b.invitedAt.getTime() || a.id.localeCompare(b.id));

  /**
   * BAL-424 — relationship → conversation, resolved ONCE for the whole view.
   *
   * ⚠ `ensureManyForContexts` (a WRITE) rather than the read-only
   * `conversationIdsForContexts`: this loader also decides which Ably channels the island
   * subscribes to, and a thread whose conversation did not yet exist would silently drop out
   * of that list. Idempotent; one row per thread ever. `invite()` provisions eagerly, so in
   * practice every entry is a read hit — the repository ensures every miss, so an unresolved
   * relationship below is an impossible state, logged and dropped rather than rendered as a
   * thread that could neither be read nor posted to.
   */
  const conversationIdByRelationship = await conversationsRepository.ensureManyForContexts(
    candidateRelationships.map((r) => conversationRefForRelationship(r.id))
  );

  const openThreads = candidateRelationships.flatMap((relationship) => {
    const conversationId = conversationIdByRelationship.get(
      conversationContextKey(conversationRefForRelationship(relationship.id))
    );
    if (conversationId === undefined) {
      log.error('Conversation thread dropped — no conversation resolved for relationship', {
        requestId: request.id,
        relationshipId: relationship.id,
      });
      return [];
    }
    return [{ relationship, conversationId }];
  });

  const [summaries, usernames] = await Promise.all([
    conversationsRepository.listThreadSummaries({
      conversationIds: openThreads.map((t) => t.conversationId),
      viewerUserId: user.id,
    }),
    hydrateUsernames(
      openThreads.map((t) => t.relationship),
      ctx.lens
    ),
  ]);
  const summaryById = new Map(summaries.map((s) => [s.conversationId, s]));

  const threads: ConversationThreadView[] = openThreads.map(({ relationship, conversationId }) => {
    const summary = summaryById.get(conversationId);
    const expertUser = relationship.expertProfile.user;
    const latestMessage = summary?.latestMessage ?? null;
    const latestInboundAt = summary?.latestInboundActivityAt ?? null;
    const lastReadAt = summary?.lastReadAt ?? null;
    const unread =
      latestInboundAt !== null &&
      (lastReadAt === null || latestInboundAt.getTime() > lastReadAt.getTime());
    const [liveEoi] = relationship.expressionsOfInterest;
    const expertName = fullName(expertUser.firstName, expertUser.lastName, 'Invited expert');
    const [firstWord] = expertName.split(' ');

    return {
      relationshipId: relationship.id,
      conversationId,
      expertProfileId: relationship.expertProfileId,
      expertName,
      expertFirstName: firstWord ?? expertName,
      expertInitials: initialsOf(expertUser.firstName, expertUser.lastName),
      expertUsername: usernames.get(relationship.expertProfileId) ?? null,
      relationshipStatus: relationship.status,
      stage: deriveThreadStage(relationship.status, request.status),
      invitedAtIso: relationship.invitedAt.toISOString(),
      unread,
      latestMessagePreview: latestMessage === null ? null : previewOfHtml(latestMessage.body),
      latestMessageAtIso: latestMessage === null ? null : latestMessage.createdAt.toISOString(),
      latestMessageFromViewer: latestMessage !== null && latestMessage.senderUserId === user.id,
      latestInboundActivityAtIso: latestInboundAt === null ? null : latestInboundAt.toISOString(),
      lastReadAtIso: lastReadAt === null ? null : lastReadAt.toISOString(),
      fileCount: summary?.fileCount ?? 0,
      eoiHtml: ctx.lens === 'client' ? (liveEoi?.message ?? null) : null,
      eoiSubmittedAtIso:
        ctx.lens === 'client' && liveEoi !== undefined ? liveEoi.submittedAt.toISOString() : null,
    };
  });

  const defaultThreadId = pickDefaultThread(threads);

  let initialMessages: ConversationMessageView[] = [];
  let initialHasEarlier = false;
  let initialFiles: ConversationFileView[] = [];

  // `defaultThreadId` is a RELATIONSHIP id — the UI's thread identity is unchanged by
  // BAL-424; only the repository reads move to the conversation.
  const defaultThread = openThreads.find((t) => t.relationship.id === defaultThreadId);
  if (defaultThreadId !== null && defaultThread !== undefined) {
    const [page, files] = await Promise.all([
      conversationsRepository.listMessagesPage({
        conversationId: defaultThread.conversationId,
        // Both parties read the whole thread; `{ kind: 'meeting' }` is the guest scope.
        scope: { kind: 'full' },
        limit: FIRST_PAGE_SIZE,
      }),
      conversationsRepository.listFiles(defaultThread.conversationId, { kind: 'full' }),
    ]);
    const names = participantNames(request, defaultThread.relationship);
    initialMessages = page.messages.map(mapMessageRowToView);
    initialHasEarlier = page.hasEarlier;
    // Repo returns oldest-first; the Files panel reads newest-first.
    initialFiles = files.map((file) => mapFileRowToView(file, names)).reverse();
  }

  return {
    viewerUserId: user.id,
    threads,
    defaultThreadId,
    initialMessages,
    initialHasEarlier,
    initialFiles,
    realtimeEnabled: isRealtimeConfigured(),
  };
}

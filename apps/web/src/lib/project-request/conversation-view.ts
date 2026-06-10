import 'server-only';

import {
  conversationsRepository,
  expertsRepository,
  type ConversationFile,
  type ConversationMessage,
  type ProjectRequestWithRelations,
} from '@balo/db';
import type { SessionUser } from '@/lib/auth/session';
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

/** Repo message row (joined with sender names) → serialisable view. */
export function mapMessageRowToView(
  row: ConversationMessage & { senderFirstName: string | null; senderLastName: string | null }
): ConversationMessageView {
  return {
    id: row.id,
    relationshipId: row.relationshipId,
    bodyHtml: row.body,
    senderUserId: row.senderUserId,
    senderName: fullName(row.senderFirstName, row.senderLastName, 'Participant'),
    createdAtIso: row.createdAt.toISOString(),
  };
}

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
    relationshipId: row.relationshipId,
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
  const openRelationships = request.relationships
    .filter((r) => isThreadOpenStatus(r.status))
    .filter((r) => ctx.lens !== 'expert' || r.id === ctx.relationshipId)
    .sort((a, b) => a.invitedAt.getTime() - b.invitedAt.getTime() || a.id.localeCompare(b.id));

  const relationshipIds = openRelationships.map((r) => r.id);
  const [summaries, usernames] = await Promise.all([
    conversationsRepository.listThreadSummaries({ relationshipIds, viewerUserId: user.id }),
    hydrateUsernames(openRelationships, ctx.lens),
  ]);
  const summaryById = new Map(summaries.map((s) => [s.relationshipId, s]));

  const threads: ConversationThreadView[] = openRelationships.map((relationship) => {
    const summary = summaryById.get(relationship.id);
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

  const defaultRelationship = openRelationships.find((r) => r.id === defaultThreadId);
  if (defaultThreadId !== null && defaultRelationship !== undefined) {
    const [page, files] = await Promise.all([
      conversationsRepository.listMessagesPage({
        relationshipId: defaultThreadId,
        limit: FIRST_PAGE_SIZE,
      }),
      conversationsRepository.listFiles(defaultThreadId),
    ]);
    const names = participantNames(request, defaultRelationship);
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

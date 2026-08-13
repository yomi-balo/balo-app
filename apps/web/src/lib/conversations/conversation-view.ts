import 'server-only';

import type { ConversationFile, ConversationMessage } from '@balo/db';
import type { ConversationFileView, ConversationMessageView } from './conversation-view-types';

/**
 * The ANCHOR-AGNOSTIC conversation row → view mappers (BAL-421).
 *
 * ⚠ `mapMessageRowToView` MOVED HERE FROM `lib/project-request/conversation-view.ts` — MOVED,
 * NOT COPIED, and for the same reason the two view TYPES moved in BAL-424: it keys on the
 * joined row alone and mentions no request, no relationship and no engagement, so a CASE
 * (which has neither a project request nor a relationship) would otherwise import its core
 * message mapper from a `project-request` path — a lie about ownership. That module now
 * RE-EXPORTS it, so every existing import keeps working unchanged.
 *
 * ⚠ THE OTHER TWO MAPPERS DID **NOT** MOVE, AND THAT IS THE POINT OF SPLITTING HERE.
 * `participantNames` takes a `ProjectRequestWithRelations` and `mapFileRowToView` takes its
 * result, so both are genuinely request-shaped and cannot serve a case. The case equivalent is
 * {@link mapConversationFileRowToView} below, which takes a plain uploader-name map instead.
 * Generalising the request pair in place would have made a shipped, exact type optional in six
 * places to serve a caller that needs none of it.
 */

/** `first last`, or `fallback` when both are absent. Never an email address (ADR-1044). */
function fullName(
  firstName: string | null | undefined,
  lastName: string | null | undefined,
  fallback: string
): string {
  const full = [firstName, lastName].filter(Boolean).join(' ').trim();
  return full.length > 0 ? full : fallback;
}

/**
 * Repo message row (joined with sender names) → serialisable view.
 *
 * ⚠ THE RETURNED SHAPE IS AN ABLY WIRE PAYLOAD. `ConversationMessageView` is what the client
 * hook's STRUCTURAL guard `isConversationMessagePayload` checks field-by-field, so changing a
 * field name here silently rejects every inbound realtime message with a green typecheck.
 */
export function mapMessageRowToView(
  row: ConversationMessage & { senderFirstName: string | null; senderLastName: string | null }
): ConversationMessageView {
  return {
    id: row.id,
    conversationId: row.conversationId,
    bodyHtml: row.body,
    senderUserId: row.senderUserId,
    senderName: fullName(row.senderFirstName, row.senderLastName, 'Participant'),
    createdAtIso: row.createdAt.toISOString(),
  };
}

/**
 * Repo file row → serialisable view, attributing the uploader from a PRE-RESOLVED name map.
 *
 * ⚠ A MAP RATHER THAN A HYDRATED GRAPH, DELIBERATELY. `mapFileRowToView` (the request
 * variant) reads names off `ProjectRequestWithRelations`, which a case does not have and
 * whose relational hydrate would pull every participant's `email` and `workosId` anyway
 * (memory `reference_drizzle_with_hydration_leaks_secrets`). The caller resolves names with
 * ONE batched `usersRepository.findNamesByIds` — a projection of `id / firstName / lastName`
 * and nothing else — and hands the result in.
 *
 * ⚠ `r2Key` HAS NO FIELD IN `ConversationFileView`, and this projects field by field rather
 * than spreading, so it cannot acquire one by accident.
 */
export function mapConversationFileRowToView(
  row: ConversationFile,
  uploaderNameById: ReadonlyMap<string, string>
): ConversationFileView {
  return {
    id: row.id,
    conversationId: row.conversationId,
    fileName: row.fileName,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    uploadedByUserId: row.uploadedByUserId,
    uploadedByName: uploaderNameById.get(row.uploadedByUserId) ?? 'Participant',
    createdAtIso: row.createdAt.toISOString(),
  };
}

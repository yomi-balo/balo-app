import 'server-only';

import { projectRequestsRepository, type ProjectRequestWithRelations } from '@balo/db';
import type { SessionUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { resolveRequestLens, type RequestViewerContext } from './resolve-request-lens';
import { isThreadOpenStatus } from './conversation-view-types';

/**
 * Per-action conversation guard (BAL-271 / A4) — the multi-thread extension of
 * the BAL-270 IDOR pattern. Every conversation Server Action takes the
 * `relationshipId` ONLY as a CLAIM and validates it here against the
 * server-loaded request graph + the viewer's resolved lens:
 *
 *  - viewer must be a PARTICIPANT (admin observers are denied — A4 has no
 *    admin chat);
 *  - expert lens → the claimed id MUST equal the viewer's own relationship;
 *  - client lens → the claimed id must be one of the OWNED request's live
 *    relationships with an OPEN thread status;
 *  - both lenses → the relationship's thread must be open
 *    (`THREAD_OPEN_RELATIONSHIP_STATUSES`).
 *
 * Error copy is uniform so probing leaks nothing about other requests/threads.
 */

const DENIED = 'You do not have access to this conversation.';

export type ConversationAccess =
  | {
      ok: true;
      ctx: RequestViewerContext;
      request: ProjectRequestWithRelations;
      relationship: ProjectRequestWithRelations['relationships'][number];
      /** The OTHER party — who a posted message/file notifies. */
      recipient: { role: 'client'; userId: string } | { role: 'expert'; expertProfileId: string };
    }
  | { ok: false; error: string };

function denied(
  user: SessionUser,
  requestId: string,
  relationshipId: string,
  lens: string | null
): ConversationAccess {
  log.warn('Conversation access denied', {
    requestId,
    relationshipId,
    userId: user.id,
    lens,
  });
  return { ok: false, error: DENIED };
}

export async function resolveConversationAccess(
  user: SessionUser,
  requestId: string,
  relationshipId: string
): Promise<ConversationAccess> {
  const request = await projectRequestsRepository.findByIdWithRelations(requestId);
  if (request === undefined) {
    return denied(user, requestId, relationshipId, null);
  }

  const ctx = resolveRequestLens(user, request);
  if (ctx?.archetype !== 'participant') {
    return denied(user, requestId, relationshipId, ctx?.lens ?? null);
  }

  // Expert lens may only ever touch their OWN thread.
  if (ctx.lens === 'expert' && relationshipId !== ctx.relationshipId) {
    return denied(user, requestId, relationshipId, ctx.lens);
  }

  const relationship = request.relationships.find((r) => r.id === relationshipId);
  if (relationship === undefined || !isThreadOpenStatus(relationship.status)) {
    return denied(user, requestId, relationshipId, ctx.lens);
  }

  // The recipient is the OTHER party: sender client → recipient expert;
  // sender expert → recipient client (the request owner's user).
  const recipient =
    ctx.lens === 'client'
      ? ({ role: 'expert', expertProfileId: relationship.expertProfileId } as const)
      : ({ role: 'client', userId: request.createdByUserId } as const);

  return { ok: true, ctx, request, relationship, recipient };
}

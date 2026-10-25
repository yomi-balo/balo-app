import 'server-only';

import type { SessionUser } from '@/lib/auth/session';
import {
  resolveConversationAccess,
  type ConversationAccess,
} from '@/lib/project-request/resolve-conversation-access';

export const ONLY_EXPERT = 'Only the expert can build a proposal.';

/**
 * The gate for writing a relationship's proposal: the viewer must be a participant on the
 * relationship (`resolveConversationAccess`) AND be the expert side of it. Only the expert
 * authors a proposal, so a client-lens participant is refused with {@link ONLY_EXPERT}.
 *
 * The one place that expert-lens check lives, shared by the autosave core and the AI draft
 * start/poll cores, so the comparison is not re-written inside a `'use server'` module. The
 * expert lens resolves only from the viewer's own expert profile, so this matches the api
 * route's `expert_profiles.user_id` re-check exactly.
 */
export async function resolveProposalAuthorAccess(
  user: SessionUser,
  requestId: string,
  relationshipId: string
): Promise<ConversationAccess> {
  const access = await resolveConversationAccess(user, requestId, relationshipId);
  if (!access.ok) return access;
  if (access.ctx.lens !== 'expert') {
    return { ok: false, error: ONLY_EXPERT };
  }
  return access;
}

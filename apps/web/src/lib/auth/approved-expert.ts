import 'server-only';

import { expertsRepository } from '@balo/db';
import { log } from '@/lib/logging';
import type { SessionUser } from './session';

export type ApprovedExpertRefusal = 'no_profile' | 'not_found' | 'not_owner' | 'not_approved';

export type ApprovedExpertResolution =
  | { ok: true; expertProfileId: string }
  | { ok: false; reason: ApprovedExpertRefusal };

export const APPROVED_EXPERT_REQUIRED_ERROR = 'Expert profile required';

/**
 * The single definition of "this session belongs to an approved expert".
 *
 * Resolves from the expert profile itself and never reads `activeMode`, which is a view toggle
 * and not an authorization input (ADR-1029). Approval is read live on every call: the session
 * cookie carries no approval field because of its size ceiling.
 *
 * Returns a result rather than throwing so each caller keeps its own refusal shape. A failed
 * read propagates; the caller's try/catch owns it. The profile row never leaves this function.
 */
export async function resolveApprovedExpert(
  user: Pick<SessionUser, 'id' | 'expertProfileId'>
): Promise<ApprovedExpertResolution> {
  const { id: userId, expertProfileId } = user;
  if (!expertProfileId) {
    return { ok: false, reason: 'no_profile' };
  }

  const refuse = (reason: ApprovedExpertRefusal): ApprovedExpertResolution => {
    log.warn('Approved-expert guard refused', { userId, expertProfileId, reason });
    return { ok: false, reason };
  };

  const profile = await expertsRepository.findProfileById(expertProfileId);
  if (!profile) return refuse('not_found');
  if (profile.userId !== userId) return refuse('not_owner');
  if (profile.approvedAt === null) return refuse('not_approved');

  return { ok: true, expertProfileId };
}

/**
 * BAL-378 (ADR-1040 Lane 2) — the member top-up nudge (`POST /sessions/:id/nudge`). Authorize
 * the actor against the session's company (fail-closed) so a stranger can't spam a victim
 * company's billing admins, then a member who can't top up asks the company's billing admins to;
 * publishes `session.topup_nudge` (in-app fan-out). Re-notifiable per click via the correlationId.
 */
import { usersRepository } from '@balo/db';
import { CAPABILITIES } from '@balo/shared/authz';
import { createLogger } from '@balo/shared/logging';
import { authorizeSessionActor } from './authorize-session-actor.js';
import { publishTopupNudge } from './notify.js';
import type { NudgeServiceResult } from './types.js';

const log = createLogger('credit-session');

export async function nudgeAdminForTopup(
  sessionId: string,
  memberId: string
): Promise<NudgeServiceResult> {
  const auth = await authorizeSessionActor({
    sessionId,
    userId: memberId,
    requireCapability: CAPABILITIES.CONSUME_CREDITS,
  });
  if (!auth.ok) {
    return auth;
  }

  const user = await usersRepository.findById(memberId);
  const requestedByName =
    [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim() || 'A teammate';

  await publishTopupNudge(auth.session, memberId, requestedByName, Date.now());
  log.info({ sessionId, memberId }, 'Published top-up nudge to billing admins');
  return { ok: true };
}

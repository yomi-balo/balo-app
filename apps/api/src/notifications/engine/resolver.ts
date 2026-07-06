import {
  usersRepository,
  expertsRepository,
  companiesRepository,
  proposalsRepository,
} from '@balo/db';
import type { RuleContext } from './rules.js';

export async function resolveContext(
  event: string,
  payload: Record<string, unknown>
): Promise<RuleContext> {
  const data: Record<string, unknown> = {};

  // Hydrate the user (present in all current events)
  if (typeof payload.userId === 'string') {
    data.user = await usersRepository.findById(payload.userId);
  }

  // Hydrate the target expert (e.g. project.request_submitted) so the
  // dispatcher's `recipient: 'expert'` resolves to the expert's user id.
  if (typeof payload.expertProfileId === 'string') {
    data.expert = await expertsRepository.findUserIdByProfileId(payload.expertProfileId);
  }

  // Hydrate the buyer company (e.g. project.match_requested) so the ops template
  // can name the requesting org. The admin recipient is resolved by the
  // dispatcher to OPS_NOTIFICATION_EMAIL — this is context only.
  if (typeof payload.companyId === 'string') {
    data.company = await companiesRepository.findById(payload.companyId);
  }

  // Admin fan-out recipients (dispatcher resolves recipient:'admin_users' from
  // data.adminUserIds). Both project.proposal_accepted (BAL-289 ops "raise invoice"
  // nudge) and billing.details_confirmed (BAL-323 "ready to invoice" nudge) need it.
  if (event === 'project.proposal_accepted' || event === 'billing.details_confirmed') {
    data.adminUserIds = await usersRepository.findIdsByPlatformRoles(['admin', 'super_admin']);
  }

  // BAL-289: project.proposal_accepted ALSO fans out to the non-selected experts —
  // the OTHER live 'submitted' proposals on the same request, excluding the accepted
  // one (the winning expert is already covered by `data.expert` above).
  if (event === 'project.proposal_accepted') {
    const projectRequestId = payload.projectRequestId;
    if (typeof projectRequestId === 'string') {
      const all = await proposalsRepository.listByRequest(projectRequestId);
      const siblingProfileIds = all
        .filter(
          (p) =>
            p.status === 'submitted' &&
            p.relationshipId !== payload.relationshipId &&
            p.expertProfileId !== payload.expertProfileId
        )
        .map((p) => p.expertProfileId);
      data.nonSelectedExpertUserIds =
        siblingProfileIds.length > 0
          ? await expertsRepository.findUserIdsByProfileIds(siblingProfileIds)
          : [];
    }
  }

  return { event, payload, data };
}

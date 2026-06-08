import { usersRepository, expertsRepository, companiesRepository } from '@balo/db';
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

  return { event, payload, data };
}

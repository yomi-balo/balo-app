import {
  usersRepository,
  expertsRepository,
  companiesRepository,
  proposalsRepository,
  partyMembershipsRepository,
  agenciesRepository,
} from '@balo/db';
import type { RuleContext } from './rules.js';

/**
 * Events whose rules include an `admin_users` fan-out (dispatcher resolves it from
 * `data.adminUserIds`): the BAL-289 "raise invoice" nudge, the BAL-323 "ready to
 * invoice" nudge, the BAL-332 milestone signals, and the BAL-338 (D7) review-decision
 * events. Data-driven so `resolveContext` stays under the cognitive-complexity gate.
 * NB: engagement.cancelled + engagement.review_reminder are EXCLUDED (no admin
 * recipient — the admin is the actor / the owner is the sole target).
 */
const ADMIN_FANOUT_EVENTS = new Set<string>([
  'project.proposal_accepted',
  'billing.details_confirmed',
  'engagement.milestone_completed',
  'engagement.milestone_reverted',
  'engagement.scope_changed',
  'engagement.completion_requested',
  'engagement.completion_withdrawn',
  'engagement.accepted',
  'engagement.changes_requested',
  'engagement.auto_accepted',
]);

/**
 * BAL-348: hydrate the agency SUMMARY (projected `{ id, name, memberCount }` — no PII)
 * for the owner-facing `agency.provisioned` template. Extracted so `resolveContext`
 * stays under the cognitive-complexity gate. NB: `agency.provisioned` carries
 * `ownerUserId` (NOT `userId`), so the shared `payload.userId → data.user` hydration
 * never fires for it — the owner's name is resolved from `recipientId` by the adapter.
 */
async function hydrateAgencyProvisioned(
  event: string,
  payload: Record<string, unknown>,
  data: Record<string, unknown>
): Promise<void> {
  if (event === 'agency.provisioned' && typeof payload.agencyId === 'string') {
    data.agency = await agenciesRepository.getSummaryById(payload.agencyId);
  }
}

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
  // data.adminUserIds). See ADMIN_FANOUT_EVENTS above for the membership + exclusions.
  if (ADMIN_FANOUT_EVENTS.has(event)) {
    data.adminUserIds = await usersRepository.findIdsByPlatformRoles(['admin', 'super_admin']);
  }

  // BAL-345: the two admin-facing domain-join events fan out to the party's admin
  // (MANAGE_MEMBERS) members. `data.user` (the joiner/requester) is already
  // hydrated above from payload.userId — no requesterUserId/joinedUserId special
  // case needed. listAdminUserIds derives the admin-role set from the pure authz
  // map (never a hardcoded role IN (...)), so a base-member joiner is excluded.
  if (event === 'party.member_joined_via_domain' || event === 'party.join_request_created') {
    const partyType = payload.partyType;
    const partyId = payload.partyId;
    if ((partyType === 'company' || partyType === 'agency') && typeof partyId === 'string') {
      data.partyAdminUserIds = await partyMembershipsRepository.listAdminUserIds(
        partyType,
        partyId
      );
    }
  }

  // BAL-348: agency.provisioned hydration (extracted — see hydrateAgencyProvisioned).
  await hydrateAgencyProvisioned(event, payload, data);

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

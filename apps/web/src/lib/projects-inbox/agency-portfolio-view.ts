import 'server-only';

import {
  partyMembershipsRepository,
  projectEngagementsRepository,
  type EligibleAgency,
  type PortfolioProjectEngagementView,
} from '@balo/db';
import { personDisplayName } from '@balo/shared/parties';
import type { SessionUser } from '@/lib/auth/session';
import { formatPostedRelative } from '@/lib/project-request/request-detail-view';
import { deriveRowForEngagement } from './portfolio-view';
import { rankAgencyRows, type AgencyPortfolioDTO, type AgencyRowView } from './portfolio-row';
import type { PortfolioLens } from './resolve-portfolio-lens';

/**
 * Agency-lens loader (BAL-631). Loads ONE agency at a time, chosen from the viewer's
 * server-derived oversight set: an absent, unknown or disallowed `requestedAgencyId` falls back
 * to the first agency. The caller guarantees `agencies` is non-empty.
 */

const LIVE_STATES = new Set(['changes_requested', 'in_delivery', 'pending_acceptance']);

function toAgencyRow(
  e: PortfolioProjectEngagementView,
  user: SessionUser,
  memberIds: ReadonlySet<string>,
  now: Date
): AgencyRowView {
  const { derived, autoAcceptLabel } = deriveRowForEngagement(e, 'agency', e.company.name);
  const { href, progressLabel, deliveryState } = derived;

  let detailLabel = progressLabel;
  if (autoAcceptLabel !== null) detailLabel = `Auto-accepts ${autoAcceptLabel}`;

  const recencyAt = e.lastActivityAt ?? e.createdAt;
  const { user: expertUser } = e.expertProfile;

  return {
    id: e.id,
    href,
    title: e.projectRequest?.title ?? 'Ongoing engagement',
    companyName: e.company.name,
    deliveryState,
    detailLabel,
    changeRequestNote: deliveryState === 'changes_requested' ? e.changeRequestNote : null,
    deliverer: {
      expertProfileId: e.expertProfile.id,
      name: personDisplayName(expertUser.firstName, expertUser.lastName, 'An expert'),
      avatarUrl: expertUser.avatarUrl,
      isViewer: e.expertProfile.id === user.expertProfileId,
      // Relies on every `expert_profiles.agency_id` link being written alongside a live
      // `agency_members` row, so a missing row means the expert left. Any future import or
      // link path must create that row too.
      isFormerMember: !memberIds.has(expertUser.id),
    },
    updatedRelative: formatPostedRelative(recencyAt, now),
    recencyAtIso: recencyAt.toISOString(),
  };
}

export async function loadAgencyPortfolio(
  user: SessionUser,
  agencies: ReadonlyArray<EligibleAgency>,
  requestedAgencyId: string | undefined,
  allowedLenses: PortfolioLens[],
  now: Date = new Date()
): Promise<AgencyPortfolioDTO> {
  const [first] = agencies;
  if (first === undefined) {
    throw new Error('loadAgencyPortfolio requires at least one oversight agency');
  }
  const selected = agencies.find((agency) => agency.id === requestedAgencyId) ?? first;

  const [engagementRows, memberIds, liveCounts] = await Promise.all([
    projectEngagementsRepository.listPortfolio({ agencyId: selected.id }),
    partyMembershipsRepository.listMemberUserIds('agency', selected.id),
    agencies.length >= 2
      ? projectEngagementsRepository.countLiveByAgency(agencies.map((agency) => agency.id))
      : Promise.resolve(new Map<string, number>()),
  ]);

  const memberSet = new Set(memberIds);
  const all = engagementRows.map((e) => toAgencyRow(e, user, memberSet, now));
  const live = rankAgencyRows(all.filter((r) => LIVE_STATES.has(r.deliveryState)));
  const finishedRows = rankAgencyRows(all.filter((r) => !LIVE_STATES.has(r.deliveryState)));

  const countState = (state: AgencyRowView['deliveryState']): number =>
    live.filter((r) => r.deliveryState === state).length;

  return {
    lens: 'agency',
    allowedLenses,
    agency: { id: selected.id, name: selected.name },
    agencies: agencies.map((agency) => ({
      id: agency.id,
      name: agency.name,
      liveCount: liveCounts.get(agency.id) ?? 0,
    })),
    rows: live,
    finishedRows,
    tiles: {
      changesRequested: countState('changes_requested'),
      inDelivery: countState('in_delivery'),
      pendingAcceptance: countState('pending_acceptance'),
      live: live.length,
      expertCount: new Set(live.map((r) => r.deliverer.expertProfileId)).size,
    },
    isEmpty: live.length === 0 && finishedRows.length === 0,
  };
}

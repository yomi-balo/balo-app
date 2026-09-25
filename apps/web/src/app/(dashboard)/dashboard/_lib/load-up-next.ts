import 'server-only';

import {
  meetingsRepository,
  partyMembershipsRepository,
  upcomingMeetingsRepository,
  type CompanyUpcomingMeeting,
  type ExpertCalendarMeeting,
} from '@balo/db';
import { resolveCompanyParticipation } from '@balo/shared/authz';
import { log } from '@/lib/logging';
import { buildUpNextRowViews, type UpNextEnrichableRow } from './build-up-next-rows';
import { selectUpNextRows, upNextWindow, type UpNextCandidate } from './select-up-next-rows';
import type { UpNextRowView } from './up-next-view-types';

/** A candidate row before enrichment — satisfies both `selectUpNextRows` and the enrichment step. */
type EnrichableCandidate = UpNextCandidate &
  Pick<UpNextEnrichableRow, 'expertProfileId' | 'counterpartyCompanyName'>;

/** Explicit projection (never a spread) into the enrichable shape. Exported for tests. */
export function companyRowToEnrichable(row: CompanyUpcomingMeeting): EnrichableCandidate {
  return {
    meetingId: row.meetingId,
    scheduledStart: row.scheduledStart,
    scheduledEnd: row.scheduledEnd,
    status: row.status,
    contextType: row.contextType,
    contextId: row.contextId,
    projectRequestId: row.projectRequestId,
    owningRowFound: row.owningRowFound,
    expertProfileId: row.expertProfileId,
    counterpartyCompanyName: null,
    roomReady: row.roomReady,
  };
}

/** Explicit projection (never a spread) into the enrichable shape. Exported for tests. The
 *  session's own `expertProfileId` is passed in, never read off the row. */
export function expertRowToEnrichable(
  row: ExpertCalendarMeeting,
  expertProfileId: string
): EnrichableCandidate {
  return {
    meetingId: row.meetingId,
    scheduledStart: row.scheduledStart,
    scheduledEnd: row.scheduledEnd,
    status: row.status,
    contextType: row.contextType,
    contextId: row.contextId,
    projectRequestId: row.projectRequestId,
    owningRowFound: row.owningRowFound,
    expertProfileId,
    counterpartyCompanyName: row.counterpartyCompanyName,
    roomReady: row.roomReady,
  };
}

/**
 * The COMPANY flow (R1). `null` ⇒ the viewer does not participate in the workspace company ⇒
 * OMIT the card. Never touches a meeting read in that branch. `[]` ⇒ Empty state.
 */
export async function loadCompanyUpNext(input: {
  actorUserId: string;
  companyId: string;
  now?: Date;
}): Promise<readonly UpNextRowView[] | null> {
  const { actorUserId, companyId } = input;
  const now = input.now ?? new Date();

  const participation = await resolveCompanyParticipation(
    companyId,
    actorUserId,
    (partyId, userId) => partyMembershipsRepository.getMemberRole('company', partyId, userId)
  );
  if (participation !== 'participant') {
    log.warn('Dashboard up next omitted: viewer does not participate in the workspace company', {
      userId: actorUserId,
      companyId,
      participation,
    });
    return null;
  }

  const { rangeStart, rangeEnd } = upNextWindow(now);
  const rows = await upcomingMeetingsRepository.listForCompany({ companyId, rangeStart, rangeEnd });
  const selected = selectUpNextRows(rows.map(companyRowToEnrichable), now);
  return buildUpNextRowViews(selected, 'company');
}

/** The EXPERT flow. Never `null` — an expert always participates in their own calendar. */
export async function loadExpertUpNext(input: {
  expertProfileId: string;
  now?: Date;
}): Promise<readonly UpNextRowView[]> {
  const { expertProfileId } = input;
  const now = input.now ?? new Date();

  const { rangeStart, rangeEnd } = upNextWindow(now);
  const rows = await meetingsRepository.listCalendarForExpert({
    expertProfileId,
    rangeStart,
    rangeEnd,
  });
  const selected = selectUpNextRows(
    rows.map((row) => expertRowToEnrichable(row, expertProfileId)),
    now
  );
  return buildUpNextRowViews(selected, 'expert');
}

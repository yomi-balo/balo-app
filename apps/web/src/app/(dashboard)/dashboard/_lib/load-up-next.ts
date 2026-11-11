import 'server-only';

import {
  meetingsRepository,
  partyMembershipsRepository,
  upcomingMeetingsRepository,
} from '@balo/db';
import { resolveCompanyParticipation } from '@balo/shared/authz';
import { log } from '@/lib/logging';
import {
  buildUpNextRowViews,
  companyRowToEnrichable,
  expertRowToEnrichable,
} from '@/lib/meetings/build-up-next-rows';
import { selectUpNextRows, upNextWindow } from '@/lib/meetings/select-up-next-rows';
import type { UpNextRowView } from '@/lib/meetings/up-next-view-types';

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

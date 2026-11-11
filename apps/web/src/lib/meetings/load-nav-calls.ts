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
  type EnrichableCandidate,
} from './build-up-next-rows';
import type { NavCallView } from './nav-call-view-types';
import { selectUpNextRows, UP_NEXT_LOOKBACK_MS } from './select-up-next-rows';
import type { UpNextRowView, UpNextWorkspaceType } from './up-next-view-types';

/** Forward horizon of the nav read: a call further out than a day cannot have an open join window. */
export const NAV_CALLS_HORIZON_MS = 24 * 60 * 60 * 1000;
/** Upper bound on rows the pill and its "+N" list can ever show. */
export const NAV_CALLS_ROW_LIMIT = 10;

type CallSource = 'company' | 'expert';

interface SourcedCandidate {
  readonly source: CallSource;
  readonly candidate: EnrichableCandidate;
}

/** `now − 2h .. now + 24h`, well inside the repositories' range caps. */
export function navCallsWindow(now: Date): { rangeStart: Date; rangeEnd: Date } {
  return {
    rangeStart: new Date(now.getTime() - UP_NEXT_LOOKBACK_MS),
    rangeEnd: new Date(now.getTime() + NAV_CALLS_HORIZON_MS),
  };
}

export interface LoadNavCallsInput {
  readonly actorUserId: string;
  /** Workspace scoping only — never an authorization input. */
  readonly workspaceType: UpNextWorkspaceType;
  readonly companyId: string | null;
  readonly expertProfileId: string | null;
  readonly now: Date;
}

async function readCompanyArm(
  input: LoadNavCallsInput,
  window: { rangeStart: Date; rangeEnd: Date }
): Promise<SourcedCandidate[]> {
  const { actorUserId, workspaceType, companyId } = input;
  if (workspaceType !== 'company' || !companyId) return [];

  const participation = await resolveCompanyParticipation(
    companyId,
    actorUserId,
    (partyId, userId) => partyMembershipsRepository.getMemberRole('company', partyId, userId)
  );
  if (participation !== 'participant') {
    log.warn(
      'Nav calls company read skipped: viewer does not participate in the workspace company',
      { userId: actorUserId, companyId, participation }
    );
    return [];
  }

  const rows = await upcomingMeetingsRepository.listForCompany({ companyId, ...window });
  return rows.map((row) => ({ source: 'company', candidate: companyRowToEnrichable(row) }));
}

async function readExpertArm(
  input: LoadNavCallsInput,
  window: { rangeStart: Date; rangeEnd: Date }
): Promise<SourcedCandidate[]> {
  const { expertProfileId } = input;
  if (!expertProfileId) return [];

  const rows = await meetingsRepository.listCalendarForExpert({ expertProfileId, ...window });
  return rows.map((row) => ({
    source: 'expert',
    candidate: expertRowToEnrichable(row, expertProfileId),
  }));
}

/** First occurrence wins; the caller lists the company arm first, so the company row beats the expert row. */
function dedupeByMeetingId(sourced: readonly SourcedCandidate[]): SourcedCandidate[] {
  const byId = new Map<string, SourcedCandidate>();
  for (const entry of sourced) {
    if (!byId.has(entry.candidate.meetingId)) {
      byId.set(entry.candidate.meetingId, entry);
    }
  }
  return [...byId.values()];
}

function compareByStartThenId(a: SourcedCandidate, b: SourcedCandidate): number {
  const byStart = a.candidate.scheduledStart.getTime() - b.candidate.scheduledStart.getTime();
  if (byStart !== 0) return byStart;
  if (a.candidate.meetingId === b.candidate.meetingId) return 0;
  return a.candidate.meetingId < b.candidate.meetingId ? -1 : 1;
}

/** Explicit field-by-field projection (never a spread) so a future field cannot leak onto the wire. */
function toNavCallView(view: UpNextRowView, otherWorkspace: boolean): NavCallView {
  return {
    meetingId: view.meetingId,
    contextType: view.contextType,
    title: view.title,
    counterpartyName: view.counterpartyName,
    counterpartyOrgLabel: view.counterpartyOrgLabel,
    scheduledStart: view.scheduledStart,
    scheduledEnd: view.scheduledEnd,
    status: view.status,
    href: view.href,
    joinPath: view.joinPath,
    rescheduleProposalExpiresAt: view.rescheduleProposalExpiresAt,
    roomReady: view.roomReady,
    otherWorkspace,
  };
}

/**
 * BAL-636 — every call the viewer may be able to join soon, across BOTH of their roles: the
 * workspace-company read (when the active workspace is a company the viewer participates in) plus
 * the viewer's own expert calendar, whatever workspace is active. `[]` ⇒ nothing to show.
 */
export async function loadNavCalls(input: LoadNavCallsInput): Promise<NavCallView[]> {
  const { workspaceType, now } = input;
  const window = navCallsWindow(now);

  const [companyArm, expertArm] = await Promise.all([
    readCompanyArm(input, window),
    readExpertArm(input, window),
  ]);

  const merged = dedupeByMeetingId([...companyArm, ...expertArm]).sort(compareByStartThenId);
  const sourceById = new Map(merged.map((entry) => [entry.candidate.meetingId, entry.source]));

  const selected = selectUpNextRows(
    merged.map((entry) => entry.candidate),
    now,
    NAV_CALLS_ROW_LIMIT
  );
  const companyRows = selected.filter((row) => sourceById.get(row.meetingId) === 'company');
  const expertRows = selected.filter((row) => sourceById.get(row.meetingId) === 'expert');

  const [companyViews, expertViews] = await Promise.all([
    buildUpNextRowViews(companyRows, 'company'),
    buildUpNextRowViews(expertRows, 'expert'),
  ]);
  const viewById = new Map<string, UpNextRowView>(
    [...companyViews, ...expertViews].map((view) => [view.meetingId, view])
  );

  const calls: NavCallView[] = [];
  for (const row of selected) {
    const view = viewById.get(row.meetingId);
    if (view === undefined) continue;
    const otherWorkspace =
      sourceById.get(row.meetingId) === 'expert' && workspaceType === 'company';
    calls.push(toNavCallView(view, otherWorkspace));
  }
  return calls;
}

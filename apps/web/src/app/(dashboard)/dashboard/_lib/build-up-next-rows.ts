import 'server-only';

import {
  rescheduleProposalsRepository,
  upcomingMeetingsRepository,
  type ExpertPartyNames,
  type UpcomingMeetingTitles,
} from '@balo/db';
import { hrefForMeeting } from '@/lib/meetings/href-for-meeting';
import { memberCallPath } from '@/lib/meetings/member-call-path';
import { expertCounterpartyLabels } from '@/lib/meetings/expert-counterparty';
import {
  deriveExpertPartyLabels,
  projectEngagementTitle,
} from '@/lib/engagement/engagement-parties';
import { UP_NEXT_BALO_PARTY_NAME } from './up-next-copy';
import type { UpNextCandidate } from './select-up-next-rows';
import type { UpNextMeetingType, UpNextRowView, UpNextWorkspaceType } from './up-next-view-types';

/**
 * BAL-566 — the ENRICHMENT step: batch-load titles, party names and live reschedule proposals for
 * up to four selected rows, then project each into the client-safe {@link UpNextRowView}.
 *
 * `server-only` — value-imports `@balo/db`.
 */

/** A row narrowed by `selectUpNextRows`, plus the owner scalars the enrichment reads need. */
export interface UpNextEnrichableRow extends UpNextCandidate {
  readonly contextType: UpNextMeetingType;
  /** Company rows: from the parent. Expert rows: the session's own profile id. */
  readonly expertProfileId: string | null;
  /** Expert rows only; company rows: `null`. */
  readonly counterpartyCompanyName: string | null;
}

export interface UpNextLookups {
  readonly titles: UpcomingMeetingTitles;
  readonly partyNamesByProfileId: ReadonlyMap<string, ExpertPartyNames>;
  readonly proposalExpiryByMeetingId: ReadonlyMap<string, Date>;
}

/** Gives "Delivery with the expert" for a kickoff whose delivering expert has no known name. */
const EMPTY_PARTY_NAMES: Pick<ExpertPartyNames, 'type' | 'agencyName' | 'firstName' | 'lastName'> =
  {
    type: 'freelancer',
    agencyName: null,
    firstName: null,
    lastName: null,
  };

interface TitleRefs {
  readonly caseEngagementIds: string[];
  readonly kickoffEngagementIds: string[];
  readonly projectRequestIds: string[];
}

/** Only rows with a VERIFIED owning row contribute — an unverified id is never looked up. */
function titleRefsOf(rows: readonly UpNextEnrichableRow[]): TitleRefs {
  const caseEngagementIds: string[] = [];
  const kickoffEngagementIds: string[] = [];
  const projectRequestIds: string[] = [];
  for (const row of rows) {
    if (!row.owningRowFound || row.contextId === null) continue;
    switch (row.contextType) {
      case 'case':
        caseEngagementIds.push(row.contextId);
        break;
      case 'project_kickoff':
        kickoffEngagementIds.push(row.contextId);
        break;
      case 'project_discovery':
      case 'request_interaction':
        if (row.projectRequestId !== null) projectRequestIds.push(row.projectRequestId);
        break;
      default: {
        const unhandled: never = row.contextType;
        throw new Error(`Unhandled Up next context type: ${String(unhandled)}`);
      }
    }
  }
  return { caseEngagementIds, kickoffEngagementIds, projectRequestIds };
}

/** `company`: every row's expert (client names the delivering expert). `expert`: kickoff rows
 *  only (the delivery-title fallback needs the expert party; the client company needs no name
 *  lookup). */
const NEEDS_PARTY_NAMES: Record<UpNextWorkspaceType, (row: UpNextEnrichableRow) => boolean> = {
  company: () => true,
  expert: (row) => row.contextType === 'project_kickoff',
};

function partyProfileIdsOf(
  rows: readonly UpNextEnrichableRow[],
  workspaceType: UpNextWorkspaceType
): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    if (!NEEDS_PARTY_NAMES[workspaceType](row)) continue;
    if (row.expertProfileId !== null) ids.add(row.expertProfileId);
  }
  return [...ids];
}

function caseMeetingIdsOf(rows: readonly UpNextEnrichableRow[]): string[] {
  return rows.filter((row) => row.contextType === 'case').map((row) => row.meetingId);
}

function resolveUpNextTitle(
  row: UpNextEnrichableRow,
  lookups: Pick<UpNextLookups, 'titles' | 'partyNamesByProfileId'>
): string | null {
  if (!row.owningRowFound) return null;
  switch (row.contextType) {
    case 'case':
      return row.contextId === null
        ? null
        : (lookups.titles.caseTitleByEngagementId.get(row.contextId) ?? null);
    case 'project_kickoff': {
      if (row.contextId === null) return null;
      if (!lookups.titles.kickoffRequestTitleByEngagementId.has(row.contextId)) return null;
      const requestTitle =
        lookups.titles.kickoffRequestTitleByEngagementId.get(row.contextId) ?? null;
      const names =
        row.expertProfileId === null
          ? undefined
          : lookups.partyNamesByProfileId.get(row.expertProfileId);
      const labels = deriveExpertPartyLabels(names ?? EMPTY_PARTY_NAMES);
      return projectEngagementTitle(requestTitle, labels.expertPartyShort);
    }
    case 'project_discovery':
    case 'request_interaction':
      return row.projectRequestId === null
        ? null
        : (lookups.titles.requestTitleById.get(row.projectRequestId) ?? null);
    default: {
      const unhandled: never = row.contextType;
      throw new Error(`Unhandled Up next context type: ${String(unhandled)}`);
    }
  }
}

interface CounterpartyResolution {
  readonly name: string | null;
  readonly orgLabel: string | null;
}

/** company: names the delivering expert (or 'Balo' for a match-routed discovery, or "An expert"
 *  when names are missing). expert: the client company the calendar read already resolved (and
 *  already nulled if unverified). */
const COUNTERPARTY_BY_WORKSPACE: Record<
  UpNextWorkspaceType,
  (
    row: UpNextEnrichableRow,
    lookups: Pick<UpNextLookups, 'partyNamesByProfileId'>
  ) => CounterpartyResolution
> = {
  expert: (row) => ({ name: row.counterpartyCompanyName, orgLabel: null }),
  company: (row, lookups) => {
    if (row.expertProfileId === null) {
      return { name: UP_NEXT_BALO_PARTY_NAME, orgLabel: null };
    }
    const names = lookups.partyNamesByProfileId.get(row.expertProfileId);
    if (names === undefined) {
      return { name: 'An expert', orgLabel: null };
    }
    const labels = expertCounterpartyLabels(names);
    return { name: labels.personName, orgLabel: labels.agencyLabel };
  },
};

function resolveUpNextCounterparty(
  row: UpNextEnrichableRow,
  lookups: Pick<UpNextLookups, 'partyNamesByProfileId'>,
  workspaceType: UpNextWorkspaceType
): CounterpartyResolution {
  return COUNTERPARTY_BY_WORKSPACE[workspaceType](row, lookups);
}

function rescheduleExpiryIso(
  row: UpNextEnrichableRow,
  lookups: Pick<UpNextLookups, 'proposalExpiryByMeetingId'>
): string | null {
  if (row.contextType !== 'case') return null;
  return lookups.proposalExpiryByMeetingId.get(row.meetingId)?.toISOString() ?? null;
}

type LiveProposalSummary = Awaited<
  ReturnType<typeof rescheduleProposalsRepository.findLivePendingByMeetingIds>
>[number];

/** `reschedule_proposal_one_pending_idx` allows at most one pending proposal per meeting; when a
 *  meeting somehow carries several, the LATEST `expiresAt` wins — an explicit comparison, not a
 *  sort. */
function indexProposals(summaries: readonly LiveProposalSummary[]): Map<string, Date> {
  const map = new Map<string, Date>();
  for (const summary of summaries) {
    const existing = map.get(summary.meetingId);
    if (existing === undefined || summary.expiresAt.getTime() > existing.getTime()) {
      map.set(summary.meetingId, summary.expiresAt);
    }
  }
  return map;
}

/**
 * Pure; exported for the key-set test. Explicit field-by-field projection — NEVER a spread of
 * `row` — so a future field added to `UpNextEnrichableRow` cannot silently leak onto the wire.
 */
export function toUpNextRowView(
  row: UpNextEnrichableRow,
  lookups: UpNextLookups,
  workspaceType: UpNextWorkspaceType
): UpNextRowView {
  const counterparty = resolveUpNextCounterparty(row, lookups, workspaceType);
  return {
    meetingId: row.meetingId,
    contextType: row.contextType,
    title: resolveUpNextTitle(row, lookups),
    counterpartyName: counterparty.name,
    counterpartyOrgLabel: counterparty.orgLabel,
    scheduledStart: row.scheduledStart.toISOString(),
    scheduledEnd: row.scheduledEnd.toISOString(),
    status: row.status,
    href: hrefForMeeting(row),
    // BAL-566 fix round 1 (F1, user ruling J1) — the AUTHENTICATED MEMBER call route, never the
    // anonymous guest lobby (`meetingJoinLinkUrl`). See `member-call-path.ts` for why.
    joinPath: memberCallPath(row.meetingId),
    rescheduleProposalExpiresAt: rescheduleExpiryIso(row, lookups),
    // BAL-581 — copied through from the repository's SQL-twin boolean, never recomputed.
    roomReady: row.roomReady,
  };
}

/**
 * `[]` in → `[]` out with ZERO queries. Otherwise ONE `Promise.all` of three batched reads over
 * ≤4 rows (`UP_NEXT_ROW_LIMIT`).
 */
export async function buildUpNextRowViews(
  rows: readonly UpNextEnrichableRow[],
  workspaceType: UpNextWorkspaceType
): Promise<UpNextRowView[]> {
  if (rows.length === 0) {
    return [];
  }

  const refs = titleRefsOf(rows);
  const partyProfileIds = partyProfileIdsOf(rows, workspaceType);
  const caseMeetingIds = caseMeetingIdsOf(rows);

  const [titles, partyNames, proposals] = await Promise.all([
    upcomingMeetingsRepository.findTitles({
      caseEngagementIds: refs.caseEngagementIds,
      kickoffEngagementIds: refs.kickoffEngagementIds,
      projectRequestIds: refs.projectRequestIds,
    }),
    upcomingMeetingsRepository.findExpertPartyNames(partyProfileIds),
    rescheduleProposalsRepository.findLivePendingByMeetingIds(caseMeetingIds),
  ]);

  const lookups: UpNextLookups = {
    titles,
    partyNamesByProfileId: new Map(partyNames.map((names) => [names.expertProfileId, names])),
    proposalExpiryByMeetingId: indexProposals(proposals),
  };

  return rows.map((row) => toUpNextRowView(row, lookups, workspaceType));
}

import 'server-only';

import {
  actionItemsRepository,
  casesIndexRepository,
  creditReceivablesRepository,
  creditWalletsRepository,
  MAX_CASES_INDEX_PAGE_SIZE,
  partyJoinRequestsRepository,
  projectsInboxRepository,
  rescheduleProposalsRepository,
  upcomingMeetingsRepository,
  type CasesIndexCaseRow,
  type ClientOpenActionItemRow,
  type PendingJoinRequestRow,
} from '@balo/db';
import { personDisplayName } from '@balo/shared/parties';
import { CAPABILITIES, hasCapability } from '@/lib/authz';
import type { SessionUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import type { ExpertCounterpartyNameFields } from '@/lib/meetings/expert-counterparty';
import { loadClientPortfolio } from '@/lib/projects-inbox/portfolio-view';
import type { PortfolioRowView } from '@/lib/projects-inbox/portfolio-row';
import { indexLiveProposals } from '../../cases/_lib/build-cases-index-cards';
import { buildClientYourMoveCards, type ClientRescheduleInput } from './build-client-move-cards';
import type { YourMoveActionItem } from './build-your-move-cards';
import {
  collectThreadRefs,
  isNeedsYouMove,
  loadMessageThreads,
  type ThreadRef,
} from './load-your-move';
import type { YourMoveCardView } from './your-move-view-types';

interface Gates {
  readonly billing: boolean;
  readonly participate: boolean;
  readonly members: boolean;
}

/**
 * The date new bookings went on hold, or null when nothing holds them. A hold that a top-up
 * already covers is healed and never shown, so the read is `readHoldStatus`, not "any open
 * receivable". Only the Date leaves this function, never the figure.
 */
async function readBillingHoldSince(companyId: string): Promise<Date | null> {
  const wallet = await creditWalletsRepository.findByCompanyId(companyId);
  if (wallet === undefined) return null;
  const hold = await creditReceivablesRepository.readHoldStatus({ walletId: wallet.id });
  if (!hold.onHold || hold.amountToClearMinor <= 0) return null;
  const [oldest] = await creditReceivablesRepository.findOpenByCompany(companyId);
  return oldest === undefined ? null : oldest.openedAt;
}

function mapActionItems(items: readonly ClientOpenActionItemRow[]): YourMoveActionItem[] {
  return items.map((item) => ({
    engagementId: item.engagementId,
    engagementType: item.engagementType,
    engagementTitle: item.engagementTitle,
    party: { kind: 'expert', expertProfileId: item.expertProfileId },
    body: item.body,
    dueAt: item.dueAt,
    createdAt: item.createdAt,
  }));
}

function mapJoinRequests(
  requests: readonly PendingJoinRequestRow[]
): { name: string; email: string; createdAt: Date }[] {
  return requests.map((request) => ({
    name: personDisplayName(
      request.requester.firstName,
      request.requester.lastName,
      request.requester.email
    ),
    email: request.requester.email,
    createdAt: request.createdAt,
  }));
}

/**
 * Cases with a live (unexpired) pending reschedule proposal, with each proposal's option starts.
 * Every id passed to the repository reads came out of `listOpenCases`.
 */
async function loadReschedules(
  openCases: readonly CasesIndexCaseRow[],
  now: Date
): Promise<ClientRescheduleInput[]> {
  const trailByEngagement = await casesIndexRepository.listCaseTrailMeetings(
    openCases.map((c) => c.engagementId)
  );
  const caseByMeetingId = new Map<string, CasesIndexCaseRow>();
  for (const c of openCases) {
    for (const meeting of trailByEngagement.get(c.engagementId) ?? []) {
      caseByMeetingId.set(meeting.meetingId, c);
    }
  }
  const pending = await rescheduleProposalsRepository.findLivePendingByMeetingIds([
    ...caseByMeetingId.keys(),
  ]);
  const live = [...indexLiveProposals(pending, now).values()];
  const optionsByProposal = await rescheduleProposalsRepository.listLiveOptionStartsByProposalIds(
    live.map((proposal) => proposal.proposalId)
  );
  return live.flatMap((proposal) => {
    const owner = caseByMeetingId.get(proposal.meetingId);
    const optionStarts = optionsByProposal.get(proposal.proposalId);
    if (owner === undefined || optionStarts === undefined) return [];
    return [
      {
        proposalId: proposal.proposalId,
        engagementId: owner.engagementId,
        caseTitle: owner.title,
        expertProfileId: owner.expertProfileId,
        originalScheduledStart: proposal.originalScheduledStart,
        expiresAt: proposal.expiresAt,
        createdAt: proposal.createdAt,
        optionStarts,
      },
    ];
  });
}

function expertIdsOf(
  rows: readonly PortfolioRowView[],
  openCases: readonly CasesIndexCaseRow[],
  actionItems: readonly ClientOpenActionItemRow[]
): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.expertProfileId !== undefined && row.expertProfileId !== null) {
      ids.add(row.expertProfileId);
    }
    for (const thread of row.threadRefs ?? []) {
      if (thread.expertProfileId !== null) ids.add(thread.expertProfileId);
    }
  }
  for (const c of openCases) ids.add(c.expertProfileId);
  for (const item of actionItems) ids.add(item.expertProfileId);
  return [...ids];
}

/**
 * The company "Your move" rail: one card per needs-you Projects-inbox row (ungated, 1:1 with the
 * inbox) plus capability-gated arms. A gated arm's repository read never runs without its
 * capability, so a card the viewer cannot act on is neither built nor fetched.
 */
export async function loadClientYourMove(input: {
  user: SessionUser;
  companyId: string;
  companyName: string;
  now?: Date;
}): Promise<readonly YourMoveCardView[]> {
  const { user, companyId, companyName } = input;
  const now = input.now ?? new Date();

  const scope = { companyId };
  const [billing, participate, members] = await Promise.all([
    hasCapability(user, CAPABILITIES.MANAGE_BILLING, scope),
    hasCapability(user, CAPABILITIES.PARTICIPATE, scope),
    hasCapability(user, CAPABILITIES.MANAGE_MEMBERS, scope),
  ]);
  const gates: Gates = { billing, participate, members };

  const [portfolio, clientActionItems, openCases, pendingJoins, billingHoldSince] =
    await Promise.all([
      loadClientPortfolio(user, [], now),
      gates.participate ? actionItemsRepository.listOpenAssignedToClient(companyId) : [],
      gates.participate
        ? casesIndexRepository.listOpenCases(
            { side: 'company', companyId },
            { limit: MAX_CASES_INDEX_PAGE_SIZE }
          )
        : { rows: [], hasMore: false },
      gates.members ? partyJoinRequestsRepository.listPendingByParty('company', companyId) : [],
      gates.billing ? readBillingHoldSince(companyId) : null,
    ]);
  if (openCases.hasMore) {
    log.warn('Dashboard your move scanned only the first open cases for messages', {
      userId: user.id,
      companyId,
      limit: MAX_CASES_INDEX_PAGE_SIZE,
    });
  }

  const { rows } = portfolio;
  const needsYouRequestIds = rows
    .filter((row) => isNeedsYouMove(row) && row.kind === 'request')
    .map((row) => row.id);
  const caseRefs: ThreadRef[] = openCases.rows.map((c) => ({
    ref: { contextType: 'engagement', contextId: c.engagementId },
    party: { kind: 'expert', expertProfileId: c.expertProfileId },
  }));

  const [details, expertParties, reschedules, messages] = await Promise.all([
    projectsInboxRepository.listClientMoveDetails({
      companyId,
      projectRequestIds: needsYouRequestIds,
    }),
    upcomingMeetingsRepository.findExpertPartyNames(
      expertIdsOf(rows, openCases.rows, clientActionItems)
    ),
    gates.participate ? loadReschedules(openCases.rows, now) : [],
    gates.participate
      ? loadMessageThreads(collectThreadRefs(rows, caseRefs, 'expert'), user.id)
      : [],
  ]);

  for (const id of needsYouRequestIds) {
    if (!details.has(id)) {
      log.warn('Dashboard your move found no detail for a needs-you request', {
        userId: user.id,
        companyId,
        projectRequestId: id,
      });
    }
  }

  const expertNames = new Map<string, ExpertCounterpartyNameFields>(
    expertParties.map((party) => [party.expertProfileId, party])
  );

  return buildClientYourMoveCards({
    rows,
    details,
    expertNames,
    canManageBilling: gates.billing,
    billingHoldSince,
    reschedules,
    joinRequests: mapJoinRequests(pendingJoins),
    companyName,
    actionItems: mapActionItems(clientActionItems),
    messages,
    now,
  });
}

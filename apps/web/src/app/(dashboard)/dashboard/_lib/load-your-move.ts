import 'server-only';

import {
  actionItemsRepository,
  casesIndexRepository,
  conversationContextKey,
  conversationsRepository,
  MAX_CASES_INDEX_PAGE_SIZE,
  projectsInboxRepository,
  type ConversationContextRef,
} from '@balo/db';
import type { SessionUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { loadExpertPortfolio, summaryIsUnread } from '@/lib/projects-inbox/portfolio-view';
import type { PortfolioRowView } from '@/lib/projects-inbox/portfolio-row';
import {
  buildYourMoveCards,
  type YourMoveActionItem,
  type YourMoveMessageThread,
  type YourMoveParty,
} from './build-your-move-cards';
import type { YourMoveRead } from './your-move-view-types';

export interface ThreadRef {
  readonly ref: ConversationContextRef;
  readonly party: YourMoveParty;
}

/** True when the row already renders as a project card on either side. */
export function isNeedsYouMove(row: PortfolioRowView): boolean {
  return (
    row.needsYou &&
    ((row.moveKind !== null && row.moveKind !== undefined) ||
      (row.clientMoveKind !== null && row.clientMoveKind !== undefined))
  );
}

/**
 * The conversations the Messages card may count: the open threads each row names (`threadRefs`,
 * already filtered to open relationships and live engagements) plus the open cases, minus rows
 * already shown as a project card. `counterparty` says who the other party is: the row's client
 * company (expert rail) or the thread's delivering expert (company rail).
 */
export function collectThreadRefs(
  rows: readonly PortfolioRowView[],
  caseRefs: readonly ThreadRef[],
  counterparty: 'company' | 'expert'
): ThreadRef[] {
  const byKey = new Map<string, ThreadRef>();
  const add = (entry: ThreadRef): void => {
    byKey.set(conversationContextKey(entry.ref), entry);
  };
  for (const row of rows) {
    if (isNeedsYouMove(row)) continue;
    for (const thread of row.threadRefs ?? []) {
      add({
        ref: { contextType: thread.contextType, contextId: thread.contextId },
        party:
          counterparty === 'company'
            ? { kind: 'company', name: row.companyName ?? '' }
            : { kind: 'expert', expertProfileId: thread.expertProfileId },
      });
    }
  }
  for (const entry of caseRefs) add(entry);
  return [...byKey.values()];
}

export async function loadMessageThreads(
  refs: readonly ThreadRef[],
  viewerUserId: string
): Promise<YourMoveMessageThread[]> {
  if (refs.length === 0) return [];
  const idByKey = await conversationsRepository.conversationIdsForContexts(
    refs.map((entry) => entry.ref)
  );
  const partyByConversation = new Map<string, YourMoveParty>();
  for (const entry of refs) {
    const conversationId = idByKey.get(conversationContextKey(entry.ref));
    if (conversationId !== undefined) {
      partyByConversation.set(conversationId, entry.party);
    }
  }
  const conversationIds = [...partyByConversation.keys()];
  if (conversationIds.length === 0) return [];

  const [summaries, counts] = await Promise.all([
    conversationsRepository.listThreadSummaries({ conversationIds, viewerUserId }),
    conversationsRepository.countUnreadForViewer({ conversationIds, viewerUserId }),
  ]);

  const threads: YourMoveMessageThread[] = [];
  for (const summary of summaries) {
    if (!summaryIsUnread(summary)) continue;
    const count = counts.get(summary.conversationId);
    const latestActivityAt = summary.latestMessage?.createdAt ?? summary.latestInboundActivityAt;
    if (count === undefined || latestActivityAt === null) continue;
    const latest = summary.latestMessage;
    const party = partyByConversation.get(summary.conversationId);
    if (party === undefined) continue;
    threads.push({
      party,
      unreadCount: count.unreadCount,
      earliestUnreadAt: count.earliestUnreadAt,
      latestInbound:
        latest !== null && latest.senderUserId !== viewerUserId
          ? { body: latest.body, at: latest.createdAt, senderFirstName: latest.senderFirstName }
          : null,
      latestActivityAt,
    });
  }
  return threads;
}

/**
 * The expert "Your move" rail: one card per needs-you Projects-inbox row, plus the calendar
 * blocker, action items and unread messages. Reads the portfolio once and only its live `rows`.
 */
export async function loadExpertYourMove(input: {
  user: SessionUser & { expertProfileId: string };
  calendarNeedsReconnect: boolean;
  now?: Date;
}): Promise<YourMoveRead> {
  const { user, calendarNeedsReconnect } = input;
  const now = input.now ?? new Date();
  const { expertProfileId } = user;

  const [portfolio, actionItems, openCases] = await Promise.all([
    loadExpertPortfolio(user, [], now),
    actionItemsRepository.listOpenAssignedToExpert(expertProfileId),
    casesIndexRepository.listOpenCases(
      { side: 'expert', expertProfileId, viewerUserId: user.id },
      { limit: MAX_CASES_INDEX_PAGE_SIZE }
    ),
  ]);
  if (openCases.hasMore) {
    log.warn('Dashboard your move scanned only the first open cases for messages', {
      userId: user.id,
      limit: MAX_CASES_INDEX_PAGE_SIZE,
    });
  }

  const { rows } = portfolio;
  const requestIds = rows
    .filter((row) => isNeedsYouMove(row) && row.kind === 'request')
    .map((row) => row.id);
  const caseRefs: ThreadRef[] = openCases.rows.map((c) => ({
    ref: { contextType: 'engagement', contextId: c.engagementId },
    party: { kind: 'company', name: c.companyName },
  }));

  const [details, messages] = await Promise.all([
    projectsInboxRepository.listExpertMoveDetails({
      expertProfileId,
      projectRequestIds: requestIds,
    }),
    loadMessageThreads(collectThreadRefs(rows, caseRefs, 'company'), user.id),
  ]);

  for (const id of requestIds) {
    if (!details.has(id)) {
      log.warn('Dashboard your move found no detail for a needs-you request', {
        userId: user.id,
        projectRequestId: id,
      });
    }
  }

  const mappedActionItems: YourMoveActionItem[] = actionItems.map((item) => ({
    engagementId: item.engagementId,
    engagementType: item.engagementType,
    engagementTitle: item.engagementTitle,
    party: { kind: 'company', name: item.companyName },
    body: item.body,
    dueAt: item.dueAt,
    createdAt: item.createdAt,
  }));

  const cards = buildYourMoveCards({
    rows,
    details,
    actionItems: mappedActionItems,
    expertNames: new Map(),
    messages,
    calendarNeedsReconnect,
    now,
  });
  return { cards, rows };
}

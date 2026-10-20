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
import { buildYourMoveCards, type YourMoveMessageThread } from './build-your-move-cards';
import type { YourMoveCardView } from './your-move-view-types';

interface ThreadRef {
  readonly ref: ConversationContextRef;
  readonly companyName: string;
}

function isNeedsYouMove(row: PortfolioRowView): boolean {
  return row.needsYou && row.moveKind !== null && row.moveKind !== undefined;
}

/** The conversations the Messages card may count: every open relationship, engagement and case
 *  the expert is in, minus those already shown as a project card. */
function collectThreadRefs(
  rows: readonly PortfolioRowView[],
  caseRefs: readonly ThreadRef[]
): ThreadRef[] {
  const byKey = new Map<string, ThreadRef>();
  const add = (entry: ThreadRef): void => {
    byKey.set(conversationContextKey(entry.ref), entry);
  };
  for (const row of rows) {
    if (isNeedsYouMove(row)) continue;
    const companyName = row.companyName ?? '';
    if (row.kind === 'engagement') {
      add({ ref: { contextType: 'engagement', contextId: row.id }, companyName });
    } else if (row.relationshipId !== null && row.relationshipId !== undefined) {
      add({
        ref: { contextType: 'relationship', contextId: row.relationshipId },
        companyName,
      });
    }
  }
  for (const entry of caseRefs) add(entry);
  return [...byKey.values()];
}

async function loadMessageThreads(
  refs: readonly ThreadRef[],
  viewerUserId: string
): Promise<YourMoveMessageThread[]> {
  if (refs.length === 0) return [];
  const idByKey = await conversationsRepository.conversationIdsForContexts(
    refs.map((entry) => entry.ref)
  );
  const companyByConversation = new Map<string, string>();
  for (const entry of refs) {
    const conversationId = idByKey.get(conversationContextKey(entry.ref));
    if (conversationId !== undefined) {
      companyByConversation.set(conversationId, entry.companyName);
    }
  }
  const conversationIds = [...companyByConversation.keys()];
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
    threads.push({
      companyName: companyByConversation.get(summary.conversationId) ?? '',
      unreadCount: count.unreadCount,
      earliestUnreadAt: count.earliestUnreadAt,
      latestInbound:
        latest !== null && latest.senderUserId !== viewerUserId
          ? { body: latest.body, at: latest.createdAt }
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
}): Promise<readonly YourMoveCardView[]> {
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
    companyName: c.companyName,
  }));

  const [details, messages] = await Promise.all([
    projectsInboxRepository.listExpertMoveDetails({
      expertProfileId,
      projectRequestIds: requestIds,
    }),
    loadMessageThreads(collectThreadRefs(rows, caseRefs), user.id),
  ]);

  for (const id of requestIds) {
    if (!details.has(id)) {
      log.warn('Dashboard your move found no detail for a needs-you request', {
        userId: user.id,
        projectRequestId: id,
      });
    }
  }

  return buildYourMoveCards({
    rows,
    details,
    actionItems,
    messages,
    calendarNeedsReconnect,
    now,
  });
}

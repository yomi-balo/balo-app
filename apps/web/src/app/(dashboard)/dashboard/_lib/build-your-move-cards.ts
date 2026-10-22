import type { ExpertMoveDetail } from '@balo/db';
import { htmlToPlainText } from '@/components/balo/rich-text/plain-text';
import { expertSettingsHrefFor } from '@/lib/constants/expert-checklist';
import {
  expertCounterpartyLabels,
  type ExpertCounterpartyNameFields,
} from '@/lib/meetings/expert-counterparty';
import { formatPostedRelative } from '@/lib/project-request/request-detail-view';
import type { ExpertMoveKind, PortfolioRowView } from '@/lib/projects-inbox/portfolio-row';
import {
  YOUR_MOVE_ACTION_FINISH_PROPOSAL,
  YOUR_MOVE_ACTION_REPLY,
  YOUR_MOVE_CALENDAR_BODY,
  YOUR_MOVE_CALENDAR_COUNTERPARTY,
  YOUR_MOVE_CALENDAR_TITLE,
  YOUR_MOVE_DRAFT_NOT_STARTED,
  YOUR_MOVE_ONGOING_ENGAGEMENT,
  YOUR_MOVE_SECTION_LABELS,
  yourMoveAskedFact,
  yourMoveCompaniesSentence,
  yourMoveDraftSaved,
  yourMoveEoiSentence,
  yourMoveExpertCounterparty,
  yourMoveInterestFact,
  yourMoveInvitedFact,
  yourMoveOverdueFact,
  yourMoveRequestedFact,
  yourMoveUnreadTitle,
} from './your-move-copy';
import {
  YOUR_MOVE_KIND_META,
  type YourMoveCardView,
  type YourMoveContext,
} from './your-move-view-types';
import type { DashboardYourMoveCardKind } from '@balo/analytics/events';

/** Action items shown inline on a card; the rest collapse into `more`. */
const ACTION_ITEMS_SHOWN = 2;
/** A brief excerpt and a message snippet are cut here; the card clamps further with CSS. */
const EXCERPT_MAX_CHARS = 240;
const SNIPPET_MAX_CHARS = 140;

/** The other party on a thread or action item: the client company, or the delivering expert. */
export type YourMoveParty =
  | { readonly kind: 'company'; readonly name: string }
  | { readonly kind: 'expert'; readonly expertProfileId: string | null };

const UNNAMED_EXPERT = 'An expert';

/** Resolves a party to its display name and org line. A missing expert reads "An expert". */
export function partyLabels(
  party: YourMoveParty,
  expertNames: ReadonlyMap<string, ExpertCounterpartyNameFields>
): { readonly name: string; readonly org: string | null } {
  if (party.kind === 'company') return { name: party.name, org: null };
  const fields =
    party.expertProfileId === null ? undefined : expertNames.get(party.expertProfileId);
  if (fields === undefined) return { name: UNNAMED_EXPERT, org: null };
  const { personName, agencyLabel } = expertCounterpartyLabels(fields);
  return { name: personName, org: agencyLabel };
}

/** One open action item, shared by both rails: the other party is a {@link YourMoveParty}. */
export interface YourMoveActionItem {
  readonly engagementId: string;
  readonly engagementType: 'case' | 'project';
  readonly engagementTitle: string | null;
  readonly party: YourMoveParty;
  readonly body: string;
  readonly dueAt: Date | null;
  readonly createdAt: Date;
}

/** One unread conversation, already resolved to its other party. */
export interface YourMoveMessageThread {
  readonly party: YourMoveParty;
  readonly unreadCount: number;
  readonly earliestUnreadAt: Date | null;
  /**
   * The newest message when it is inbound; null when the newest message is the viewer's.
   * `senderFirstName` is the actual sender's first name, which can be a teammate or Balo staff
   * rather than the thread's counterparty.
   */
  readonly latestInbound: {
    readonly body: string;
    readonly at: Date;
    readonly senderFirstName: string | null;
  } | null;
  readonly latestActivityAt: Date;
}

export interface BuildYourMoveCardsInput {
  readonly rows: readonly PortfolioRowView[];
  readonly details: ReadonlyMap<string, ExpertMoveDetail>;
  readonly actionItems: readonly YourMoveActionItem[];
  readonly expertNames: ReadonlyMap<string, ExpertCounterpartyNameFields>;
  readonly messages: readonly YourMoveMessageThread[];
  readonly calendarNeedsReconnect: boolean;
  readonly now: Date;
}

export function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function cardKindFor(moveKind: ExpertMoveKind): DashboardYourMoveCardKind {
  if (moveKind === 'eoi_propose_times' || moveKind === 'eoi_reply_owed') return 'eoi_followup';
  // The chosen expert on a direct request never sent interest themselves — the client's ask is
  // an invitation, so it reads as one rather than as "Interest sent".
  if (moveKind === 'direct_request') return 'invitation';
  return moveKind;
}

function factFor(moveKind: ExpertMoveKind, rel: string): string | null {
  switch (moveKind) {
    case 'invitation':
    case 'direct_request':
      return yourMoveInvitedFact(rel);
    case 'eoi_propose_times':
    case 'eoi_reply_owed':
      return yourMoveInterestFact(rel);
    case 'proposal_requested':
      return yourMoveRequestedFact(rel);
    case 'changes_requested':
      return yourMoveAskedFact(rel);
    case 'delivery_changes':
      return null;
  }
}

export function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

interface ProjectContext {
  readonly context: YourMoveContext | null;
  readonly actionLabel: string | null;
}

const NO_CONTEXT: ProjectContext = { context: null, actionLabel: null };

interface ProjectContextInput {
  readonly row: PortfolioRowView;
  readonly detail: ExpertMoveDetail | undefined;
  readonly now: Date;
}

function introSentence(row: PortfolioRowView): ProjectContext {
  return {
    context: { type: 'sentence', body: yourMoveEoiSentence(row.companyName ?? '') },
    actionLabel: null,
  };
}

function invitationContext({ detail }: ProjectContextInput): ProjectContext {
  if (detail === undefined) return NO_CONTEXT;
  const excerpt = cut(htmlToPlainText(detail.descriptionHtml), EXCERPT_MAX_CHARS);
  return {
    context: {
      type: 'brief',
      excerpt: excerpt === '' ? null : excerpt,
      tags: dedupe([...detail.productNames, ...detail.tagNames]),
      timeline: detail.timeline,
    },
    actionLabel: null,
  };
}

function replyOwedContext({ row }: ProjectContextInput): ProjectContext {
  const preview = row.signal?.messagePreview;
  if (preview === undefined || preview === '') return introSentence(row);
  return {
    context: { type: 'message', from: row.companyName ?? '', at: null, snippet: preview },
    actionLabel: YOUR_MOVE_ACTION_REPLY,
  };
}

function proposalRequestedContext({ detail, now }: ProjectContextInput): ProjectContext {
  if (detail === undefined) return NO_CONTEXT;
  const proposal = detail.currentProposal;
  if (proposal?.status !== 'draft') {
    return { context: { type: 'draft', label: YOUR_MOVE_DRAFT_NOT_STARTED }, actionLabel: null };
  }
  return {
    context: {
      type: 'draft',
      label: yourMoveDraftSaved(formatPostedRelative(proposal.updatedAt, now)),
    },
    actionLabel: YOUR_MOVE_ACTION_FINISH_PROPOSAL,
  };
}

function changesRequestedContext({ detail }: ProjectContextInput): ProjectContext {
  const change = detail?.latestChangeRequest ?? null;
  if (change === null) return NO_CONTEXT;
  return {
    context: {
      type: 'change_note',
      note: change.note,
      section: YOUR_MOVE_SECTION_LABELS[change.section],
    },
    actionLabel: null,
  };
}

function deliveryContext({ row }: ProjectContextInput): ProjectContext {
  const delivery = row.delivery ?? null;
  if (delivery === null) return NO_CONTEXT;
  return {
    context: {
      type: 'delivery',
      note: delivery.changeRequestNote,
      done: delivery.milestonesDone,
      total: delivery.milestonesTotal,
    },
    actionLabel: null,
  };
}

const PROJECT_CONTEXT_BUILDERS: Record<
  ExpertMoveKind,
  (input: ProjectContextInput) => ProjectContext
> = {
  invitation: invitationContext,
  direct_request: invitationContext,
  eoi_reply_owed: replyOwedContext,
  eoi_propose_times: ({ row }) => introSentence(row),
  proposal_requested: proposalRequestedContext,
  changes_requested: changesRequestedContext,
  delivery_changes: deliveryContext,
};

function projectContext(
  row: PortfolioRowView,
  moveKind: ExpertMoveKind,
  detail: ExpertMoveDetail | undefined,
  now: Date
): ProjectContext {
  return PROJECT_CONTEXT_BUILDERS[moveKind]({ row, detail, now });
}

function projectCards(
  rows: readonly PortfolioRowView[],
  details: ReadonlyMap<string, ExpertMoveDetail>,
  now: Date
): YourMoveCardView[] {
  const cards: YourMoveCardView[] = [];
  for (const row of rows) {
    const { moveKind } = row;
    if (!row.needsYou || moveKind === null || moveKind === undefined) continue;
    const kind = cardKindFor(moveKind);
    const detail = details.get(row.id);
    const { context, actionLabel } = projectContext(row, moveKind, detail, now);
    const asked =
      moveKind === 'changes_requested' ? (detail?.latestChangeRequest?.createdAt ?? null) : null;
    cards.push({
      id: row.id,
      kind,
      title: row.title,
      counterparty: row.companyName ?? '',
      fact: factFor(
        moveKind,
        asked === null ? row.updatedRelative : formatPostedRelative(asked, now)
      ),
      factAt: null,
      factTone: 'muted',
      actionLabel: actionLabel ?? YOUR_MOVE_KIND_META[kind].action,
      href: row.href ?? '/projects',
      waitingSince: asked === null ? row.recencyAtIso : asked.toISOString(),
      deadline: null,
      context,
    });
  }
  return cards;
}

/** The tier-0 blocker. Always the "Out of search" variant: a disconnected calendar implies the
 *  checklist is incomplete, so the expert is not searchable. */
export function buildCalendarCards(input: {
  readonly calendarNeedsReconnect: boolean;
  readonly now: Date;
}): YourMoveCardView[] {
  if (!input.calendarNeedsReconnect) return [];
  return [
    {
      id: 'calendar_reconnect',
      kind: 'calendar_reconnect',
      title: YOUR_MOVE_CALENDAR_TITLE,
      counterparty: YOUR_MOVE_CALENDAR_COUNTERPARTY,
      fact: null,
      factAt: null,
      factTone: 'muted',
      actionLabel: YOUR_MOVE_KIND_META.calendar_reconnect.action,
      href: expertSettingsHrefFor('calendar'),
      waitingSince: input.now.toISOString(),
      deadline: null,
      context: { type: 'sentence', body: YOUR_MOVE_CALENDAR_BODY },
    },
  ];
}

function compareActionItems(a: YourMoveActionItem, b: YourMoveActionItem, now: Date) {
  const nowMs = now.getTime();
  const overdueA = a.dueAt !== null && a.dueAt.getTime() < nowMs;
  const overdueB = b.dueAt !== null && b.dueAt.getTime() < nowMs;
  if (overdueA !== overdueB) return overdueA ? -1 : 1;
  if (a.dueAt !== null && b.dueAt !== null && a.dueAt.getTime() !== b.dueAt.getTime()) {
    return a.dueAt.getTime() - b.dueAt.getTime();
  }
  if ((a.dueAt === null) !== (b.dueAt === null)) return a.dueAt === null ? 1 : -1;
  return a.createdAt.getTime() - b.createdAt.getTime();
}

export function actionItemCards(
  items: readonly YourMoveActionItem[],
  expertNames: ReadonlyMap<string, ExpertCounterpartyNameFields>,
  now: Date
): YourMoveCardView[] {
  const byEngagement = new Map<string, YourMoveActionItem[]>();
  for (const item of items) {
    const group = byEngagement.get(item.engagementId);
    if (group === undefined) byEngagement.set(item.engagementId, [item]);
    else group.push(item);
  }
  const nowMs = now.getTime();
  const cards: YourMoveCardView[] = [];
  for (const [engagementId, group] of byEngagement) {
    const sorted = [...group].sort((a, b) => compareActionItems(a, b, now));
    const [first] = sorted;
    if (first === undefined) continue;
    const overdueCount = sorted.filter((i) => i.dueAt !== null && i.dueAt.getTime() < nowMs).length;
    const oldest = Math.min(...sorted.map((i) => i.createdAt.getTime()));
    const { name, org } = partyLabels(first.party, expertNames);
    cards.push({
      id: `action_items-${engagementId}`,
      kind: 'action_items',
      title: first.engagementTitle ?? YOUR_MOVE_ONGOING_ENGAGEMENT,
      counterparty: yourMoveExpertCounterparty({ personName: name, agencyLabel: org }),
      fact: overdueCount > 0 ? yourMoveOverdueFact(overdueCount) : null,
      factAt: null,
      factTone: overdueCount > 0 ? 'warning' : 'muted',
      actionLabel: YOUR_MOVE_KIND_META.action_items.action,
      href:
        first.engagementType === 'case' ? `/cases/${engagementId}` : `/engagements/${engagementId}`,
      waitingSince: new Date(oldest).toISOString(),
      deadline: null,
      context: {
        type: 'items',
        items: sorted.slice(0, ACTION_ITEMS_SHOWN).map((i) => ({
          text: i.body,
          overdue: i.dueAt !== null && i.dueAt.getTime() < nowMs,
        })),
        more: Math.max(0, sorted.length - ACTION_ITEMS_SHOWN),
      },
    });
  }
  return cards;
}

export function messageCards(
  threads: readonly YourMoveMessageThread[],
  expertNames: ReadonlyMap<string, ExpertCounterpartyNameFields>,
  now: Date,
  quoteFrom: 'party' | 'sender' = 'party'
): YourMoveCardView[] {
  const unread = threads.filter((t) => t.unreadCount > 0);
  if (unread.length === 0) return [];
  const byFreshest = [...unread].sort(
    (a, b) => b.latestActivityAt.getTime() - a.latestActivityAt.getTime()
  );
  const total = unread.reduce((sum, t) => sum + t.unreadCount, 0);
  const earliest = unread
    .map((t) => t.earliestUnreadAt)
    .filter((d): d is Date => d !== null)
    .map((d) => d.getTime());
  const featured = byFreshest.find((t) => t.latestInbound !== null);
  const inbound = featured?.latestInbound ?? null;
  const featuredLabels = featured === undefined ? null : partyLabels(featured.party, expertNames);
  return [
    {
      id: 'messages',
      kind: 'messages',
      title: yourMoveUnreadTitle(total, unread.length),
      counterparty: yourMoveCompaniesSentence(
        dedupe(
          byFreshest.map((t) => {
            const labels = partyLabels(t.party, expertNames);
            return labels.org ?? labels.name;
          })
        )
      ),
      fact: null,
      factAt: null,
      factTone: 'muted',
      actionLabel: YOUR_MOVE_KIND_META.messages.action,
      href: '/messages',
      waitingSince: (earliest.length > 0 ? new Date(Math.min(...earliest)) : now).toISOString(),
      deadline: null,
      context:
        featuredLabels === null || inbound === null
          ? null
          : {
              type: 'message',
              from:
                quoteFrom === 'sender' && inbound.senderFirstName !== null
                  ? inbound.senderFirstName
                  : yourMoveExpertCounterparty({
                      personName: featuredLabels.name,
                      agencyLabel: featuredLabels.org,
                    }),
              at: formatPostedRelative(inbound.at, now),
              snippet: cut(htmlToPlainText(inbound.body), SNIPPET_MAX_CHARS),
            },
    },
  ];
}

/** Tier ASC, cards with a deadline first (soonest first), oldest waiting, then id. */
export function sortYourMoveCards(cards: readonly YourMoveCardView[]): YourMoveCardView[] {
  return [...cards].sort((a, b) => {
    const tierA = YOUR_MOVE_KIND_META[a.kind].tier;
    const tierB = YOUR_MOVE_KIND_META[b.kind].tier;
    if (tierA !== tierB) return tierA - tierB;
    if ((a.deadline === null) !== (b.deadline === null)) return a.deadline === null ? 1 : -1;
    if (a.deadline !== null && b.deadline !== null && a.deadline !== b.deadline) {
      return a.deadline < b.deadline ? -1 : 1;
    }
    if (a.waitingSince !== b.waitingSince) return a.waitingSince < b.waitingSince ? -1 : 1;
    if (a.id === b.id) return 0;
    return a.id < b.id ? -1 : 1;
  });
}

export function buildYourMoveCards(input: BuildYourMoveCardsInput): YourMoveCardView[] {
  const { rows, details, actionItems, expertNames, messages, calendarNeedsReconnect, now } = input;
  return sortYourMoveCards([
    ...buildCalendarCards({ calendarNeedsReconnect, now }),
    ...projectCards(rows, details, now),
    ...actionItemCards(actionItems, expertNames, now),
    ...messageCards(messages, expertNames, now),
  ]);
}

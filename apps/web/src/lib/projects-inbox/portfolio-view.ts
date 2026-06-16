import 'server-only';

import {
  conversationsRepository,
  projectsInboxRepository,
  type PortfolioRequestRow,
  type PortfolioInvitationRow,
  type PortfolioEngagementRow,
} from '@balo/db';
import type { SessionUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { isThreadOpenStatus, previewOfHtml } from '@/lib/project-request/conversation-view-types';
import { formatPostedRelative } from '@/lib/project-request/request-detail-view';
import type { PortfolioLens } from './resolve-portfolio-lens';
import {
  maxDate,
  needsYouFor,
  needsYouForExpert,
  nudgeForEngagement,
  requestRecencyAt,
  stageChipFor,
  stageChipForRelationship,
  stageLabelFor,
  adminStallDays,
  tilesFromRows,
  type AdminKanbanColumn,
  type AdminPortfolioDTO,
  type AdminTriageCard,
  type PortfolioDTO,
  type PortfolioRowView,
  type RequestThreadSignal,
  type StageKey,
} from './portfolio-row';

/**
 * portfolio-view — the `server-only` loaders for the A7 portfolio dashboard
 * (BAL-274). Each loader: (1) calls the aggregation repo for the lens's request
 * graph, (2) runs ONE batched `conversationsRepository.listThreadSummaries(...)`
 * over the union of OPEN relationship ids, (3) folds the summaries into
 * request-level signals, (4) runs the PURE derivers in `portfolio-row.ts`, and
 * (5) emits a fully serialisable DTO (ISO strings + relative labels — no `Date`
 * crosses the RSC boundary). ≈ 2 round trips per lens, independent of size.
 *
 * Soft hydration misses (a relationship id with no summary row) fail SOFT to "no
 * signal" via `log.warn` — a summary hiccup never crashes the dashboard.
 */

/**
 * One batched thread summary — inferred from the repo method's return type (the
 * `ConversationThreadSummary` interface is internal to the conversations
 * repository and not re-exported from `@balo/db`). Inferring keeps this module
 * decoupled from that private surface.
 */
type ThreadSummary = Awaited<
  ReturnType<typeof conversationsRepository.listThreadSummaries>
>[number];

/** Days threshold for the admin triage "overdue" pill (the design's `>24h`). */
const TRIAGE_OVERDUE_MS = 24 * 60 * 60 * 1000;

/** Counterpart label for an inbound signal, by lens. */
const COUNTERPART_LABEL: Record<'client' | 'expert', string> = {
  client: 'Expert',
  expert: 'Client',
};

/** The OPEN relationship ids the client/admin lens summarises for a request. */
function openRelationshipIds(row: PortfolioRequestRow): string[] {
  return row.relationships.filter((r) => isThreadOpenStatus(r.status)).map((r) => r.id);
}

/** A thread is unread when inbound activity is newer than the viewer's read mark. */
function summaryIsUnread(summary: ThreadSummary): boolean {
  const inboundAt = summary.latestInboundActivityAt;
  if (inboundAt === null) return false;
  const lastReadAt = summary.lastReadAt;
  return lastReadAt === null || inboundAt.getTime() > lastReadAt.getTime();
}

/** The viewer owes a reply when the latest message is not theirs. */
function summaryAwaitsReply(summary: ThreadSummary, viewerUserId: string): boolean {
  const latest = summary.latestMessage;
  return latest !== null && latest.senderUserId !== viewerUserId;
}

/** Resolve the open-thread summaries the loader hydrated for a request. */
function resolveSummaries(
  relationshipIds: string[],
  summaryById: Map<string, ThreadSummary>
): ThreadSummary[] {
  const resolved: ThreadSummary[] = [];
  for (const relationshipId of relationshipIds) {
    const summary = summaryById.get(relationshipId);
    if (summary === undefined) {
      log.warn('Portfolio thread summary missing for open relationship', { relationshipId });
      continue;
    }
    resolved.push(summary);
  }
  return resolved;
}

/**
 * The freshest inbound signal preview across a request's threads, or null.
 * `from` is the sender's real first name when known (from the batched summary),
 * falling back to the lens's counterpart label when the name is unset.
 */
function freshestInboundSignal(
  summaries: ThreadSummary[],
  counterpartLabel: string
): { from: string; messagePreview: string } | null {
  const ranked = summaries
    .filter((s) => s.latestInboundActivityAt !== null && s.latestMessage !== null)
    .sort(
      (a, b) =>
        (b.latestInboundActivityAt?.getTime() ?? 0) - (a.latestInboundActivityAt?.getTime() ?? 0)
    );
  for (const summary of ranked) {
    const latest = summary.latestMessage;
    const preview = latest === null ? null : previewOfHtml(latest.body);
    if (preview !== null && latest !== null) {
      return { from: latest.senderFirstName ?? counterpartLabel, messagePreview: preview };
    }
  }
  return null;
}

/**
 * Fold a request's open-thread summaries into a single request-level signal.
 * `viewerUserId` decides whether the latest message is the viewer's (no reply
 * owed) or inbound (reply owed); unread mirrors `conversation-view.ts`.
 */
function foldSignal(
  relationshipIds: string[],
  summaryById: Map<string, ThreadSummary>,
  viewerUserId: string,
  counterpartLabel: string
): RequestThreadSignal {
  const summaries = resolveSummaries(relationshipIds, summaryById);
  return {
    anyUnread: summaries.some(summaryIsUnread),
    awaitingViewerReply: summaries.some((s) => summaryAwaitsReply(s, viewerUserId)),
    freshestSignal: freshestInboundSignal(summaries, counterpartLabel),
  };
}

/** Batch-load + index thread summaries for a set of relationship ids. */
async function loadSummaryIndex(
  relationshipIds: string[],
  viewerUserId: string
): Promise<Map<string, ThreadSummary>> {
  const summaries = await conversationsRepository.listThreadSummaries({
    relationshipIds,
    viewerUserId,
  });
  return new Map(summaries.map((s) => [s.relationshipId, s]));
}

/** Build a participant request row view from a hydrated request + its signal. */
function toClientRowView(
  row: PortfolioRequestRow,
  signal: RequestThreadSignal,
  now: Date
): PortfolioRowView {
  const recencyAt = requestRecencyAt(row);
  const { needsYou, nudgeLabel } = needsYouFor('client', row, signal, now);
  const chip = stageChipFor(row.status);
  return {
    id: row.id,
    href: `/projects/${row.id}`,
    title: row.title,
    companyName: row.company.name,
    stage: chip.key,
    stageLabel: chip.label,
    needsYou,
    nudgeLabel,
    unread: signal.anyUnread,
    updatedRelative: formatPostedRelative(recencyAt, now),
    recencyAtIso: recencyAt.toISOString(),
    signal: signal.freshestSignal,
    kind: 'request',
  };
}

/** Build an expert invitation row view from a flat invitation + its signal. */
function toExpertRowView(
  invitation: PortfolioInvitationRow,
  signal: RequestThreadSignal,
  now: Date
): PortfolioRowView {
  const { needsYou, nudgeLabel } = needsYouForExpert(invitation, signal);
  const chip = stageChipForRelationship(invitation.relationshipStatus);
  // The expert's recency: newest of invite, row update, and newest EOI.
  const recencyAt = maxDate(
    invitation.invitedAt,
    invitation.newestEoiAt === null
      ? [invitation.relationshipUpdatedAt]
      : [invitation.relationshipUpdatedAt, invitation.newestEoiAt]
  );
  return {
    id: invitation.projectRequestId,
    href: `/projects/${invitation.projectRequestId}`,
    title: invitation.title,
    companyName: invitation.companyName,
    stage: chip.key,
    stageLabel: chip.label,
    needsYou,
    nudgeLabel,
    unread: signal.anyUnread,
    updatedRelative: formatPostedRelative(recencyAt, now),
    recencyAtIso: recencyAt.toISOString(),
    signal: signal.freshestSignal,
    kind: 'request',
  };
}

/** Build an expert engagement row view ("Live project"). */
function toEngagementRowView(engagement: PortfolioEngagementRow, now: Date): PortfolioRowView {
  const { needsYou, nudgeLabel, href } = nudgeForEngagement(engagement);
  const recencyAt = engagement.activatedAt ?? engagement.createdAt;
  return {
    id: engagement.id,
    href,
    title: 'Live project',
    companyName: null,
    stage: 'kicked',
    stageLabel: stageLabelFor('kicked'),
    needsYou,
    nudgeLabel,
    unread: false,
    updatedRelative: formatPostedRelative(recencyAt, now),
    recencyAtIso: recencyAt.toISOString(),
    signal: null,
    kind: 'engagement',
  };
}

/** Sort needs-you-first, then recency desc (the canonical portfolio ORDER BY). */
function rankRows(rows: PortfolioRowView[]): PortfolioRowView[] {
  return [...rows].sort((a, b) => {
    if (a.needsYou !== b.needsYou) return a.needsYou ? -1 : 1;
    return Date.parse(b.recencyAtIso) - Date.parse(a.recencyAtIso);
  });
}

/** Client lens loader. */
export async function loadClientPortfolio(
  user: SessionUser,
  allowedLenses: PortfolioLens[],
  now: Date = new Date()
): Promise<PortfolioDTO> {
  const requests = await projectsInboxRepository.listByCompany(user.companyId);
  const relationshipIds = requests.flatMap(openRelationshipIds);
  const summaryById = await loadSummaryIndex(relationshipIds, user.id);

  const rows = requests.map((row) => {
    const signal = foldSignal(
      openRelationshipIds(row),
      summaryById,
      user.id,
      COUNTERPART_LABEL.client
    );
    return toClientRowView(row, signal, now);
  });

  const ranked = rankRows(rows);
  return {
    lens: 'client',
    allowedLenses,
    rows: ranked,
    tiles: tilesFromRows(ranked),
    isEmpty: ranked.length === 0,
  };
}

/** Expert lens loader (invitations + active engagements). */
export async function loadExpertPortfolio(
  user: SessionUser & { expertProfileId: string },
  allowedLenses: PortfolioLens[],
  now: Date = new Date()
): Promise<PortfolioDTO> {
  const [invitations, engagements] = await Promise.all([
    projectsInboxRepository.listInvitationsByExpert(user.expertProfileId),
    projectsInboxRepository.listEngagementsByExpert(user.expertProfileId),
  ]);

  // Only the viewer's own relationship threads matter for the expert lens; one
  // relationship id per invitation row.
  const relationshipIds = invitations.map((i) => i.relationshipId);
  const summaryById = await loadSummaryIndex(relationshipIds, user.id);

  const invitationRows = invitations.map((invitation) => {
    const signal = foldSignal(
      [invitation.relationshipId],
      summaryById,
      user.id,
      COUNTERPART_LABEL.expert
    );
    return toExpertRowView(invitation, signal, now);
  });

  const engagementRows = engagements.map((e) => toEngagementRowView(e, now));

  const ranked = rankRows([...invitationRows, ...engagementRows]);
  return {
    lens: 'expert',
    allowedLenses,
    rows: ranked,
    tiles: tilesFromRows(ranked),
    isEmpty: ranked.length === 0,
  };
}

/** The admin kanban stage order (the design's pipeline columns). */
const KANBAN_STAGES: ReadonlyArray<{ stage: StageKey; label: string }> = [
  { stage: 'invited', label: 'Inviting' },
  { stage: 'eoi', label: 'Conversations' },
  { stage: 'prop_req', label: 'Proposal requested' },
  { stage: 'prop_in', label: 'Proposals' },
  { stage: 'accepted', label: 'Kickoff gate' },
];

/**
 * Admin lens loader (triage hero + pipeline kanban + tiles). Returns
 * platform-wide data, so it asserts the caller actually qualifies for the admin
 * lens (defence-in-depth — the loader cannot leak even if a future call site
 * forgets to gate on the resolved lens).
 */
export async function loadAdminPortfolio(
  allowedLenses: PortfolioLens[],
  now: Date = new Date()
): Promise<AdminPortfolioDTO> {
  if (!allowedLenses.includes('admin')) {
    throw new Error('loadAdminPortfolio called for a viewer without the admin lens');
  }

  const requests = await projectsInboxRepository.listAll();

  // Triage hero = status 'requested' (+ draft), newest first.
  const triage: AdminTriageCard[] = requests
    .filter((r) => r.status === 'requested' || r.status === 'draft')
    .map((r) => ({
      id: r.id,
      href: `/projects/${r.id}`,
      title: r.title,
      companyName: r.company.name,
      raisedRelative: formatPostedRelative(r.createdAt, now),
      overdue: now.getTime() - r.createdAt.getTime() > TRIAGE_OVERDUE_MS,
    }));

  // Kanban columns by stage (requested → triage hero; kickoff_approved → live, excluded).
  const kanban: AdminKanbanColumn[] = KANBAN_STAGES.map(({ stage, label }) => ({
    stage,
    label,
    items: requests
      .filter((r) => {
        if (r.status === 'requested' || r.status === 'draft' || r.status === 'kickoff_approved') {
          return false;
        }
        return stageChipFor(r.status).key === stage;
      })
      .map((r) => {
        const stall = adminStallDays(r, now);
        const gateOwed =
          r.status === 'accepted' &&
          (r.clientBillingConfirmedAt === null || r.expertTermsConfirmedAt === null);
        let stalledLabel: string | null = null;
        if (r.status === 'experts_invited' && stall !== null) {
          stalledLabel = `No EOIs · ${stall}d`;
        } else if (gateOwed) {
          stalledLabel = 'Kickoff gate';
        }
        return {
          id: r.id,
          href: `/projects/${r.id}`,
          title: r.title,
          companyName: r.company.name,
          updatedRelative: formatPostedRelative(requestRecencyAt(r), now),
          stalledLabel,
        };
      }),
  }));

  const pipeline = kanban.reduce((sum, col) => sum + col.items.length, 0);
  const stalled = kanban.reduce(
    (sum, col) => sum + col.items.filter((i) => i.stalledLabel !== null).length,
    0
  );
  const gate = requests.filter(
    (r) =>
      r.status === 'accepted' &&
      (r.clientBillingConfirmedAt === null || r.expertTermsConfirmedAt === null)
  ).length;

  return {
    lens: 'admin',
    allowedLenses,
    triage,
    kanban,
    tiles: { untriaged: triage.length, stalled, pipeline, gate },
    isEmpty: triage.length === 0 && pipeline === 0,
  };
}

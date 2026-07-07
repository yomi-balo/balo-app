import 'server-only';

import {
  conversationsRepository,
  engagementsRepository,
  projectsInboxRepository,
  AUTO_ACCEPT_DAYS,
  type PortfolioRequestRow,
  type PortfolioInvitationRow,
  type PortfolioEngagementView,
} from '@balo/db';
import { expertPartyDisplayName } from '@balo/shared/parties';
import type { SessionUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { isThreadOpenStatus, previewOfHtml } from '@/lib/project-request/conversation-view-types';
import { formatPostedRelative } from '@/lib/project-request/request-detail-view';
import type { PortfolioLens } from './resolve-portfolio-lens';
import {
  deriveEngagementRow,
  maxDate,
  needsYouFor,
  needsYouForExpert,
  requestRecencyAt,
  stageChipFor,
  stageChipForRelationship,
  stageLabelFor,
  adminStallDays,
  tilesFromRows,
  type AdminKanbanCard,
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

/** The D7 auto-accept window in ms — value-imported ONLY in this server-only file. */
const AUTO_ACCEPT_MS = AUTO_ACCEPT_DAYS * 24 * 60 * 60 * 1000;

/**
 * Short absolute auto-accept label ("Jul 14") — UTC-pinned so it is deterministic
 * across viewers and CI runners (memory `reference_web_tests_need_tz_utc`). The
 * date is the completion request plus the D7 window; the loader passes the result
 * to the pure deriver as a preformatted string (no `Date` crosses the boundary).
 */
function formatAutoAcceptLabel(completionRequestedAt: Date): string {
  const at = new Date(completionRequestedAt.getTime() + AUTO_ACCEPT_MS);
  return new Intl.DateTimeFormat('en-GB', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(at);
}

/**
 * The set of `projectRequestId`s that already have an engagement row — used to
 * suppress the superseded `kickoff_approved` request/invitation row (one project,
 * one row). Retainer engagements (`projectRequestId === null`) NEVER enter the set
 * — a null must never key the dedup.
 */
function buildEngagedRequestIds(
  engagementRows: ReadonlyArray<PortfolioEngagementView>
): Set<string> {
  const ids = new Set<string>();
  for (const e of engagementRows) {
    if (e.projectRequestId !== null) {
      ids.add(e.projectRequestId);
    }
  }
  return ids;
}

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

/**
 * Build a delivery-engagement inbox row from a hydrated portfolio engagement.
 * The counterpart (client lens → the expert party display name; expert lens → the
 * client company) is resolved here, so only the resulting string crosses the RSC
 * boundary. The auto-accept date is preformatted server-side (UTC-pinned).
 */
function toEngagementRowView(
  e: PortfolioEngagementView,
  lens: 'client' | 'expert',
  now: Date
): PortfolioRowView {
  const counterpartName =
    lens === 'client'
      ? expertPartyDisplayName({
          type: e.expertProfile.type,
          agencyName: e.expertProfile.agency?.name ?? null,
          firstName: e.expertProfile.user.firstName,
          lastName: e.expertProfile.user.lastName,
        })
      : e.company.name;

  const autoAcceptLabel =
    e.status === 'pending_acceptance' && e.completionRequestedAt !== null
      ? formatAutoAcceptLabel(e.completionRequestedAt)
      : null;

  const { needsYou, nudgeLabel, href, progressLabel } = deriveEngagementRow({
    engagementId: e.id,
    status: e.status,
    lens,
    hasChangeRequest: e.status === 'active' && e.changeRequestNote !== null,
    counterpartName,
    totalMilestones: e.totalMilestones,
    completedMilestones: e.completedMilestones,
    autoAcceptLabel,
  });

  const recencyAt = e.lastActivityAt ?? e.createdAt;

  return {
    id: e.id,
    href,
    title: e.projectRequest?.title ?? 'Ongoing engagement',
    companyName: counterpartName,
    stage: 'kicked',
    stageLabel: stageLabelFor('kicked'),
    needsYou,
    nudgeLabel,
    progressLabel,
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

/** Client lens loader (requests + delivery engagements, deduped on request id). */
export async function loadClientPortfolio(
  user: SessionUser,
  allowedLenses: PortfolioLens[],
  now: Date = new Date()
): Promise<PortfolioDTO> {
  const [requests, engagementRows] = await Promise.all([
    projectsInboxRepository.listByCompany(user.companyId),
    engagementsRepository.listPortfolioEngagements({ companyId: user.companyId }),
  ]);

  const engagedRequestIds = buildEngagedRequestIds(engagementRows);
  // One project, one row: drop the kickoff_approved request row once its
  // engagement exists. A kickoff_approved request with NO engagement yet is KEPT
  // — the project never vanishes from the inbox.
  const survivingRequests = requests.filter(
    (r) => !(r.status === 'kickoff_approved' && engagedRequestIds.has(r.id))
  );

  const relationshipIds = survivingRequests.flatMap(openRelationshipIds);
  const summaryById = await loadSummaryIndex(relationshipIds, user.id);

  const requestRows = survivingRequests.map((row) => {
    const signal = foldSignal(
      openRelationshipIds(row),
      summaryById,
      user.id,
      COUNTERPART_LABEL.client
    );
    return toClientRowView(row, signal, now);
  });

  const engagementViews = engagementRows.map((e) => toEngagementRowView(e, 'client', now));

  const ranked = rankRows([...requestRows, ...engagementViews]);
  return {
    lens: 'client',
    allowedLenses,
    rows: ranked,
    tiles: tilesFromRows(ranked),
    isEmpty: ranked.length === 0,
  };
}

/** Expert lens loader (invitations + delivery engagements, deduped on request id). */
export async function loadExpertPortfolio(
  user: SessionUser & { expertProfileId: string },
  allowedLenses: PortfolioLens[],
  now: Date = new Date()
): Promise<PortfolioDTO> {
  const [invitations, engagementRows] = await Promise.all([
    projectsInboxRepository.listInvitationsByExpert(user.expertProfileId),
    engagementsRepository.listPortfolioEngagements({ expertProfileId: user.expertProfileId }),
  ]);

  const engagedRequestIds = buildEngagedRequestIds(engagementRows);
  // FIX the live double-render: a kicked-off invitation is superseded by its
  // engagement row (both carry the same projectRequestId today), so drop it.
  const survivingInvitations = invitations.filter(
    (i) => !(i.requestStatus === 'kickoff_approved' && engagedRequestIds.has(i.projectRequestId))
  );

  // Only the viewer's own relationship threads matter for the expert lens; one
  // relationship id per surviving invitation row (no wasted lookup for suppressed).
  const relationshipIds = survivingInvitations.map((i) => i.relationshipId);
  const summaryById = await loadSummaryIndex(relationshipIds, user.id);

  const invitationRows = survivingInvitations.map((invitation) => {
    const signal = foldSignal(
      [invitation.relationshipId],
      summaryById,
      user.id,
      COUNTERPART_LABEL.expert
    );
    return toExpertRowView(invitation, signal, now);
  });

  const engagementViews = engagementRows.map((e) => toEngagementRowView(e, 'expert', now));

  const ranked = rankRows([...invitationRows, ...engagementViews]);
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

  const [requests, engagementRows] = await Promise.all([
    projectsInboxRepository.listAll(),
    engagementsRepository.listPortfolioEngagements({ platform: true }),
  ]);

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

  // Origination kanban columns by stage (requested → triage hero; kickoff_approved
  // → in delivery, excluded here and appended below).
  const originationColumns: AdminKanbanColumn[] = KANBAN_STAGES.map(({ stage, label }) => ({
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

  // Pipeline + stalled tiles span the ORIGINATION columns ONLY — computed BEFORE
  // appending the delivery column so the tile semantics stay stable.
  const pipeline = originationColumns.reduce((sum, col) => sum + col.items.length, 0);
  const stalled = originationColumns.reduce(
    (sum, col) => sum + col.items.filter((i) => i.stalledLabel !== null).length,
    0
  );
  const gate = requests.filter(
    (r) =>
      r.status === 'accepted' &&
      (r.clientBillingConfirmedAt === null || r.expertTermsConfirmedAt === null)
  ).length;

  // "In delivery" — post-kickoff engagements still in flight (terminal excluded).
  // Presence + link only; delivery-oversight metrics belong to D5 (not this slice).
  const delivery: AdminKanbanCard[] = engagementRows
    .filter((e) => e.status === 'active' || e.status === 'pending_acceptance')
    .map((e) => ({
      id: e.id,
      href: `/engagements/${e.id}?from=inbox`,
      title: e.projectRequest?.title ?? 'Ongoing engagement',
      companyName: e.company.name,
      updatedRelative: formatPostedRelative(e.lastActivityAt ?? e.createdAt, now),
      stalledLabel: e.status === 'pending_acceptance' ? 'Awaiting client' : null,
    }));

  const kanban: AdminKanbanColumn[] = [
    ...originationColumns,
    { stage: 'kicked', label: 'In delivery', items: delivery },
  ];

  return {
    lens: 'admin',
    allowedLenses,
    triage,
    kanban,
    tiles: { untriaged: triage.length, stalled, pipeline, gate },
    isEmpty: triage.length === 0 && pipeline === 0 && delivery.length === 0,
  };
}

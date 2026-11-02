import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Database } from '../client';
import {
  actionItems,
  adminAlerts,
  agencies,
  agencyMembers,
  auditEvents,
  companies,
  conversationContexts,
  conversationFiles,
  conversationMessages,
  conversationReadStates,
  conversations,
  engagementChangeOrderLines,
  engagementChangeOrders,
  engagementMilestones,
  engagements,
  engagementTimeEntries,
  expertProfiles,
  expressionsOfInterest,
  products,
  projectChangeRequestMilestones,
  projectChangeRequests,
  projectEngagements,
  projectRequestProducts,
  projectRequests,
  projectRequestTags,
  projectTags,
  proposalChangeRequests,
  proposalDraftGenerations,
  proposalMilestones,
  proposalPaymentInstallments,
  proposals,
  requestExpertRelationships,
  requestFileGrants,
  requestSharedFiles,
  userNotifications,
  users,
} from '../schema';
import { HELP_IDS, HELP_WORLD_IDS, helpAgencyMilestoneId, helpThreadIds } from './constants';

/**
 * The project world behind the help fixture's newer states: Northwind's fixed-price and T&M
 * projects with Priya, the request and proposal world, the two dashboards' rails, the CloudPeak
 * agency and the case files. Nothing here is in the base fixture: each state inserts what it
 * needs and `deleteHelpWorld` (run by `restoreBase` and `resetHelpFixture`) removes all of it,
 * so the nine published guides keep rendering exactly as before.
 *
 * Rows are written the way the repositories write them, with raw drizzle and fixed ids (the
 * `seed.ts` exception, as in `fixture.ts`). Timestamps follow two clocks:
 *   - anchor-relative, at least eight days before the anchor Monday, wherever the page prints a
 *     date or the row must sit in the real past whatever weekday the run is (the anchor is one
 *     to seven days ahead of the real clock);
 *   - real-now-relative wherever the server prints a relative time ("3 days ago"), or a sweep
 *     reads the row (auto-accept, review nudges).
 */

export type HelpExecutor = Pick<Database, 'insert' | 'update' | 'delete' | 'select'>;

export interface HelpWorldContext {
  anchor: Date;
  /** Real clock at state-apply time. */
  nowMs: number;
  danaId: string;
  priyaId: string;
  salesforceId: string;
}

const W = HELP_WORLD_IDS;
const P = W.people;

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;
const FIXED_DECISION_TIME = new Date('2026-01-05T00:00:00Z');
const DIRECT_REQUEST_EOI_MESSAGE = '<p>Invited by client</p>';
const BALO_FEE_BPS = 2500;

/** `days` after the anchor Monday at `hour:minute:second` UTC (negative days are before it). */
function atAnchor(ctx: HelpWorldContext, days: number, hour: number, minute = 0, second = 0): Date {
  const instant = new Date(ctx.anchor.getTime() + days * MS_PER_DAY);
  instant.setUTCHours(hour, minute, second, 0);
  return instant;
}

/** `YYYY-MM-DD` of the anchor-relative day, for `date` columns. */
function anchorDay(ctx: HelpWorldContext, days: number): string {
  return atAnchor(ctx, days, 0).toISOString().slice(0, 10);
}

/** Real now minus `hours`. */
function hoursAgo(ctx: HelpWorldContext, hours: number): Date {
  return new Date(ctx.nowMs - hours * MS_PER_HOUR);
}

/** "9 Jul 2026", as `formatLongUtc` in `@balo/shared/timezone` prints it. */
function formatLongUtc(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

// ── Id lists for removal ──────────────────────────────────────────────────

const WORLD_ENGAGEMENT_IDS = [
  W.fixed.engagement,
  W.tm.engagement,
  W.dashboards.migrationEngagement,
  W.dashboards.referralsEngagement,
  W.agency.routing,
  W.agency.migration,
  W.agency.dashboards,
  W.agency.cpq,
  W.agency.portal,
  W.agency.flowAudit,
  W.agency.journey,
  W.agency.fieldService,
  W.agency.intake,
];

const WORLD_REQUEST_IDS = [
  W.fixed.request,
  W.tm.request,
  W.requests.direct,
  W.requests.drafted,
  W.requests.fixed,
  W.requests.tm,
  W.requests.revise,
  W.requests.matched,
  W.dashboards.invitation,
  W.dashboards.interest,
  W.dashboards.proposalRequested,
  W.dashboards.awaitingKickoff,
  W.dashboards.migration,
  W.dashboards.referrals,
  W.dashboards.exploratory,
  W.dashboards.approval,
  W.dashboards.waitingOnBalo,
  W.agency.routingRequest,
  W.agency.migrationRequest,
  W.agency.dashboardsRequest,
  W.agency.cpqRequest,
  W.agency.portalRequest,
  W.agency.flowAuditRequest,
  W.agency.journeyRequest,
  W.agency.fieldServiceRequest,
  W.agency.intakeRequest,
];

const WORLD_RELATIONSHIP_IDS = [
  W.fixed.relationship,
  W.tm.relationship,
  W.requests.directRelationship,
  W.requests.draftedRelationship,
  W.requests.fixedRelationship,
  W.requests.tmRelationship,
  W.requests.reviseRelationship,
  W.requests.matchedPriya,
  W.requests.matchedMarcus,
  W.requests.matchedAisha,
  W.dashboards.invitationRelationship,
  W.dashboards.interestRelationship,
  W.dashboards.proposalRequestedRelationship,
  W.dashboards.awaitingKickoffRelationship,
  W.dashboards.migrationRelationship,
  W.dashboards.referralsRelationship,
  W.dashboards.approvalRelationship,
];

const TEAMMATE_USER_IDS = [P.marcusUser, P.aishaUser, P.tomUser, P.lenaUser];
const TEAMMATE_PROFILE_IDS = [P.marcusProfile, P.aishaProfile, P.tomProfile, P.lenaProfile];
const WORLD_COMPANY_IDS = [P.kestrel, P.brightwater, P.larkspur];
const WORLD_AGENCY_IDS = [P.cloudPeak, P.summitRidge];
const AGENCY_NOTIFICATION_IDS = [
  W.agency.notificationChanges,
  W.agency.notificationEstimate,
  W.agency.notificationCancelled,
];

/**
 * Removes every row any world state inserted, plus the threads and conversations the app may
 * have created against the world's relationships and engagements while a page rendered. FK-safe
 * order; every delete is by fixed id or by a world-owned parent key.
 */
export async function deleteHelpWorld(db: HelpExecutor): Promise<void> {
  // The admin-alert sweep can raise alerts on world rows (a stale sent change order or an
  // over-estimate milestone is keyed by its engagement). `entity_id` has no FK, so they would
  // outlive the rows they name.
  await db
    .delete(adminAlerts)
    .where(
      inArray(adminAlerts.entityId, [
        ...WORLD_ENGAGEMENT_IDS,
        ...WORLD_COMPANY_IDS,
        ...TEAMMATE_PROFILE_IDS,
      ])
    );
  await db.delete(userNotifications).where(inArray(userNotifications.id, AGENCY_NOTIFICATION_IDS));
  await db.delete(auditEvents).where(eq(auditEvents.id, W.fixed.contentEditAudit));
  await db
    .delete(actionItems)
    .where(inArray(actionItems.id, [W.dashboards.actionItemOverdue, W.dashboards.actionItemOpen]));
  await db
    .delete(conversationMessages)
    .where(eq(conversationMessages.id, W.dashboards.caseMessage));
  await db
    .delete(conversationFiles)
    .where(inArray(conversationFiles.id, Object.values(W.caseFiles)));

  const subjectIds = [...WORLD_RELATIONSHIP_IDS, ...WORLD_ENGAGEMENT_IDS];
  const appThreads = await db
    .select({ conversationId: conversationContexts.conversationId })
    .from(conversationContexts)
    .where(inArray(conversationContexts.contextId, subjectIds));
  const threadIds = [
    ...WORLD_RELATIONSHIP_IDS.map((id) => helpThreadIds(id).conversation),
    ...appThreads.map((row) => row.conversationId),
  ];
  // Conversations cascade to their contexts, messages, files and read states.
  await db.delete(conversations).where(inArray(conversations.id, threadIds));

  // Engagements cascade to project rows, milestones, change orders, time entries and rounds;
  // requests to relationships, EOIs, proposals, generations, files and grants.
  await db.delete(engagements).where(inArray(engagements.id, WORLD_ENGAGEMENT_IDS));
  await db.delete(projectRequests).where(inArray(projectRequests.id, WORLD_REQUEST_IDS));

  await db
    .update(expertProfiles)
    .set({ agencyId: null })
    .where(eq(expertProfiles.id, HELP_IDS.expertProfile));
  await db.delete(agencyMembers).where(inArray(agencyMembers.agencyId, WORLD_AGENCY_IDS));
  await db.delete(agencyMembers).where(inArray(agencyMembers.userId, TEAMMATE_USER_IDS));
  await db.delete(expertProfiles).where(inArray(expertProfiles.id, TEAMMATE_PROFILE_IDS));
  await db.delete(agencies).where(inArray(agencies.id, WORLD_AGENCY_IDS));
  await db.delete(users).where(inArray(users.id, TEAMMATE_USER_IDS));
  await db.delete(companies).where(inArray(companies.id, WORLD_COMPANY_IDS));
}

// ── Shared row builders ───────────────────────────────────────────────────

interface Teammate {
  userId: string;
  profileId: string;
  first: string;
  last: string;
  username: string;
  headline: string;
  rateCents: number;
}

const TEAMMATES = {
  marcus: {
    userId: P.marcusUser,
    profileId: P.marcusProfile,
    first: 'Marcus',
    last: 'Chen',
    username: 'marcus-chen',
    headline: 'Service Cloud consultant for routing, queues and omni-channel',
    rateCents: 280,
  },
  aisha: {
    userId: P.aishaUser,
    profileId: P.aishaProfile,
    first: 'Aisha',
    last: 'Okafor',
    username: 'aisha-okafor',
    headline: 'Data migration and automation specialist',
    rateCents: 260,
  },
  tom: {
    userId: P.tomUser,
    profileId: P.tomProfile,
    first: 'Tom',
    last: 'Becker',
    username: 'tom-becker',
    headline: 'CPQ and revenue cloud consultant',
    rateCents: 250,
  },
  lena: {
    userId: P.lenaUser,
    profileId: P.lenaProfile,
    first: 'Lena',
    last: 'Fischer',
    username: 'lena-fischer',
    headline: 'Field Service and Health Cloud architect',
    rateCents: 300,
  },
} as const satisfies Record<string, Teammate>;

/**
 * Plain approved experts that are never listed (`searchable` false), so no marketplace page in
 * any guide shows them. `agencyId` links them to an agency for the agency states.
 */
async function insertTeammates(
  db: HelpExecutor,
  ctx: HelpWorldContext,
  members: ReadonlyArray<{ teammate: Teammate; agencyId: string | null }>
): Promise<void> {
  await db.insert(users).values(
    members.map(({ teammate }) => ({
      id: teammate.userId,
      workosId: `help_fixture_${teammate.username}`,
      email: `${teammate.username}@balo.test`,
      firstName: teammate.first,
      lastName: teammate.last,
      emailVerified: true,
      onboardingCompleted: true,
      activeMode: 'expert' as const,
    }))
  );
  await db.insert(expertProfiles).values(
    members.map(({ teammate, agencyId }) => ({
      id: teammate.profileId,
      userId: teammate.userId,
      verticalId: ctx.salesforceId,
      type: agencyId === null ? ('freelancer' as const) : ('agency' as const),
      agencyId,
      username: teammate.username,
      headline: teammate.headline,
      rateCents: teammate.rateCents,
      availableForWork: true,
      searchable: false,
      applicationStatus: 'approved' as const,
      submittedAt: FIXED_DECISION_TIME,
      decidedAt: FIXED_DECISION_TIME,
      approvedAt: FIXED_DECISION_TIME,
      liveCelebrationSeenAt: FIXED_DECISION_TIME,
      timezone: 'UTC',
    }))
  );
}

const COMPANY_NAMES: Record<string, string> = {
  [P.kestrel]: 'Kestrel Logistics',
  [P.brightwater]: 'Brightwater Foods',
  [P.larkspur]: 'Larkspur Health',
};

async function insertCompanies(db: HelpExecutor, ids: readonly string[]): Promise<void> {
  await db
    .insert(companies)
    .values(ids.map((id) => ({ id, name: COMPANY_NAMES[id] ?? 'Client', isPersonal: false })));
}

interface RequestSpec {
  id: string;
  companyId: string;
  expertProfileId: string | null;
  status: (typeof projectRequests.$inferInsert)['status'];
  title: string;
  description: string;
  timeline?: string;
  createdAt: Date;
  updatedAt?: Date;
}

async function insertRequest(
  db: HelpExecutor,
  ctx: HelpWorldContext,
  spec: RequestSpec
): Promise<void> {
  await db.insert(projectRequests).values({
    id: spec.id,
    companyId: spec.companyId,
    expertProfileId: spec.expertProfileId,
    createdByUserId: ctx.danaId,
    sendTo: spec.expertProfileId === null ? 'match' : 'direct',
    status: spec.status,
    source: 'manual',
    title: spec.title,
    description: spec.description,
    timeline: spec.timeline ?? null,
    createdAt: spec.createdAt,
    updatedAt: spec.updatedAt ?? spec.createdAt,
  });
}

interface RelationshipSpec {
  id: string;
  requestId: string;
  expertProfileId: string;
  status: (typeof requestExpertRelationships.$inferInsert)['status'];
  invitedAt: Date;
  openedAt?: Date;
  proposalRequestedAt?: Date;
  updatedAt?: Date;
  /** The EOI that opened the track; omitted for an `invited` relationship. */
  eoi?: { id: string; message: string; submittedAt: Date };
}

/**
 * A relationship plus the thread it is born with (`requestExpertRelationshipsRepository.invite`)
 * and, once the track is open, its expression of interest.
 */
async function insertRelationship(
  db: HelpExecutor,
  ctx: HelpWorldContext,
  spec: RelationshipSpec
): Promise<void> {
  const opened = spec.status === 'invited' ? null : (spec.openedAt ?? spec.invitedAt);
  await db.insert(requestExpertRelationships).values({
    id: spec.id,
    projectRequestId: spec.requestId,
    expertProfileId: spec.expertProfileId,
    invitedByUserId: ctx.danaId,
    invitedAt: spec.invitedAt,
    status: spec.status,
    openedAt: opened,
    proposalRequestedAt: spec.proposalRequestedAt ?? null,
    createdAt: spec.invitedAt,
    updatedAt: spec.updatedAt ?? opened ?? spec.invitedAt,
  });
  const thread = helpThreadIds(spec.id);
  await db
    .insert(conversations)
    .values({ id: thread.conversation, createdAt: spec.invitedAt, updatedAt: spec.invitedAt });
  await db.insert(conversationContexts).values({
    id: thread.context,
    conversationId: thread.conversation,
    contextType: 'relationship',
    contextId: spec.id,
    createdAt: spec.invitedAt,
    updatedAt: spec.invitedAt,
  });
  if (spec.eoi !== undefined) {
    await db.insert(expressionsOfInterest).values({
      id: spec.eoi.id,
      relationshipId: spec.id,
      projectRequestId: spec.requestId,
      expertProfileId: spec.expertProfileId,
      message: spec.eoi.message,
      submittedAt: spec.eoi.submittedAt,
      createdAt: spec.eoi.submittedAt,
      updatedAt: spec.eoi.submittedAt,
    });
  }
}

interface MilestoneSpec {
  id: string;
  title: string;
  status: 'pending' | 'in_progress' | 'completed';
  startedAt?: Date;
  completedAt?: Date;
  descriptionHtml?: string;
  acceptanceCriteria?: string;
  valueCents?: number;
  estimatedMinutes?: number;
  sourceProposalMilestoneId?: string;
  contentEditedAt?: Date;
}

/** Milestones in the given order; `actorId` started and completed each dated one. */
async function insertMilestones(
  db: HelpExecutor,
  engagementId: string,
  actorId: string,
  specs: readonly MilestoneSpec[]
): Promise<void> {
  await db.insert(engagementMilestones).values(
    specs.map((spec, sortOrder) => ({
      id: spec.id,
      engagementId,
      sourceProposalMilestoneId: spec.sourceProposalMilestoneId ?? null,
      sortOrder,
      title: spec.title,
      descriptionHtml: spec.descriptionHtml ?? null,
      acceptanceCriteria: spec.acceptanceCriteria ?? null,
      valueCents: spec.valueCents ?? null,
      estimatedMinutes: spec.estimatedMinutes ?? null,
      contentEditedAt: spec.contentEditedAt ?? null,
      status: spec.status,
      startedByUserId: spec.startedAt === undefined ? null : actorId,
      startedAt: spec.startedAt ?? null,
      completedByUserId: spec.completedAt === undefined ? null : actorId,
      completedAt: spec.completedAt ?? null,
    }))
  );
}

type ProjectRow = Omit<typeof projectEngagements.$inferInsert, 'engagementId' | 'engagementType'>;

/** Engagement supertype + project child, as `projectEngagementsRepository` creates them. */
async function insertProjectEngagement(
  db: HelpExecutor,
  input: {
    id: string;
    companyId: string;
    expertProfileId: string;
    activatedAt: Date;
    status?: 'active' | 'completed' | 'cancelled';
    project: ProjectRow;
  }
): Promise<void> {
  await db.insert(engagements).values({
    id: input.id,
    engagementType: 'project',
    companyId: input.companyId,
    expertProfileId: input.expertProfileId,
    status: input.status ?? 'active',
    currency: 'aud',
    baloFeeBps: BALO_FEE_BPS,
    activatedAt: input.activatedAt,
    createdAt: input.activatedAt,
  });
  await db.insert(projectEngagements).values({
    engagementId: input.id,
    createdAt: input.activatedAt,
    ...input.project,
  });
}

// ── Fixed-price project (Sales Cloud rollout) ─────────────────────────────

/** How the fixed-price project looks in each state that carries it. */
export type FixedProjectShape = 'normal' | 'sent' | 'round' | 'changes-made';

const FX = W.fixed;
const FIXED_PRICE_CENTS = 1_000_000;
const FIXED_VALUES = [300_000, 450_000, 250_000] as const;
const BUILD_DESCRIPTION =
  '<p>Opportunity stages, lead assignment and the sales dashboards, built in a sandbox.</p>';
const MIGRATION_CRITERIA =
  'All account, contact and opportunity records imported and spot-checked with Northwind.';

const FIXED_PROPOSAL_MILESTONES = [
  {
    id: FX.proposalMilestone1,
    title: 'Discovery and design',
    descriptionHtml: '<p>Workshops with the sales team and a signed-off solution design.</p>',
    acceptanceCriteria: 'Solution design signed off by Northwind.',
  },
  {
    id: FX.proposalMilestone2,
    title: 'Build and configure',
    descriptionHtml: BUILD_DESCRIPTION,
    acceptanceCriteria: 'Configuration demoed to the sales leads in the sandbox.',
  },
  {
    id: FX.proposalMilestone3,
    title: 'Data migration',
    descriptionHtml: '<p>Move accounts, contacts and open opportunities from the old CRM.</p>',
    acceptanceCriteria: 'All account and contact records imported.',
  },
] as const;

async function insertFixedOrigin(db: HelpExecutor, ctx: HelpWorldContext): Promise<void> {
  await insertRequest(db, ctx, {
    id: FX.request,
    companyId: HELP_IDS.company,
    expertProfileId: HELP_IDS.expertProfile,
    status: 'kickoff_approved',
    title: 'Sales Cloud rollout',
    description:
      '<p>We are moving the sales team off spreadsheets and onto Sales Cloud, with lead assignment and dashboards for the sales leads.</p>',
    timeline: 'Within the next three months',
    createdAt: atAnchor(ctx, -49, 10),
  });
  await insertRelationship(db, ctx, {
    id: FX.relationship,
    requestId: FX.request,
    expertProfileId: HELP_IDS.expertProfile,
    status: 'accepted',
    invitedAt: atAnchor(ctx, -49, 10),
    proposalRequestedAt: atAnchor(ctx, -47, 10),
    updatedAt: atAnchor(ctx, -42, 10),
    eoi: { id: FX.eoi, message: DIRECT_REQUEST_EOI_MESSAGE, submittedAt: atAnchor(ctx, -49, 10) },
  });
  await db.insert(proposals).values({
    id: FX.proposal,
    relationshipId: FX.relationship,
    projectRequestId: FX.request,
    expertProfileId: HELP_IDS.expertProfile,
    status: 'accepted',
    pricingMethod: 'fixed',
    overview:
      '<p>A staged Sales Cloud rollout: design with your sales leads, build in a sandbox, then move your data across.</p>',
    timeframeWeeks: 8,
    priceCents: FIXED_PRICE_CENTS,
    submittedAt: atAnchor(ctx, -45, 10),
    acceptedAt: atAnchor(ctx, -42, 10),
    acceptedByUserId: ctx.danaId,
  });
  await db.insert(proposalMilestones).values(
    FIXED_PROPOSAL_MILESTONES.map((milestone, sortOrder) => ({
      ...milestone,
      proposalId: FX.proposal,
      sortOrder,
      valueCents: FIXED_VALUES[sortOrder],
    }))
  );
  await db.insert(proposalPaymentInstallments).values([
    { id: FX.installment1, proposalId: FX.proposal, sortOrder: 0, label: 'Upfront', pct: 50 },
    { id: FX.installment2, proposalId: FX.proposal, sortOrder: 1, label: 'On delivery', pct: 50 },
  ]);
}

function fixedMilestones(ctx: HelpWorldContext, shape: FixedProjectShape): MilestoneSpec[] {
  const [design, build, migration] = FIXED_PROPOSAL_MILESTONES;
  const inRound = shape === 'round' || shape === 'changes-made';
  return [
    {
      ...design,
      id: FX.milestone1,
      sourceProposalMilestoneId: design.id,
      valueCents: FIXED_VALUES[0],
      status: 'completed',
      startedAt: atAnchor(ctx, -35, 10),
      completedAt: atAnchor(ctx, -28, 15),
    },
    {
      ...build,
      id: FX.milestone2,
      sourceProposalMilestoneId: build.id,
      valueCents: FIXED_VALUES[1],
      status: shape === 'changes-made' ? 'completed' : 'in_progress',
      startedAt: atAnchor(ctx, -27, 10),
      ...(shape === 'changes-made' ? { completedAt: atAnchor(ctx, -8, 15) } : {}),
    },
    {
      ...migration,
      id: FX.milestone3,
      sourceProposalMilestoneId: migration.id,
      valueCents: FIXED_VALUES[2],
      acceptanceCriteria: MIGRATION_CRITERIA,
      // In the review round every milestone had been delivered; otherwise it has not started.
      ...(inRound
        ? {
            status: 'completed' as const,
            startedAt: atAnchor(ctx, -20, 10),
            completedAt: atAnchor(ctx, -12, 15),
          }
        : { status: 'pending' as const, contentEditedAt: atAnchor(ctx, -20, 11) }),
    },
  ];
}

/** Priya's direct edit of the data migration's "done when", as `editDescriptive` audits it. */
async function insertContentEdit(db: HelpExecutor, ctx: HelpWorldContext): Promise<void> {
  const [, , migration] = FIXED_PROPOSAL_MILESTONES;
  await db.insert(auditEvents).values({
    id: FX.contentEditAudit,
    actorUserId: ctx.priyaId,
    action: 'engagement_milestone.edited',
    entityType: 'engagement_milestone',
    entityId: FX.milestone3,
    metadata: {
      fields: ['acceptanceCriteria'],
      before: { acceptanceCriteria: migration.acceptanceCriteria },
      engagementId: FX.engagement,
    },
    createdAt: atAnchor(ctx, -20, 11),
  });
}

/** A request Priya answered without a change order: declined, never sent. */
async function insertAnsweredOrder(db: HelpExecutor, ctx: HelpWorldContext): Promise<void> {
  await db.insert(engagementChangeOrders).values({
    id: FX.answeredOrder,
    engagementId: FX.engagement,
    status: 'declined',
    requestNote: 'Can the rollout also cover the new Pacific sales territory?',
    requestedByUserId: ctx.danaId,
    requestedAt: atAnchor(ctx, -22, 10),
    createdByUserId: ctx.danaId,
    decidedByUserId: ctx.priyaId,
    decidedAt: atAnchor(ctx, -21, 11),
    declineReason:
      'The Pacific territory is already part of the Build and configure milestone, so nothing needs to change.',
    createdAt: atAnchor(ctx, -22, 10),
  });
}

/** A sent change: one milestone added, one edited, one removed, A$1,000 more for Priya. */
async function insertFixedSentOrder(db: HelpExecutor, ctx: HelpWorldContext): Promise<void> {
  const [, build, migration] = FIXED_PROPOSAL_MILESTONES;
  await db.insert(engagementChangeOrders).values({
    id: FX.sentOrder,
    engagementId: FX.engagement,
    status: 'sent',
    requestNote: 'Could we add a regional forecast dashboard for the sales managers?',
    note: "Adds a regional forecast dashboard to the build. Northwind's team will move the old CRM data themselves, so the data migration milestone comes out.",
    priceDeltaCents: 100_000,
    requestedByUserId: ctx.danaId,
    requestedAt: atAnchor(ctx, -12, 10),
    createdByUserId: ctx.danaId,
    sentByUserId: ctx.priyaId,
    sentAt: atAnchor(ctx, -10, 14),
    createdAt: atAnchor(ctx, -12, 10),
  });
  await db.insert(engagementChangeOrderLines).values([
    {
      id: FX.sentLineAdd,
      changeOrderId: FX.sentOrder,
      op: 'add',
      title: 'Regional forecast dashboard',
      descriptionHtml: '<p>A forecast view by region and quarter for the sales managers.</p>',
      valueCents: 350_000,
      sortOrder: 0,
    },
    {
      id: FX.sentLineEdit,
      changeOrderId: FX.sentOrder,
      op: 'edit',
      engagementMilestoneId: FX.milestone2,
      title: build.title,
      descriptionHtml:
        '<p>Opportunity stages, lead assignment and the sales dashboards, plus the regional forecast view, built in a sandbox.</p>',
      beforeTitle: build.title,
      beforeDescriptionHtml: build.descriptionHtml,
      sortOrder: 1,
    },
    {
      id: FX.sentLineRemove,
      changeOrderId: FX.sentOrder,
      op: 'remove',
      engagementMilestoneId: FX.milestone3,
      title: migration.title,
      beforeTitle: migration.title,
      beforeDescriptionHtml: migration.descriptionHtml,
      sortOrder: 2,
    },
  ]);
}

const ROUND_NOTE =
  'The lead assignment rules send West Coast leads to the wrong team. Could you split them by state as well as by region?';

/** One review round reopening Build and configure, as `requestChanges` leaves it. */
async function insertReviewRound(db: HelpExecutor, ctx: HelpWorldContext): Promise<void> {
  const requestedAt = atAnchor(ctx, -9, 10);
  await db.insert(projectChangeRequests).values({
    id: FX.round,
    engagementId: FX.engagement,
    note: ROUND_NOTE,
    requestedByUserId: ctx.danaId,
    requestedAt,
    createdAt: requestedAt,
  });
  await db.insert(projectChangeRequestMilestones).values({
    id: FX.roundTag,
    changeRequestId: FX.round,
    engagementMilestoneId: FX.milestone2,
    createdAt: requestedAt,
  });
}

async function seedFixedProject(
  db: HelpExecutor,
  ctx: HelpWorldContext,
  shape: FixedProjectShape
): Promise<void> {
  const inRound = shape === 'round' || shape === 'changes-made';
  await insertFixedOrigin(db, ctx);
  await insertProjectEngagement(db, {
    id: FX.engagement,
    companyId: HELP_IDS.company,
    expertProfileId: HELP_IDS.expertProfile,
    activatedAt: atAnchor(ctx, -35, 9),
    project: {
      deliveryStatus: 'active',
      pricingMethod: 'fixed',
      priceCents: FIXED_PRICE_CENTS,
      sourceProposalId: FX.proposal,
      relationshipId: FX.relationship,
      projectRequestId: FX.request,
      ...(inRound
        ? {
            changeRequestNote: ROUND_NOTE,
            changeRequestedByUserId: ctx.danaId,
            changeRequestedAt: atAnchor(ctx, -9, 10),
          }
        : {}),
    },
  });
  await insertMilestones(db, FX.engagement, ctx.priyaId, fixedMilestones(ctx, shape));
  if (inRound) {
    await insertReviewRound(db, ctx);
    return;
  }
  await insertContentEdit(db, ctx);
  await insertAnsweredOrder(db, ctx);
  if (shape === 'sent') {
    await insertFixedSentOrder(db, ctx);
  }
}

// ── Time & materials project (Service Cloud case routing) ─────────────────

/** Which change order the T&M project carries. */
export type TmOrderState = 'none' | 'requested' | 'draft' | 'sent' | 'approved';

const TM = W.tm;
const TM_RATE_CENTS = 18_000;
const TM_CAP_CENTS = 720_000;
const ROUTING_TITLE = 'Case routing rules';
const ROUTING_DESCRIPTION =
  '<p>Route each new case to the right queue by product, region and priority.</p>';
const ROUTING_DESCRIPTION_EDITED =
  '<p>Route each new case, including web chat, to the right queue by product, region and priority.</p>';
const ROUTING_MINUTES = 960;
const ROUTING_MINUTES_EDITED = 1440;
const DASHBOARD_TITLE = 'Routing dashboard';
const DASHBOARD_DESCRIPTION = '<p>A dashboard showing where each case was routed and why.</p>';
const DASHBOARD_MINUTES = 720;

const TIME_ENTRIES = [
  {
    id: TM.entry1,
    milestone: TM.milestone1,
    day: -27,
    minutes: 240,
    note: 'Mapped the current case fields and record types',
  },
  {
    id: TM.entry2,
    milestone: TM.milestone1,
    day: -24,
    minutes: 240,
    note: 'Workshop with the support leads on routing rules',
  },
  {
    id: TM.entry3,
    milestone: TM.milestone1,
    day: -20,
    minutes: 240,
    note: 'Documented the data model and the sign-off notes',
  },
  {
    id: TM.entry4,
    milestone: TM.milestone2,
    day: -14,
    minutes: 240,
    note: 'Mapped the current routing into the new rules',
  },
  {
    id: TM.entry5,
    milestone: TM.milestone2,
    day: -12,
    minutes: 240,
    note: 'Configured queues and routing for the three regions',
  },
  {
    id: TM.entry6,
    milestone: TM.milestone2,
    day: -11,
    minutes: 180,
    note: 'Tested assignment rules with the support leads',
  },
  {
    id: TM.entry7,
    milestone: TM.milestone2,
    day: -10,
    minutes: 240,
    note: 'Built the escalation rules for priority cases',
  },
] as const;

async function insertTmOrigin(db: HelpExecutor, ctx: HelpWorldContext): Promise<void> {
  await insertRequest(db, ctx, {
    id: TM.request,
    companyId: HELP_IDS.company,
    expertProfileId: HELP_IDS.expertProfile,
    status: 'kickoff_approved',
    title: 'Service Cloud case routing',
    description:
      '<p>Support cases land in one shared queue. We want them routed by product, region and priority, with an agent console that shows the right details.</p>',
    timeline: 'Within the next two months',
    createdAt: atAnchor(ctx, -40, 10),
  });
  await insertRelationship(db, ctx, {
    id: TM.relationship,
    requestId: TM.request,
    expertProfileId: HELP_IDS.expertProfile,
    status: 'accepted',
    invitedAt: atAnchor(ctx, -40, 10),
    proposalRequestedAt: atAnchor(ctx, -38, 10),
    updatedAt: atAnchor(ctx, -30, 10),
    eoi: { id: TM.eoi, message: DIRECT_REQUEST_EOI_MESSAGE, submittedAt: atAnchor(ctx, -40, 10) },
  });
}

function tmMilestones(ctx: HelpWorldContext, approved: boolean): MilestoneSpec[] {
  return [
    {
      id: TM.milestone1,
      title: 'Discovery and data model',
      status: 'completed',
      estimatedMinutes: 600,
      startedAt: atAnchor(ctx, -28, 9),
      completedAt: atAnchor(ctx, -17, 16),
    },
    {
      id: TM.milestone2,
      title: ROUTING_TITLE,
      status: 'in_progress',
      descriptionHtml: approved ? ROUTING_DESCRIPTION_EDITED : ROUTING_DESCRIPTION,
      estimatedMinutes: approved ? ROUTING_MINUTES_EDITED : ROUTING_MINUTES,
      startedAt: atAnchor(ctx, -14, 9),
    },
    { id: TM.milestone3, title: 'Agent console setup', status: 'pending', estimatedMinutes: 720 },
  ];
}

/** The open (or decided) change order on the T&M project, stamped for its status. */
async function insertTmOrder(
  db: HelpExecutor,
  ctx: HelpWorldContext,
  state: Exclude<TmOrderState, 'none'>
): Promise<void> {
  const sent = state === 'sent' || state === 'approved';
  await db.insert(engagementChangeOrders).values({
    id: TM.changeOrder,
    engagementId: TM.engagement,
    status: state,
    requestNote: 'Could the routing also cover cases that come in from the web chat?',
    note:
      state === 'requested'
        ? null
        : 'Extends case routing to the web chat and adds a routing dashboard so your team can see where each case went.',
    priceDeltaCents: sent ? 324_000 : null,
    requestedByUserId: ctx.danaId,
    requestedAt: atAnchor(ctx, -9, 15),
    createdByUserId: ctx.danaId,
    sentByUserId: sent ? ctx.priyaId : null,
    sentAt: sent ? atAnchor(ctx, -8, 10) : null,
    decidedByUserId: state === 'approved' ? ctx.danaId : null,
    decidedAt: state === 'approved' ? atAnchor(ctx, -8, 16) : null,
    createdAt: atAnchor(ctx, -9, 15),
  });
  if (state === 'requested') {
    return;
  }
  await db.insert(engagementChangeOrderLines).values([
    {
      id: TM.lineEdit,
      changeOrderId: TM.changeOrder,
      op: 'edit',
      engagementMilestoneId: TM.milestone2,
      title: ROUTING_TITLE,
      descriptionHtml: ROUTING_DESCRIPTION_EDITED,
      estimatedMinutes: ROUTING_MINUTES_EDITED,
      // `send` stamps the before values; a draft has none yet.
      ...(sent
        ? {
            beforeTitle: ROUTING_TITLE,
            beforeDescriptionHtml: ROUTING_DESCRIPTION,
            beforeEstimatedMinutes: ROUTING_MINUTES,
          }
        : {}),
      sortOrder: 0,
    },
    {
      id: TM.lineAdd,
      changeOrderId: TM.changeOrder,
      op: 'add',
      // `approve` inserts the milestone and backfills the line with its id.
      engagementMilestoneId: state === 'approved' ? TM.addedMilestone : null,
      title: DASHBOARD_TITLE,
      descriptionHtml: DASHBOARD_DESCRIPTION,
      estimatedMinutes: DASHBOARD_MINUTES,
      sortOrder: 1,
    },
  ]);
}

async function seedTmProject(
  db: HelpExecutor,
  ctx: HelpWorldContext,
  order: TmOrderState
): Promise<void> {
  const approved = order === 'approved';
  await insertTmOrigin(db, ctx);
  await insertProjectEngagement(db, {
    id: TM.engagement,
    companyId: HELP_IDS.company,
    expertProfileId: HELP_IDS.expertProfile,
    activatedAt: atAnchor(ctx, -28, 0),
    project: {
      deliveryStatus: 'active',
      pricingMethod: 'tm',
      priceCents: TM_CAP_CENTS,
      rateCents: TM_RATE_CENTS,
      cadence: 'fortnightly',
      relationshipId: TM.relationship,
      projectRequestId: TM.request,
    },
  });
  await insertMilestones(db, TM.engagement, ctx.priyaId, tmMilestones(ctx, approved));
  if (approved) {
    // What `approve` writes for the add line: a pending milestone after the last live one.
    await db.insert(engagementMilestones).values({
      id: TM.addedMilestone,
      engagementId: TM.engagement,
      sortOrder: 3,
      title: DASHBOARD_TITLE,
      descriptionHtml: DASHBOARD_DESCRIPTION,
      estimatedMinutes: DASHBOARD_MINUTES,
      status: 'pending',
      createdByUserId: ctx.priyaId,
      createdAt: atAnchor(ctx, -8, 16),
    });
  }
  await db.insert(engagementTimeEntries).values(
    TIME_ENTRIES.map((entry) => ({
      id: entry.id,
      engagementId: TM.engagement,
      engagementMilestoneId: entry.milestone,
      userId: ctx.priyaId,
      workedOn: anchorDay(ctx, entry.day),
      minutes: entry.minutes,
      note: entry.note,
      createdAt: atAnchor(ctx, entry.day, 17),
      updatedAt: atAnchor(ctx, entry.day, 17),
    }))
  );
  if (order !== 'none') {
    await insertTmOrder(db, ctx, order);
  }
}

/** The project states: both Northwind projects, with the state's change on one of them. */
export async function seedProjectsWorld(
  db: HelpExecutor,
  ctx: HelpWorldContext,
  fixedShape: FixedProjectShape,
  tmOrder: TmOrderState
): Promise<void> {
  await seedFixedProject(db, ctx, fixedShape);
  await seedTmProject(db, ctx, tmOrder);
}

// ── Requests and proposals ────────────────────────────────────────────────

const RQ = W.requests;

const DRAFT_OUTPUT = {
  overviewHtml:
    "<p>I'll set up CPQ so your sales team can build accurate quotes in minutes, with your discount rules and approvals built in.</p><p>We'll start by mapping how quotes are put together today, then configure products, pricing and templates, and finish with training for the sales team.</p>",
  milestones: [
    {
      title: 'Discovery and pricing review',
      descriptionHtml: '<p>Map the current quoting process, price books and discount rules.</p>',
      acceptanceCriteria: 'Pricing rules and approval steps agreed with Northwind.',
    },
    {
      title: 'CPQ configuration',
      descriptionHtml: '<p>Products, price rules, discount approvals and the quote template.</p>',
      acceptanceCriteria: 'Sales leads can build and send a test quote in the sandbox.',
    },
    {
      title: 'Training and go-live',
      descriptionHtml: '<p>Hands-on training for the sales team, then the move to production.</p>',
      acceptanceCriteria: 'CPQ live in production and the sales team trained.',
    },
  ],
};

interface DirectRequestSpec {
  id: string;
  relationshipId: string;
  eoiId: string;
  status: 'eoi_submitted' | 'proposal_requested' | 'proposal_submitted';
  title: string;
  description: string;
  day: number;
}

/** A Northwind request sent straight to Priya, with her track at the request's status. */
async function insertDirectRequest(
  db: HelpExecutor,
  ctx: HelpWorldContext,
  spec: DirectRequestSpec
): Promise<void> {
  const created = atAnchor(ctx, spec.day, 10);
  await insertRequest(db, ctx, {
    id: spec.id,
    companyId: HELP_IDS.company,
    expertProfileId: HELP_IDS.expertProfile,
    status: spec.status,
    title: spec.title,
    description: spec.description,
    timeline: 'Within the next two months',
    createdAt: created,
  });
  await insertRelationship(db, ctx, {
    id: spec.relationshipId,
    requestId: spec.id,
    expertProfileId: HELP_IDS.expertProfile,
    status: spec.status,
    invitedAt: created,
    proposalRequestedAt:
      spec.status === 'eoi_submitted' ? undefined : atAnchor(ctx, spec.day + 1, 9),
    eoi: { id: spec.eoiId, message: DIRECT_REQUEST_EOI_MESSAGE, submittedAt: created },
  });
}

async function insertDraftedRequest(db: HelpExecutor, ctx: HelpWorldContext): Promise<void> {
  await insertDirectRequest(db, ctx, {
    id: RQ.drafted,
    relationshipId: RQ.draftedRelationship,
    eoiId: RQ.draftedEoi,
    status: 'proposal_requested',
    title: 'CPQ rollout for the sales team',
    description:
      '<p>Our sales team builds quotes in spreadsheets, and discounts are approved over email. We would like CPQ set up so quotes come out right first time.</p><p>We have about 40 products across three price books, and the regional managers approve anything over 15% off.</p>',
    day: -12,
  });
  await db.insert(proposalDraftGenerations).values({
    id: RQ.draftedGeneration,
    relationshipId: RQ.draftedRelationship,
    requestedByUserId: ctx.priyaId,
    status: 'succeeded',
    output: DRAFT_OUTPUT,
    completedAt: atAnchor(ctx, -11, 9, 1),
    createdAt: atAnchor(ctx, -11, 9),
  });
}

async function insertFixedDraftRequest(db: HelpExecutor, ctx: HelpWorldContext): Promise<void> {
  await insertDirectRequest(db, ctx, {
    id: RQ.fixed,
    relationshipId: RQ.fixedRelationship,
    eoiId: RQ.fixedEoi,
    status: 'proposal_requested',
    title: 'Customer onboarding portal',
    description:
      '<p>New customers send their details by email. We want a simple portal where they can sign up, upload documents and track their onboarding.</p>',
    day: -11,
  });
  await db.insert(proposals).values({
    id: RQ.fixedProposal,
    relationshipId: RQ.fixedRelationship,
    projectRequestId: RQ.fixed,
    expertProfileId: HELP_IDS.expertProfile,
    status: 'draft',
    pricingMethod: 'fixed',
    overview:
      '<p>A self-service onboarding portal: customers sign up, upload their documents and see where their onboarding is up to.</p>',
    timeframeWeeks: 8,
    priceCents: 1_500_000,
    submittedAt: atAnchor(ctx, -10, 11),
  });
  await db.insert(proposalMilestones).values([
    {
      id: RQ.fixedMilestone1,
      proposalId: RQ.fixedProposal,
      sortOrder: 0,
      title: 'Portal design',
      descriptionHtml: '<p>Page flows and branding, agreed with your team.</p>',
      valueCents: 400_000,
    },
    {
      id: RQ.fixedMilestone2,
      proposalId: RQ.fixedProposal,
      sortOrder: 1,
      title: 'Build and document upload',
      descriptionHtml: '<p>Sign-up, document upload and the onboarding tracker.</p>',
      valueCents: 600_000,
    },
    {
      id: RQ.fixedMilestone3,
      proposalId: RQ.fixedProposal,
      sortOrder: 2,
      title: 'Testing and launch',
      descriptionHtml: '<p>User testing with five customers, then launch.</p>',
      valueCents: 350_000,
    },
  ]);
  await db.insert(proposalPaymentInstallments).values([
    {
      id: RQ.fixedInstallment1,
      proposalId: RQ.fixedProposal,
      sortOrder: 0,
      label: 'Upfront',
      pct: 30,
    },
    {
      id: RQ.fixedInstallment2,
      proposalId: RQ.fixedProposal,
      sortOrder: 1,
      label: 'Midway',
      pct: 40,
    },
    {
      id: RQ.fixedInstallment3,
      proposalId: RQ.fixedProposal,
      sortOrder: 2,
      label: 'On delivery',
      pct: 30,
    },
  ]);
}

async function insertTmDraftRequest(db: HelpExecutor, ctx: HelpWorldContext): Promise<void> {
  await insertDirectRequest(db, ctx, {
    id: RQ.tm,
    relationshipId: RQ.tmRelationship,
    eoiId: RQ.tmEoi,
    status: 'proposal_requested',
    title: 'Marketing Cloud journey support',
    description:
      '<p>We need hands-on help building and tuning our customer journeys over the next quarter, billed for the hours used.</p>',
    day: -11,
  });
  await db.insert(proposals).values({
    id: RQ.tmProposal,
    relationshipId: RQ.tmRelationship,
    projectRequestId: RQ.tm,
    expertProfileId: HELP_IDS.expertProfile,
    status: 'draft',
    pricingMethod: 'tm',
    overview:
      '<p>Ongoing help with your customer journeys: a welcome series first, then win-back and post-purchase journeys, tuned as results come in.</p>',
    timeframeWeeks: 12,
    priceCents: 1_500_000,
    rateCents: 20_000,
    depositCents: 300_000,
    cadence: 'fortnightly',
    submittedAt: atAnchor(ctx, -10, 11),
  });
  await db.insert(proposalMilestones).values([
    {
      id: RQ.tmMilestone1,
      proposalId: RQ.tmProposal,
      sortOrder: 0,
      title: 'Welcome journey',
      descriptionHtml: '<p>A three-email welcome series for new subscribers.</p>',
      estimatedMinutes: 1200,
    },
    {
      id: RQ.tmMilestone2,
      proposalId: RQ.tmProposal,
      sortOrder: 1,
      title: 'Win-back and post-purchase journeys',
      descriptionHtml: '<p>Two journeys, with the audiences and timing agreed with your team.</p>',
      estimatedMinutes: 2400,
    },
    {
      id: RQ.tmMilestone3,
      proposalId: RQ.tmProposal,
      sortOrder: 2,
      title: 'Reporting and tuning',
      descriptionHtml: '<p>A results dashboard and a round of tuning.</p>',
      estimatedMinutes: 900,
    },
  ]);
}

async function insertReviseRequest(db: HelpExecutor, ctx: HelpWorldContext): Promise<void> {
  await insertDirectRequest(db, ctx, {
    id: RQ.revise,
    relationshipId: RQ.reviseRelationship,
    eoiId: RQ.reviseEoi,
    status: 'proposal_submitted',
    title: 'Sales Cloud lead scoring',
    description:
      '<p>Our sales team chases every lead the same way. We want scoring rules that put the warmest leads at the top of the list.</p>',
    day: -13,
  });
  await db.insert(proposals).values({
    id: RQ.reviseProposal,
    relationshipId: RQ.reviseRelationship,
    projectRequestId: RQ.revise,
    expertProfileId: HELP_IDS.expertProfile,
    status: 'changes_requested',
    pricingMethod: 'fixed',
    overview:
      '<p>Lead scoring built from your won deals, with the scores shown on every lead and a weekly review of the rules.</p>',
    timeframeWeeks: 6,
    priceCents: 900_000,
    submittedAt: atAnchor(ctx, -10, 10),
  });
  await db.insert(proposalMilestones).values([
    {
      id: RQ.reviseMilestone1,
      proposalId: RQ.reviseProposal,
      sortOrder: 0,
      title: 'Scoring model',
      descriptionHtml: '<p>Scoring rules built from the last two years of won deals.</p>',
      valueCents: 450_000,
    },
    {
      id: RQ.reviseMilestone2,
      proposalId: RQ.reviseProposal,
      sortOrder: 1,
      title: 'Build and rollout',
      descriptionHtml: '<p>Scores on every lead, list views for the sales team and training.</p>',
      valueCents: 450_000,
    },
  ]);
  await db.insert(proposalPaymentInstallments).values([
    {
      id: RQ.reviseInstallment1,
      proposalId: RQ.reviseProposal,
      sortOrder: 0,
      label: 'Upfront',
      pct: 50,
    },
    {
      id: RQ.reviseInstallment2,
      proposalId: RQ.reviseProposal,
      sortOrder: 1,
      label: 'On delivery',
      pct: 50,
    },
  ]);
  await db.insert(proposalChangeRequests).values({
    id: RQ.reviseChangeRequest,
    proposalId: RQ.reviseProposal,
    requestedByUserId: ctx.danaId,
    section: 'general',
    note: 'Could we split the build into two phases so our team can start testing the scoring rules earlier?',
    proposalVersion: 1,
    createdAt: atAnchor(ctx, -9, 14),
  });
}

/**
 * A matched Northwind request with three open tracks (Priya, Marcus, Aisha), client files shared
 * three ways and two messages in Priya's thread only, so hers is always the default thread.
 */
async function insertMatchedRequest(db: HelpExecutor, ctx: HelpWorldContext): Promise<void> {
  await insertRequest(db, ctx, {
    id: RQ.matched,
    companyId: HELP_IDS.company,
    expertProfileId: null,
    status: 'eoi_submitted',
    title: 'Streamline our quote approvals',
    description:
      '<p>Quotes over our discount limit wait days for approval. We want a clear approval flow in Salesforce with the right people notified.</p>',
    timeline: 'Within the next two months',
    createdAt: atAnchor(ctx, -12, 10),
  });
  const tracks = [
    {
      id: RQ.matchedPriya,
      eoi: RQ.matchedPriyaEoi,
      profile: HELP_IDS.expertProfile,
      hour: 10,
      message:
        '<p>I have set up approval flows like this for two distributors. Happy to walk you through how it could work.</p>',
    },
    {
      id: RQ.matchedMarcus,
      eoi: RQ.matchedMarcusEoi,
      profile: P.marcusProfile,
      hour: 11,
      message:
        '<p>Approval routing is most of what I do. I would start with your discount bands and who signs off each one.</p>',
    },
    {
      id: RQ.matchedAisha,
      eoi: RQ.matchedAishaEoi,
      profile: P.aishaProfile,
      hour: 12,
      message: '<p>I can help with the flow and with cleaning up the quote data it relies on.</p>',
    },
  ];
  for (const track of tracks) {
    await insertRelationship(db, ctx, {
      id: track.id,
      requestId: RQ.matched,
      expertProfileId: track.profile,
      status: 'eoi_submitted',
      invitedAt: atAnchor(ctx, -11, track.hour),
      openedAt: atAnchor(ctx, -10, track.hour - 1),
      eoi: {
        id: track.eoi,
        message: track.message,
        submittedAt: atAnchor(ctx, -10, track.hour - 1),
      },
    });
  }

  // Created a few seconds before the frozen 09:00 browser clock: the server-rendered Files card
  // and the browser both print "just now", so hydration matches whatever day the run is.
  const files = [
    {
      id: RQ.fileOverview,
      name: 'Northwind-Salesforce-overview.pdf',
      type: 'application/pdf',
      size: 1_240_000,
      audience: 'all_live_tracks' as const,
      second: 10,
    },
    {
      id: RQ.fileMatrix,
      name: 'Quote-approval-matrix.xlsx',
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      size: 64_000,
      audience: 'grants' as const,
      second: 20,
    },
    {
      id: RQ.fileFlow,
      name: 'Current-approval-flow.png',
      type: 'image/png',
      size: 318_000,
      audience: 'grants' as const,
      second: 30,
    },
  ];
  await db.insert(requestSharedFiles).values([
    ...files.map((file) => ({
      id: file.id,
      projectRequestId: RQ.matched,
      uploadedByUserId: ctx.danaId,
      side: 'client' as const,
      audience: file.audience,
      r2Key: `help-fixture/request-files/${file.id}`,
      fileName: file.name,
      contentType: file.type,
      sizeBytes: file.size,
      createdAt: atAnchor(ctx, 0, 8, 59, file.second),
      updatedAt: atAnchor(ctx, 0, 8, 59, file.second),
    })),
    {
      id: RQ.fileQuestions,
      projectRequestId: RQ.matched,
      uploadedByUserId: ctx.priyaId,
      side: 'expert' as const,
      audience: 'own_track' as const,
      expertRelationshipId: RQ.matchedPriya,
      r2Key: `help-fixture/request-files/${RQ.fileQuestions}`,
      fileName: 'Discovery-questions.pdf',
      contentType: 'application/pdf',
      sizeBytes: 96_000,
      createdAt: atAnchor(ctx, 0, 8, 59, 40),
      updatedAt: atAnchor(ctx, 0, 8, 59, 40),
    },
  ]);
  await db.insert(requestFileGrants).values([
    {
      id: RQ.grantMatrixPriya,
      fileId: RQ.fileMatrix,
      relationshipId: RQ.matchedPriya,
      projectRequestId: RQ.matched,
      grantedByUserId: ctx.danaId,
    },
    {
      id: RQ.grantMatrixMarcus,
      fileId: RQ.fileMatrix,
      relationshipId: RQ.matchedMarcus,
      projectRequestId: RQ.matched,
      grantedByUserId: ctx.danaId,
    },
    {
      id: RQ.grantFlowPriya,
      fileId: RQ.fileFlow,
      relationshipId: RQ.matchedPriya,
      projectRequestId: RQ.matched,
      grantedByUserId: ctx.danaId,
    },
  ]);

  const priyaThread = helpThreadIds(RQ.matchedPriya).conversation;
  await db.insert(conversationMessages).values([
    {
      id: RQ.priyaMessage,
      conversationId: priyaThread,
      senderUserId: ctx.priyaId,
      body: '<p>Happy to help. Could you send a screenshot of how approvals run today?</p>',
      createdAt: atAnchor(ctx, -9, 10),
      updatedAt: atAnchor(ctx, -9, 10),
    },
    {
      id: RQ.danaShareMessage,
      conversationId: priyaThread,
      senderUserId: ctx.danaId,
      requestSharedFileId: RQ.fileFlow,
      body: '<p>Here is how approvals look today. The hold-up is step 3.</p>',
      createdAt: atAnchor(ctx, -9, 15),
      updatedAt: atAnchor(ctx, -9, 15),
    },
  ]);
}

/** Every Northwind request and proposal the request and proposal guides open. */
export async function seedRequestsWorld(db: HelpExecutor, ctx: HelpWorldContext): Promise<void> {
  await insertTeammates(db, ctx, [
    { teammate: TEAMMATES.marcus, agencyId: null },
    { teammate: TEAMMATES.aisha, agencyId: null },
  ]);
  await insertDirectRequest(db, ctx, {
    id: RQ.direct,
    relationshipId: RQ.directRelationship,
    eoiId: RQ.directEoi,
    status: 'eoi_submitted',
    title: 'Field Service scheduling setup',
    description:
      '<p>Our field technicians book jobs from a shared spreadsheet. We would like scheduling, dispatch and a mobile job checklist set up in Salesforce.</p>',
    day: -9,
  });
  await insertDraftedRequest(db, ctx);
  await insertFixedDraftRequest(db, ctx);
  await insertTmDraftRequest(db, ctx);
  await insertReviseRequest(db, ctx);
  await insertMatchedRequest(db, ctx);
}

// ── Dashboards (both Your move rails, both tracks) ────────────────────────

const DB_ = W.dashboards;

async function lookupTaxonomy(
  db: HelpExecutor,
  ctx: HelpWorldContext
): Promise<{ productIds: [string, string]; tagId: string }> {
  const rows = await db
    .select({ id: products.id, name: products.name })
    .from(products)
    .where(
      and(
        eq(products.verticalId, ctx.salesforceId),
        inArray(products.name, ['Service Cloud', 'Digital Engagement'])
      )
    );
  const [tag] = await db
    .select({ id: projectTags.id })
    .from(projectTags)
    .where(
      and(eq(projectTags.verticalId, ctx.salesforceId), eq(projectTags.name, 'Automation Setup'))
    );
  const productId = (name: string): string => {
    const row = rows.find((candidate) => candidate.name === name);
    if (row === undefined) {
      throw new Error(`Product "${name}" not found - run \`pnpm db:seed\` first`);
    }
    return row.id;
  };
  if (tag === undefined) {
    throw new Error('Project tag "Automation Setup" not found - run `pnpm db:seed` first');
  }
  return {
    productIds: [productId('Service Cloud'), productId('Digital Engagement')],
    tagId: tag.id,
  };
}

/** Priya's side: an invitation, interest sent, a proposal to write and an awaiting kickoff. */
async function insertExpertRequests(db: HelpExecutor, ctx: HelpWorldContext): Promise<void> {
  await insertRequest(db, ctx, {
    id: DB_.invitation,
    companyId: P.kestrel,
    expertProfileId: null,
    status: 'experts_invited',
    title: 'Warehouse case management',
    description:
      '<p>Our depots log customer issues by email. We want cases created automatically, routed to the right depot and tracked to resolution.</p><p>We already use Sales Cloud and would like this live before the peak season.</p>',
    timeline: 'Within the next two months',
    createdAt: hoursAgo(ctx, 80),
    updatedAt: hoursAgo(ctx, 72),
  });
  await insertRelationship(db, ctx, {
    id: DB_.invitationRelationship,
    requestId: DB_.invitation,
    expertProfileId: HELP_IDS.expertProfile,
    status: 'invited',
    invitedAt: hoursAgo(ctx, 72),
  });
  const { productIds, tagId } = await lookupTaxonomy(db, ctx);
  const [serviceCloud, digitalEngagement] = productIds;
  await db.insert(projectRequestProducts).values([
    { id: DB_.invitationProduct1, projectRequestId: DB_.invitation, productId: serviceCloud },
    { id: DB_.invitationProduct2, projectRequestId: DB_.invitation, productId: digitalEngagement },
  ]);
  await db
    .insert(projectRequestTags)
    .values({ id: DB_.invitationTag, projectRequestId: DB_.invitation, projectTagId: tagId });

  await insertRequest(db, ctx, {
    id: DB_.interest,
    companyId: P.larkspur,
    expertProfileId: null,
    status: 'eoi_submitted',
    title: 'Patient intake flow rebuild',
    description:
      '<p>Our intake forms feed three different systems. We want one intake flow in Salesforce that the front desk can run on a tablet.</p>',
    createdAt: hoursAgo(ctx, 6 * 24),
    updatedAt: hoursAgo(ctx, 50),
  });
  await insertRelationship(db, ctx, {
    id: DB_.interestRelationship,
    requestId: DB_.interest,
    expertProfileId: HELP_IDS.expertProfile,
    status: 'eoi_submitted',
    invitedAt: hoursAgo(ctx, 6 * 24),
    openedAt: hoursAgo(ctx, 50),
    eoi: {
      id: DB_.interestEoi,
      message:
        '<p>I rebuilt intake flows for two clinics last year and would be glad to help. Happy to talk through your current process first.</p>',
      submittedAt: hoursAgo(ctx, 50),
    },
  });

  await insertRequest(db, ctx, {
    id: DB_.proposalRequested,
    companyId: HELP_IDS.company,
    expertProfileId: null,
    status: 'proposal_requested',
    title: 'CPQ quote template cleanup',
    description:
      '<p>Our quote templates have drifted across regions. We want one clean template set with the right terms for each region.</p>',
    createdAt: hoursAgo(ctx, 13 * 24),
    updatedAt: hoursAgo(ctx, 24),
  });
  await insertRelationship(db, ctx, {
    id: DB_.proposalRequestedRelationship,
    requestId: DB_.proposalRequested,
    expertProfileId: HELP_IDS.expertProfile,
    status: 'proposal_requested',
    invitedAt: hoursAgo(ctx, 12 * 24),
    openedAt: hoursAgo(ctx, 11 * 24),
    proposalRequestedAt: hoursAgo(ctx, 24),
    updatedAt: hoursAgo(ctx, 24),
    eoi: {
      id: DB_.proposalRequestedEoi,
      message: '<p>I have cleaned up template sets like this before and can start next week.</p>',
      submittedAt: hoursAgo(ctx, 11 * 24),
    },
  });

  await insertRequest(db, ctx, {
    id: DB_.awaitingKickoff,
    companyId: P.brightwater,
    expertProfileId: null,
    status: 'accepted',
    title: 'Loyalty programme setup',
    description:
      '<p>We are launching a loyalty programme for our wholesale customers and need points, tiers and statements set up.</p>',
    createdAt: hoursAgo(ctx, 21 * 24),
    updatedAt: hoursAgo(ctx, 4 * 24),
  });
  await insertRelationship(db, ctx, {
    id: DB_.awaitingKickoffRelationship,
    requestId: DB_.awaitingKickoff,
    expertProfileId: HELP_IDS.expertProfile,
    status: 'accepted',
    invitedAt: hoursAgo(ctx, 20 * 24),
    openedAt: hoursAgo(ctx, 19 * 24),
    proposalRequestedAt: hoursAgo(ctx, 15 * 24),
    updatedAt: hoursAgo(ctx, 4 * 24),
    eoi: {
      id: DB_.awaitingKickoffEoi,
      message: '<p>Loyalty set-ups are a favourite of mine. Glad to help.</p>',
      submittedAt: hoursAgo(ctx, 19 * 24),
    },
  });
}

/** Two live deliveries: one in progress, one where the client asked for changes. */
async function insertExpertDeliveries(db: HelpExecutor, ctx: HelpWorldContext): Promise<void> {
  const deliveries = [
    {
      requestId: DB_.migration,
      relationshipId: DB_.migrationRelationship,
      eoiId: DB_.migrationEoi,
      engagementId: DB_.migrationEngagement,
      companyId: HELP_IDS.company,
      title: 'Sales Cloud data migration',
      activatedDays: 30,
    },
    {
      requestId: DB_.referrals,
      relationshipId: DB_.referralsRelationship,
      eoiId: DB_.referralsEoi,
      engagementId: DB_.referralsEngagement,
      companyId: P.larkspur,
      title: 'Referral dashboards rebuild',
      activatedDays: 40,
    },
  ];
  for (const delivery of deliveries) {
    const activated = hoursAgo(ctx, delivery.activatedDays * 24);
    await insertRequest(db, ctx, {
      id: delivery.requestId,
      companyId: delivery.companyId,
      expertProfileId: null,
      status: 'kickoff_approved',
      title: delivery.title,
      description: `<p>${delivery.title}, delivered in milestones.</p>`,
      createdAt: hoursAgo(ctx, (delivery.activatedDays + 14) * 24),
      updatedAt: activated,
    });
    await insertRelationship(db, ctx, {
      id: delivery.relationshipId,
      requestId: delivery.requestId,
      expertProfileId: HELP_IDS.expertProfile,
      status: 'accepted',
      invitedAt: hoursAgo(ctx, (delivery.activatedDays + 12) * 24),
      proposalRequestedAt: hoursAgo(ctx, (delivery.activatedDays + 8) * 24),
      updatedAt: activated,
      eoi: {
        id: delivery.eoiId,
        message: '<p>Glad to help with this one.</p>',
        submittedAt: hoursAgo(ctx, (delivery.activatedDays + 12) * 24),
      },
    });
  }

  await insertProjectEngagement(db, {
    id: DB_.migrationEngagement,
    companyId: HELP_IDS.company,
    expertProfileId: HELP_IDS.expertProfile,
    activatedAt: hoursAgo(ctx, 30 * 24),
    project: {
      deliveryStatus: 'active',
      pricingMethod: 'fixed',
      priceCents: 1_200_000,
      relationshipId: DB_.migrationRelationship,
      projectRequestId: DB_.migration,
    },
  });
  await insertMilestones(db, DB_.migrationEngagement, ctx.priyaId, [
    {
      id: DB_.migrationMilestone1,
      title: 'Data audit',
      status: 'completed',
      startedAt: hoursAgo(ctx, 30 * 24),
      completedAt: hoursAgo(ctx, 20 * 24),
      valueCents: 300_000,
    },
    {
      id: DB_.migrationMilestone2,
      title: 'Field mapping',
      status: 'completed',
      startedAt: hoursAgo(ctx, 19 * 24),
      completedAt: hoursAgo(ctx, 10 * 24),
      valueCents: 300_000,
    },
    {
      id: DB_.migrationMilestone3,
      title: 'Test load',
      status: 'in_progress',
      startedAt: hoursAgo(ctx, 5 * 24),
      valueCents: 300_000,
    },
    {
      id: DB_.migrationMilestone4,
      title: 'Production load',
      status: 'pending',
      valueCents: 300_000,
    },
  ]);

  await insertProjectEngagement(db, {
    id: DB_.referralsEngagement,
    companyId: P.larkspur,
    expertProfileId: HELP_IDS.expertProfile,
    activatedAt: hoursAgo(ctx, 40 * 24),
    project: {
      deliveryStatus: 'active',
      pricingMethod: 'fixed',
      priceCents: 900_000,
      relationshipId: DB_.referralsRelationship,
      projectRequestId: DB_.referrals,
      changeRequestNote:
        'The regional filter on the referrals dashboard still shows last quarter. Could you take another look before we accept?',
      changeRequestedByUserId: ctx.danaId,
      changeRequestedAt: hoursAgo(ctx, 24),
    },
  });
  await insertMilestones(db, DB_.referralsEngagement, ctx.priyaId, [
    {
      id: DB_.referralsMilestone1,
      title: 'Referral data model',
      status: 'completed',
      startedAt: hoursAgo(ctx, 40 * 24),
      completedAt: hoursAgo(ctx, 30 * 24),
      valueCents: 300_000,
    },
    {
      id: DB_.referralsMilestone2,
      title: 'Dashboards',
      status: 'completed',
      startedAt: hoursAgo(ctx, 29 * 24),
      completedAt: hoursAgo(ctx, 10 * 24),
      valueCents: 300_000,
    },
    {
      id: DB_.referralsMilestone3,
      title: 'Regional filters',
      status: 'completed',
      startedAt: hoursAgo(ctx, 9 * 24),
      completedAt: hoursAgo(ctx, 48),
      valueCents: 300_000,
    },
  ]);
}

/** Two action items for Priya and one unread message from Dana on the base case. */
async function insertCaseActivity(db: HelpExecutor, ctx: HelpWorldContext): Promise<void> {
  await db.insert(actionItems).values([
    {
      id: DB_.actionItemOverdue,
      engagementId: HELP_IDS.engagement,
      body: 'Send the updated flow diagram',
      source: 'manual',
      assigneeParty: 'expert',
      dueAt: hoursAgo(ctx, 24),
      createdByUserId: ctx.danaId,
      assignedByUserId: ctx.danaId,
      assignedAt: hoursAgo(ctx, 30),
      createdAt: hoursAgo(ctx, 30),
      updatedAt: hoursAgo(ctx, 30),
    },
    {
      id: DB_.actionItemOpen,
      engagementId: HELP_IDS.engagement,
      body: 'Share the debug log from the last failed run',
      source: 'manual',
      assigneeParty: 'expert',
      createdByUserId: ctx.danaId,
      assignedByUserId: ctx.danaId,
      assignedAt: hoursAgo(ctx, 26),
      createdAt: hoursAgo(ctx, 26),
      updatedAt: hoursAgo(ctx, 26),
    },
  ]);
  // A read cursor the app wrote on an earlier visit would hide the message; it is unread here.
  await db
    .delete(conversationReadStates)
    .where(
      and(
        eq(conversationReadStates.conversationId, HELP_IDS.conversation),
        eq(conversationReadStates.userId, ctx.priyaId)
      )
    );
  await db.insert(conversationMessages).values({
    id: DB_.caseMessage,
    conversationId: HELP_IDS.conversation,
    senderUserId: ctx.danaId,
    body: "<p>Thanks, Priya. The flow failed again overnight, so I've added the error details to the case.</p>",
    createdAt: hoursAgo(ctx, 2),
    updatedAt: hoursAgo(ctx, 2),
  });
}

/** Dana's side: a call to book, a proposal to review and a request waiting on Balo. */
async function insertClientRequests(db: HelpExecutor, ctx: HelpWorldContext): Promise<void> {
  await insertRequest(db, ctx, {
    id: DB_.waitingOnBalo,
    companyId: HELP_IDS.company,
    expertProfileId: null,
    status: 'requested',
    title: 'Marketing Cloud audit',
    description:
      '<p>We would like a review of our Marketing Cloud set-up before the new financial year.</p>',
    createdAt: hoursAgo(ctx, 2 * 24),
  });

  await insertRequest(db, ctx, {
    id: DB_.exploratory,
    companyId: HELP_IDS.company,
    expertProfileId: null,
    status: 'exploratory_meeting_requested',
    title: 'Customer portal refresh',
    description:
      '<p>Our customer portal is slow and hard to search. We would like a short call to work out what a refresh should cover.</p>',
    createdAt: hoursAgo(ctx, 3 * 24),
    updatedAt: hoursAgo(ctx, 24),
  });

  await insertRequest(db, ctx, {
    id: DB_.approval,
    companyId: HELP_IDS.company,
    expertProfileId: HELP_IDS.expertProfile,
    status: 'proposal_submitted',
    title: 'Quote approval workflow',
    description:
      '<p>Discounts over 15% are approved over email. We want approvals inside Salesforce, with a clear record of who approved what.</p>',
    timeline: 'Within the next two months',
    createdAt: hoursAgo(ctx, 10 * 24),
    updatedAt: hoursAgo(ctx, 3 * 24),
  });
  await insertRelationship(db, ctx, {
    id: DB_.approvalRelationship,
    requestId: DB_.approval,
    expertProfileId: HELP_IDS.expertProfile,
    status: 'proposal_submitted',
    invitedAt: hoursAgo(ctx, 10 * 24),
    proposalRequestedAt: hoursAgo(ctx, 7 * 24),
    updatedAt: hoursAgo(ctx, 3 * 24),
    eoi: {
      id: DB_.approvalEoi,
      message: DIRECT_REQUEST_EOI_MESSAGE,
      submittedAt: hoursAgo(ctx, 10 * 24),
    },
  });
  await db.insert(proposals).values({
    id: DB_.approvalProposal,
    relationshipId: DB_.approvalRelationship,
    projectRequestId: DB_.approval,
    expertProfileId: HELP_IDS.expertProfile,
    status: 'submitted',
    pricingMethod: 'fixed',
    overview:
      '<p>Discount approvals inside Salesforce: the right approver for each discount band, reminders, and a full approval history on every quote.</p>',
    timeframeWeeks: 6,
    priceCents: 900_000,
    submittedAt: hoursAgo(ctx, 3 * 24),
  });
  await db.insert(proposalMilestones).values([
    {
      id: DB_.approvalMilestone1,
      proposalId: DB_.approvalProposal,
      sortOrder: 0,
      title: 'Approval rules',
      descriptionHtml: '<p>Discount bands and approvers agreed with your sales leads.</p>',
      valueCents: 300_000,
    },
    {
      id: DB_.approvalMilestone2,
      proposalId: DB_.approvalProposal,
      sortOrder: 1,
      title: 'Approval flow build',
      descriptionHtml: '<p>The approval flow, reminders and notifications.</p>',
      valueCents: 300_000,
    },
    {
      id: DB_.approvalMilestone3,
      proposalId: DB_.approvalProposal,
      sortOrder: 2,
      title: 'Testing and training',
      descriptionHtml: '<p>Testing with the sales leads, then training.</p>',
      valueCents: 300_000,
    },
  ]);
  await db.insert(proposalPaymentInstallments).values([
    {
      id: DB_.approvalInstallment1,
      proposalId: DB_.approvalProposal,
      sortOrder: 0,
      label: 'Upfront',
      pct: 50,
    },
    {
      id: DB_.approvalInstallment2,
      proposalId: DB_.approvalProposal,
      sortOrder: 1,
      label: 'On delivery',
      pct: 50,
    },
  ]);
}

/**
 * Both dashboards' Your move rails and project tracks. Every fact the server words relatively
 * ("Invited 3 days ago") is real-now-relative; the offsets also set the card order (the
 * invitation, 72 hours old, stays the featured first card).
 */
export async function seedDashboardsWorld(db: HelpExecutor, ctx: HelpWorldContext): Promise<void> {
  await insertCompanies(db, [P.kestrel, P.brightwater, P.larkspur]);
  await insertExpertRequests(db, ctx);
  await insertExpertDeliveries(db, ctx);
  await insertCaseActivity(db, ctx);
  await insertClientRequests(db, ctx);
}

// ── Agencies ──────────────────────────────────────────────────────────────

const AG = W.agency;

interface AgencyProject {
  requestId: string;
  engagementId: string;
  title: string;
  companyId: string;
  deliverer: Teammate | 'priya';
  status: 'active' | 'pending_acceptance' | 'completed' | 'cancelled';
  pricingMethod: 'fixed' | 'tm';
  activatedDays: number;
  milestones: ReadonlyArray<{
    title: string;
    status: MilestoneSpec['status'];
    startedHours?: number;
    completedHours?: number;
    estimatedMinutes?: number;
  }>;
}

const CANCELLED_DAYS_BEFORE_ANCHOR = -8;

const CLOUDPEAK_PROJECTS: readonly AgencyProject[] = [
  {
    requestId: AG.routingRequest,
    engagementId: AG.routing,
    title: 'Service Cloud case routing rebuild',
    companyId: HELP_IDS.company,
    deliverer: TEAMMATES.marcus,
    status: 'active',
    pricingMethod: 'fixed',
    activatedDays: 40,
    milestones: [
      {
        title: 'Queue design',
        status: 'completed',
        startedHours: 40 * 24,
        completedHours: 30 * 24,
      },
      {
        title: 'Routing rules',
        status: 'completed',
        startedHours: 29 * 24,
        completedHours: 4 * 24,
      },
      { title: 'Escalations and handover', status: 'in_progress', startedHours: 20 },
    ],
  },
  {
    requestId: AG.migrationRequest,
    engagementId: AG.migration,
    title: 'Legacy CRM data migration',
    companyId: P.kestrel,
    deliverer: TEAMMATES.aisha,
    status: 'pending_acceptance',
    pricingMethod: 'tm',
    activatedDays: 35,
    milestones: [
      {
        title: 'Data mapping',
        status: 'completed',
        startedHours: 35 * 24,
        completedHours: 25 * 24,
        estimatedMinutes: 960,
      },
      {
        title: 'Data load dry run',
        status: 'completed',
        startedHours: 24 * 24,
        completedHours: 10 * 24,
        estimatedMinutes: 720,
      },
      {
        title: 'Production load',
        status: 'completed',
        startedHours: 9 * 24,
        completedHours: 26,
        estimatedMinutes: 960,
      },
    ],
  },
  {
    requestId: AG.dashboardsRequest,
    engagementId: AG.dashboards,
    title: 'Sales Cloud pipeline dashboards',
    companyId: P.brightwater,
    deliverer: 'priya',
    status: 'active',
    pricingMethod: 'fixed',
    activatedDays: 21,
    milestones: [
      {
        title: 'Dashboard design',
        status: 'completed',
        startedHours: 21 * 24,
        completedHours: 6 * 24,
      },
      { title: 'Pipeline dashboards', status: 'in_progress', startedHours: 2 * 24 },
      { title: 'Training', status: 'pending' },
    ],
  },
  {
    requestId: AG.cpqRequest,
    engagementId: AG.cpq,
    title: 'CPQ pricing rules cleanup',
    companyId: HELP_IDS.company,
    deliverer: TEAMMATES.tom,
    status: 'active',
    pricingMethod: 'fixed',
    activatedDays: 45,
    milestones: [
      {
        title: 'Pricing audit',
        status: 'completed',
        startedHours: 45 * 24,
        completedHours: 25 * 24,
      },
      {
        title: 'Rule consolidation',
        status: 'completed',
        startedHours: 24 * 24,
        completedHours: 12 * 24,
      },
      { title: 'Discount approvals', status: 'in_progress', startedHours: 10 * 24 },
      { title: 'Handover', status: 'pending' },
    ],
  },
  {
    requestId: AG.portalRequest,
    engagementId: AG.portal,
    title: 'Experience Cloud partner portal',
    companyId: P.kestrel,
    deliverer: TEAMMATES.marcus,
    status: 'active',
    pricingMethod: 'fixed',
    activatedDays: 9,
    milestones: [
      { title: 'Portal build', status: 'in_progress', startedHours: 4 * 24 },
      { title: 'Partner onboarding', status: 'pending' },
    ],
  },
  {
    requestId: AG.flowAuditRequest,
    engagementId: AG.flowAudit,
    title: 'Flow automation audit',
    companyId: P.brightwater,
    deliverer: TEAMMATES.aisha,
    status: 'completed',
    pricingMethod: 'fixed',
    activatedDays: 60,
    milestones: [
      {
        title: 'Flow inventory',
        status: 'completed',
        startedHours: 60 * 24,
        completedHours: 50 * 24,
      },
      {
        title: 'Audit report',
        status: 'completed',
        startedHours: 49 * 24,
        completedHours: 40 * 24,
      },
    ],
  },
  {
    requestId: AG.journeyRequest,
    engagementId: AG.journey,
    title: 'Marketing Cloud journey audit',
    companyId: P.brightwater,
    deliverer: TEAMMATES.marcus,
    status: 'cancelled',
    pricingMethod: 'fixed',
    activatedDays: 50,
    milestones: [
      {
        title: 'Journey review',
        status: 'completed',
        startedHours: 50 * 24,
        completedHours: 30 * 24,
      },
      { title: 'Recommendations', status: 'pending' },
    ],
  },
];

const SUMMIT_RIDGE_PROJECTS: readonly AgencyProject[] = [
  {
    requestId: AG.fieldServiceRequest,
    engagementId: AG.fieldService,
    title: 'Field Service scheduling rollout',
    companyId: P.kestrel,
    deliverer: TEAMMATES.lena,
    status: 'active',
    pricingMethod: 'fixed',
    activatedDays: 15,
    milestones: [
      {
        title: 'Scheduling rules',
        status: 'completed',
        startedHours: 15 * 24,
        completedHours: 5 * 24,
      },
      { title: 'Mobile rollout', status: 'in_progress', startedHours: 4 * 24 },
    ],
  },
  {
    requestId: AG.intakeRequest,
    engagementId: AG.intake,
    title: 'Health Cloud intake forms',
    companyId: P.larkspur,
    deliverer: TEAMMATES.lena,
    status: 'active',
    pricingMethod: 'fixed',
    activatedDays: 12,
    milestones: [
      { title: 'Form design', status: 'in_progress', startedHours: 3 * 24 },
      { title: 'Go-live', status: 'pending' },
    ],
  },
];

function delivererIds(
  ctx: HelpWorldContext,
  deliverer: AgencyProject['deliverer']
): { profileId: string; userId: string } {
  return deliverer === 'priya'
    ? { profileId: HELP_IDS.expertProfile, userId: ctx.priyaId }
    : { profileId: deliverer.profileId, userId: deliverer.userId };
}

/** The project child's terminal columns for each delivery status. */
function agencyProjectColumns(
  ctx: HelpWorldContext,
  project: AgencyProject,
  delivererUserId: string
): ProjectRow {
  const base: ProjectRow = {
    deliveryStatus: project.status,
    pricingMethod: project.pricingMethod,
    priceCents: 1_200_000,
    projectRequestId: project.requestId,
    ...(project.pricingMethod === 'tm'
      ? { rateCents: 17_000, cadence: 'fortnightly' as const }
      : {}),
  };
  switch (project.status) {
    case 'active':
      return project.engagementId === AG.routing
        ? {
            ...base,
            changeRequestNote:
              'The escalation queue still skips the Tier 2 team — can we fix that before sign-off?',
            changeRequestedByUserId: ctx.danaId,
            changeRequestedAt: hoursAgo(ctx, 20),
          }
        : base;
    case 'pending_acceptance':
      // Recent real time: the auto-accept sweep acts seven days after this, and reminds at five.
      return {
        ...base,
        completionRequestedAt: hoursAgo(ctx, 24),
        completionRequestedByUserId: delivererUserId,
      };
    case 'completed':
      return {
        ...base,
        completionRequestedAt: hoursAgo(ctx, 45 * 24),
        completionRequestedByUserId: delivererUserId,
        acceptedAt: hoursAgo(ctx, 38 * 24),
        acceptanceMethod: 'auto',
      };
    case 'cancelled':
      return {
        ...base,
        cancelledAt: atAnchor(ctx, CANCELLED_DAYS_BEFORE_ANCHOR, 15),
        cancellationReason: 'Brightwater Foods paused its marketing programme.',
      };
    default: {
      const unhandled: never = project.status;
      throw new Error(`Unknown agency project status: ${String(unhandled)}`);
    }
  }
}

async function insertAgencyProjects(
  db: HelpExecutor,
  ctx: HelpWorldContext,
  projects: readonly AgencyProject[],
  firstMilestone: number
): Promise<void> {
  let milestoneIndex = firstMilestone;
  for (const project of projects) {
    const { profileId, userId } = delivererIds(ctx, project.deliverer);
    const activated = hoursAgo(ctx, project.activatedDays * 24);
    await insertRequest(db, ctx, {
      id: project.requestId,
      companyId: project.companyId,
      expertProfileId: profileId,
      status: 'kickoff_approved',
      title: project.title,
      description: `<p>${project.title}, delivered in milestones.</p>`,
      createdAt: hoursAgo(ctx, (project.activatedDays + 10) * 24),
      updatedAt: activated,
    });
    await insertProjectEngagement(db, {
      id: project.engagementId,
      companyId: project.companyId,
      expertProfileId: profileId,
      activatedAt: activated,
      status: project.status === 'pending_acceptance' ? 'active' : project.status,
      project: agencyProjectColumns(ctx, project, userId),
    });
    await insertMilestones(
      db,
      project.engagementId,
      userId,
      project.milestones.map((milestone) => {
        const id = helpAgencyMilestoneId(milestoneIndex);
        milestoneIndex += 1;
        return {
          id,
          title: milestone.title,
          status: milestone.status,
          estimatedMinutes: milestone.estimatedMinutes,
          startedAt:
            milestone.startedHours === undefined
              ? undefined
              : hoursAgo(ctx, milestone.startedHours),
          completedAt:
            milestone.completedHours === undefined
              ? undefined
              : hoursAgo(ctx, milestone.completedHours),
        };
      })
    );
  }
}

/** Milestone count of a project list, so the second agency's ids follow the first's. */
function milestoneCount(projects: readonly AgencyProject[]): number {
  return projects.reduce((sum, project) => sum + project.milestones.length, 0);
}

/**
 * Priya's three agency-oversight notices, worded as the BAL-631 in-app templates word them.
 * Times are anchor-relative because the panel prints them against the frozen browser clock.
 */
async function insertAgencyNotifications(db: HelpExecutor, ctx: HelpWorldContext): Promise<void> {
  const cancelledAt = atAnchor(ctx, CANCELLED_DAYS_BEFORE_ANCHOR, 15);
  const notices = [
    {
      id: AG.notificationChanges,
      event: 'engagement.changes_requested',
      template: 'engagement-changes-requested-agency',
      title: 'Changes requested',
      body: "Dana Whitfield @ Northwind Industrial requested changes on 'Service Cloud case routing rebuild', delivered by Marcus Chen. Open the project to see what's needed.",
      engagementId: AG.routing,
      createdAt: atAnchor(ctx, 0, 8, 35),
    },
    {
      id: AG.notificationEstimate,
      event: 'engagement.milestone_estimate_exceeded',
      template: 'engagement-milestone-estimate-exceeded-agency',
      title: 'Milestone over estimate',
      body: "'Data load dry run' on 'Legacy CRM data migration' is at 14.5 hrs; the estimate is 12 hrs. Aisha Okafor is delivering.",
      engagementId: AG.migration,
      createdAt: atAnchor(ctx, -1, 16, 20),
    },
    {
      id: AG.notificationCancelled,
      event: 'engagement.cancelled',
      template: 'engagement-cancelled-agency',
      title: 'Project cancelled',
      body: `'Marketing Cloud journey audit' for Brightwater Foods, delivered by Marcus Chen, was cancelled on ${formatLongUtc(cancelledAt)}. Cancelled by Balo.`,
      engagementId: AG.journey,
      createdAt: cancelledAt,
    },
  ];
  // Clear the notices the engine wrote to this shared test-login user on earlier runs, so the
  // panel holds exactly these three. The seen cursor sits at the frozen 09:00 browser clock,
  // after every notice: none counts as unseen, so no arrival toast covers the bell, while all
  // three stay unread. A null cursor would not hold: the first page load posts "seen" through
  // the server's real clock, which is before the anchor-dated notices. Later posts cannot move
  // the cursor back, because the advance is monotonic.
  await db.delete(userNotifications).where(eq(userNotifications.userId, ctx.priyaId));
  await db
    .update(users)
    .set({ notificationsLastSeenAt: atAnchor(ctx, 0, 9) })
    .where(eq(users.id, ctx.priyaId));
  await db.insert(userNotifications).values(
    notices.map((notice) => ({
      id: notice.id,
      userId: ctx.priyaId,
      event: notice.event,
      title: notice.title,
      body: notice.body,
      actionUrl: `/engagements/${notice.engagementId}?from=agency`,
      metadata: { template: notice.template },
      createdAt: notice.createdAt,
      updatedAt: notice.createdAt,
    }))
  );
}

/**
 * Priya owns CloudPeak Consulting (Marcus and Aisha live, Tom gone), delivering one of its seven
 * projects. `multi` adds Summit Ridge Partners, where Priya is an admin beside Lena.
 */
export async function seedAgencyWorld(
  db: HelpExecutor,
  ctx: HelpWorldContext,
  multi: boolean
): Promise<void> {
  await insertCompanies(
    db,
    multi ? [P.kestrel, P.brightwater, P.larkspur] : [P.kestrel, P.brightwater]
  );
  await db
    .insert(agencies)
    .values([
      { id: P.cloudPeak, name: 'CloudPeak Consulting', slug: 'cloudpeak-consulting' },
      ...(multi
        ? [{ id: P.summitRidge, name: 'Summit Ridge Partners', slug: 'summit-ridge-partners' }]
        : []),
    ]);
  await insertTeammates(db, ctx, [
    { teammate: TEAMMATES.marcus, agencyId: P.cloudPeak },
    { teammate: TEAMMATES.aisha, agencyId: P.cloudPeak },
    { teammate: TEAMMATES.tom, agencyId: P.cloudPeak },
    ...(multi ? [{ teammate: TEAMMATES.lena, agencyId: P.summitRidge }] : []),
  ]);
  await db
    .update(expertProfiles)
    .set({ agencyId: P.cloudPeak })
    .where(eq(expertProfiles.id, HELP_IDS.expertProfile));

  const joined = hoursAgo(ctx, 400 * 24);
  await db.insert(agencyMembers).values([
    {
      id: P.priyaCloudPeak,
      agencyId: P.cloudPeak,
      userId: ctx.priyaId,
      role: 'owner',
      joinMethod: 'owner',
      joinedAt: joined,
    },
    {
      id: P.marcusCloudPeak,
      agencyId: P.cloudPeak,
      userId: P.marcusUser,
      role: 'expert',
      joinMethod: 'invite',
      invitedById: ctx.priyaId,
      joinedAt: joined,
    },
    {
      id: P.aishaCloudPeak,
      agencyId: P.cloudPeak,
      userId: P.aishaUser,
      role: 'expert',
      joinMethod: 'invite',
      invitedById: ctx.priyaId,
      joinedAt: joined,
    },
    // Tom left on his own: a soft-deleted row attributed to himself.
    {
      id: P.tomCloudPeak,
      agencyId: P.cloudPeak,
      userId: P.tomUser,
      role: 'expert',
      joinMethod: 'invite',
      invitedById: ctx.priyaId,
      joinedAt: joined,
      deletedAt: hoursAgo(ctx, 20 * 24),
      deletedByUserId: P.tomUser,
    },
    ...(multi
      ? [
          {
            id: P.lenaSummitRidge,
            agencyId: P.summitRidge,
            userId: P.lenaUser,
            role: 'owner' as const,
            joinMethod: 'owner' as const,
            joinedAt: joined,
          },
          {
            id: P.priyaSummitRidge,
            agencyId: P.summitRidge,
            userId: ctx.priyaId,
            role: 'admin' as const,
            joinMethod: 'invite' as const,
            invitedById: P.lenaUser,
            joinedAt: joined,
          },
        ]
      : []),
  ]);

  await insertAgencyProjects(db, ctx, CLOUDPEAK_PROJECTS, 0);
  if (multi) {
    await insertAgencyProjects(db, ctx, SUMMIT_RIDGE_PROJECTS, milestoneCount(CLOUDPEAK_PROJECTS));
  }
  await insertAgencyNotifications(db, ctx);
}

// ── Case files ────────────────────────────────────────────────────────────

/**
 * Four files on the base case's thread, newest first: two the convert drawer can attach, one
 * over the 5 MB limit and one of a type it does not take. Sizes are whole KiB, because the
 * app's byte labels divide by 1024: 421_888 reads "412 KB".
 */
export async function seedCaseFiles(db: HelpExecutor, ctx: HelpWorldContext): Promise<void> {
  const files = [
    {
      id: W.caseFiles.errorLog,
      name: 'flow-error-log.pdf',
      type: 'application/pdf',
      size: 421_888,
      by: ctx.priyaId,
      at: atAnchor(ctx, -9, 10),
    },
    {
      id: W.caseFiles.screenshot,
      name: 'approval-screen.png',
      type: 'image/png',
      size: 292_864,
      by: ctx.danaId,
      at: atAnchor(ctx, -9, 9),
    },
    {
      id: W.caseFiles.export,
      name: 'full-metadata-export.pdf',
      type: 'application/pdf',
      size: 7_340_032,
      by: ctx.priyaId,
      at: atAnchor(ctx, -10, 15),
    },
    {
      id: W.caseFiles.mapping,
      name: 'field-mapping.xlsx',
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      size: 49_152,
      by: ctx.danaId,
      at: atAnchor(ctx, -10, 14),
    },
  ];
  await db.insert(conversationFiles).values(
    files.map((file) => ({
      id: file.id,
      conversationId: HELP_IDS.conversation,
      uploadedByUserId: file.by,
      r2Key: `help-fixture/conversation-files/${file.id}`,
      fileName: file.name,
      contentType: file.type,
      sizeBytes: file.size,
      createdAt: file.at,
      updatedAt: file.at,
    }))
  );
}

/** Stamps the go-live celebration as seen, as the expert dashboard does on its first visit. */
export async function markCelebrationSeen(db: HelpExecutor): Promise<void> {
  await db
    .update(expertProfiles)
    .set({ liveCelebrationSeenAt: FIXED_DECISION_TIME })
    .where(
      and(
        eq(expertProfiles.id, HELP_IDS.expertProfile),
        isNull(expertProfiles.liveCelebrationSeenAt)
      )
    );
}

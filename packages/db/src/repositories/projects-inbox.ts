import { and, desc, eq, inArray, isNull, max, ne } from 'drizzle-orm';
import { db } from '../client';
import {
  companies,
  expressionsOfInterest,
  projectRequests,
  requestExpertRelationships,
} from '../schema';
import type { ProjectRequestStatus } from './project-requests';

/**
 * projects-inbox — aggregation-only READ repository for the A7 tri-lens portfolio
 * dashboard (BAL-274). Isolated from the write-path `project-requests.ts`: every
 * method here is a list-shaped read that aggregates the request-origination spine
 * into a single "state of your world" view per actor (client / expert / admin).
 *
 * Query strategy (the resolver's N+1 decision): each lens is ONE hydrated
 * `db.query` `with:` graph (or one flat `innerJoin` for the expert-invitations
 * lens) — Drizzle emits a bounded set of selects, NOT N per row. The web loader
 * then runs ONE batched `conversationsRepository.listThreadSummaries(...)` over the
 * union of relationship ids for the unread + freshest-message signals; that join
 * lives in the web view-model layer, never here.
 *
 * Soft-delete-aware at EVERY level — the top request, each relationship, each
 * newest EOI/message, the engagement, and the joined company all filter
 * `deletedAt IS NULL`. Columns are allow-listed (defense-in-depth) so only what the
 * recency fold + view-model need crosses the boundary.
 *
 * The recency sort key (`requestRecencyAt`) and the needs-you predicate are
 * computed in the client-safe WEB view-model from the timestamps these methods
 * hydrate — NOT in the repo (which stays free of view concerns). This module only
 * guarantees those timestamps are selected.
 */

/** Local alias — the per-expert relationship status enum value. */
type RequestExpertRelationshipStatus = (typeof requestExpertRelationships.$inferSelect)['status'];

/**
 * The shared hydrated `with:` graph behind BOTH the client lens (`listByCompany`)
 * and the admin lens (`listAll`). A LIST-shaped mirror of `findByIdWithRelations`:
 * selects ONLY the recency-fold timestamps + the stage/needs-you columns the web
 * view-model reads, soft-delete-aware at every child level. The optional
 * `companyId` scopes the client lens; `statusFilter` scopes the admin triage hero.
 *
 * This is a standalone module function (not a repo method) so its INFERRED return
 * type is the single source of truth for `PortfolioRequestRow` — deriving the row
 * type from a repo method that other methods annotate would be a circular
 * self-reference. Always newest-created first as the stable base order.
 */
async function queryPortfolioRequests(filter: {
  companyId?: string;
  statusFilter?: ProjectRequestStatus;
}) {
  return db.query.projectRequests.findMany({
    where: and(
      isNull(projectRequests.deletedAt),
      filter.companyId === undefined ? undefined : eq(projectRequests.companyId, filter.companyId),
      filter.statusFilter === undefined
        ? undefined
        : eq(projectRequests.status, filter.statusFilter)
    ),
    columns: {
      id: true,
      companyId: true,
      expertProfileId: true,
      status: true,
      title: true,
      clientBillingConfirmedAt: true,
      expertTermsConfirmedAt: true,
      createdAt: true,
      updatedAt: true,
    },
    with: {
      company: { columns: { id: true, name: true } },
      relationships: {
        where: (t, { isNull: childIsNull }) => childIsNull(t.deletedAt),
        columns: {
          id: true,
          expertProfileId: true,
          status: true,
          invitedAt: true,
          updatedAt: true,
          proposalRequestedAt: true,
        },
        with: {
          // Newest live EOI per relationship — its `submittedAt` is a recency signal.
          expressionsOfInterest: {
            where: (t, { isNull: childIsNull }) => childIsNull(t.deletedAt),
            columns: { id: true, submittedAt: true },
            orderBy: (t, { desc: childDesc }) => [childDesc(t.submittedAt)],
            limit: 1,
          },
          // Newest live conversation message per relationship — its `createdAt` is
          // the "talking" recency signal.
          conversationMessages: {
            where: (t, { isNull: childIsNull }) => childIsNull(t.deletedAt),
            columns: { id: true, createdAt: true },
            orderBy: (t, { desc: childDesc }) => [childDesc(t.createdAt)],
            limit: 1,
          },
        },
      },
    },
    orderBy: desc(projectRequests.createdAt),
  });
}

/**
 * The hydrated request shape the portfolio rows fold over. Mirrors
 * `ProjectRequestWithRelations`'s element type but LIST-shaped and trimmed to the
 * columns the recency fold + view-model consume: the request's own `updatedAt`,
 * each relationship's `invitedAt` / `updatedAt` / `proposalRequestedAt`, and each
 * relationship's newest live EOI `submittedAt` + newest live message `createdAt`.
 * The element type of the shared `queryPortfolioRequests` (a `findMany`, so each
 * element is non-null already).
 */
export type PortfolioRequestRow = Awaited<ReturnType<typeof queryPortfolioRequests>>[number];

export const projectsInboxRepository = {
  /**
   * Client lens — all LIVE requests owned by a company, hydrated with each live
   * relationship and that relationship's newest live EOI/message (for the recency
   * fold). Soft-delete-aware at every level. Returns `createdAt`-desc as a stable
   * base order (the canonical needs-you + recency sort is a web concern). Includes
   * ALL statuses (the Total tile shows everything — no `draft` filter built).
   * Rides `project_requests_company_idx`. Empty company → `[]`.
   */
  async listByCompany(companyId: string): Promise<PortfolioRequestRow[]> {
    return queryPortfolioRequests({ companyId });
  },

  /**
   * Admin lens — all LIVE requests platform-wide for the triage board + pipeline
   * kanban, hydrated with the same graph as `listByCompany` (company name +
   * relationships + recency-fold timestamps), with NO company scope. Optional
   * `statusFilter` scopes to one stage (e.g. `'requested'` for the triage hero).
   * Newest-created first as the stable base. Empty DB → `[]`.
   */
  async listAll(input?: { statusFilter?: ProjectRequestStatus }): Promise<PortfolioRequestRow[]> {
    return queryPortfolioRequests({ statusFilter: input?.statusFilter });
  },

  /**
   * Expert lens (source 1 of 2) — the expert's invitation portfolio: every LIVE,
   * NON-DECLINED relationship for this expert, joined to its LIVE parent request
   * (title, status) + the request's company (name) + the relationship's newest live
   * EOI `submittedAt` (for the recency fold; freshest message comes from
   * `listThreadSummaries` in the loader). `status <> 'declined'` — a declined expert
   * is no longer a participant (mirrors `INACTIVE_RELATIONSHIP_STATUSES`).
   *
   * Uses a FLAT `innerJoin` (not a relational `with:`) deliberately: the
   * parent-request `deletedAt` filter CANNOT ride a relational `one` parent edge, so
   * the only way to exclude relationships whose parent request is soft-deleted is to
   * join the parent explicitly and guard it in the join condition. Rides
   * `request_expert_relationship_expert_idx`. Newest-invited first as the base order.
   * Empty expert → `[]`.
   */
  async listInvitationsByExpert(expertProfileId: string): Promise<PortfolioInvitationRow[]> {
    const rows = await db
      .select({
        relationshipId: requestExpertRelationships.id,
        relationshipStatus: requestExpertRelationships.status,
        invitedAt: requestExpertRelationships.invitedAt,
        relationshipUpdatedAt: requestExpertRelationships.updatedAt,
        proposalRequestedAt: requestExpertRelationships.proposalRequestedAt,
        projectRequestId: projectRequests.id,
        requestStatus: projectRequests.status,
        title: projectRequests.title,
        companyId: companies.id,
        companyName: companies.name,
      })
      .from(requestExpertRelationships)
      // LIVE parent request only — the deletedAt guard rides the join condition,
      // which a relational `one` edge cannot express. This is the whole reason for
      // the flat join.
      .innerJoin(
        projectRequests,
        and(
          eq(requestExpertRelationships.projectRequestId, projectRequests.id),
          isNull(projectRequests.deletedAt)
        )
      )
      .innerJoin(companies, eq(projectRequests.companyId, companies.id))
      .where(
        and(
          eq(requestExpertRelationships.expertProfileId, expertProfileId),
          ne(requestExpertRelationships.status, 'declined'),
          isNull(requestExpertRelationships.deletedAt)
        )
      )
      .orderBy(desc(requestExpertRelationships.invitedAt));

    if (rows.length === 0) {
      return [];
    }

    // ONE batched grouped subquery for the newest live EOI per relationship —
    // max(submittedAt) over the loaded relationship ids. Keyed back onto the rows.
    const relationshipIds = rows.map((row) => row.relationshipId);
    const eoiRows = await db
      .select({
        relationshipId: expressionsOfInterest.relationshipId,
        newestEoiAt: max(expressionsOfInterest.submittedAt),
      })
      .from(expressionsOfInterest)
      .where(
        and(
          inArray(expressionsOfInterest.relationshipId, relationshipIds),
          isNull(expressionsOfInterest.deletedAt)
        )
      )
      .groupBy(expressionsOfInterest.relationshipId);

    const newestEoiByRelationship = new Map<string, Date | null>(
      eoiRows.map((row) => [row.relationshipId, row.newestEoiAt])
    );

    return rows.map((row) => ({
      relationshipId: row.relationshipId,
      relationshipStatus: row.relationshipStatus,
      invitedAt: row.invitedAt,
      relationshipUpdatedAt: row.relationshipUpdatedAt,
      proposalRequestedAt: row.proposalRequestedAt,
      projectRequestId: row.projectRequestId,
      requestStatus: row.requestStatus,
      title: row.title,
      companyId: row.companyId,
      companyName: row.companyName,
      newestEoiAt: newestEoiByRelationship.get(row.relationshipId) ?? null,
    }));
  },
};

/**
 * One expert-invitation row — a flat join of a live, non-declined relationship to
 * its LIVE parent request and the request's company. `newestEoiAt` is the
 * relationship's newest live EOI `submittedAt` (null when none), batched in. The
 * flat join (not a relational `with:`) exists precisely so the parent-request
 * `deletedAt` filter can be applied — a relational `one` parent edge cannot be
 * filtered inline.
 */
export interface PortfolioInvitationRow {
  relationshipId: string;
  relationshipStatus: RequestExpertRelationshipStatus;
  invitedAt: Date;
  relationshipUpdatedAt: Date;
  proposalRequestedAt: Date | null;
  projectRequestId: string;
  requestStatus: ProjectRequestStatus;
  title: string;
  companyId: string;
  companyName: string;
  newestEoiAt: Date | null;
}

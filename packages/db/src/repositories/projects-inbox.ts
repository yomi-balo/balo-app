import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  max,
  ne,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { db } from '../client';
import {
  companies,
  expressionsOfInterest,
  products,
  projectRequestProducts,
  projectRequestTags,
  projectRequests,
  projectTags,
  proposalChangeRequests,
  proposalMilestones,
  proposals,
  requestExpertRelationships,
} from '../schema';
import type { ProjectRequestStatus } from './project-requests';
import type { ProposalStatus } from './proposals';
import type { ProposalChangeSection } from './proposal-types';
import { conversationsRepository } from './conversations';

/**
 * projects-inbox — aggregation-only READ repository for the A7 tri-lens portfolio
 * dashboard (BAL-274). Isolated from the write-path `project-requests.ts`: every
 * method here is a list-shaped read that aggregates the request-origination spine
 * into a single "state of your world" view per actor (client / expert / admin).
 *
 * Query strategy (the resolver's N+1 decision): each lens is ONE hydrated
 * `db.query` `with:` graph (or one flat `innerJoin` for the expert-invitations
 * lens) — Drizzle emits a bounded set of selects, NOT N per row — plus ONE batched
 * `conversationsRepository.latestMessagesForRelationships(...)` for the newest-message
 * recency signal (see below). The web loader then runs ONE batched
 * `conversationsRepository.listThreadSummaries(...)` over the union of CONVERSATION ids for
 * the unread + freshest-message signals; that join lives in the web view-model layer, never
 * here.
 *
 * ⚠ `conversationMessages` IS GRAFTED, NOT HYDRATED (BAL-424). Messages no longer FK the
 * relationship — they hang off `conversations` through the polymorphic, FK-less
 * `conversation_contexts` seam, which Drizzle's relational `with:` cannot traverse. The
 * array is rebuilt in the EXACT shape the `with:` produced (`{ id, createdAt }[]` of length
 * ≤ 1) so `PortfolioRequestRow` — which is INFERRED from this function — is unchanged and
 * `portfolio-row.ts`'s `relationshipLastActivityAt` needs no edit.
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

/**
 * The single definition of which of an expert's relationships the INBOX lists (history
 * included). `listExpertMoveDetails` is stricter: it never returns a declined relationship.
 *
 * BAL-540 — a declined track is normally invisible to the expert (they are no longer a
 * participant), BUT the tracks of a CLOSED request must still come back or the expert's
 * "Closed" portfolio group would be permanently empty: the close cascade declines every track
 * it closes, so the two predicates would cancel out. The ended state is then rendered from the
 * REQUEST's status, which is the honest signal — "this request was closed", not "you were
 * declined".
 */
function expertCanSeeRelationship(): SQL | undefined {
  return or(
    ne(requestExpertRelationships.status, 'declined'),
    eq(projectRequests.status, 'closed')
  );
}

/** Local alias — the per-expert relationship status enum value. */
export type RequestExpertRelationshipStatus =
  (typeof requestExpertRelationships.$inferSelect)['status'];

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
  excludeStatuses?: readonly ProjectRequestStatus[];
}) {
  const rows = await db.query.projectRequests.findMany({
    where: and(
      isNull(projectRequests.deletedAt),
      filter.companyId === undefined ? undefined : eq(projectRequests.companyId, filter.companyId),
      filter.statusFilter === undefined
        ? undefined
        : eq(projectRequests.status, filter.statusFilter),
      // BAL-540 — SQL-side exclusion. `undefined` on an empty/absent list so `and()` drops the
      // term entirely; an empty `notInArray` is a SQL error, not a true predicate. Enum
      // literals in a WHERE are always safe (the ADD-VALUE restriction is on DEFAULTs, CHECKs
      // and index predicates).
      filter.excludeStatuses === undefined || filter.excludeStatuses.length === 0
        ? undefined
        : notInArray(projectRequests.status, [...filter.excludeStatuses])
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
      // BAL-541 — THE USER ID ONLY, on a query the CLIENT and EXPERT lenses also run.
      //
      // ⚠ A SCALAR, DELIBERATELY NOT A `with: { baloOwner: … }` RELATION. Hydrating a name here
      // would make every client-lens list read pay for — and carry — a Balo staffer's identity,
      // which is exactly the over-hydration this allow-list exists to prevent. The ADMIN loader
      // alone resolves names, batching the ids through `usersRepository.findNamesByIds`.
      //
      // ⚠ `PortfolioRowView` MUST NEVER READ IT. The column stops at the admin kanban card; a
      // sentinel test pins that neither the client nor the expert row DTO carries the id or
      // anything derived from it.
      baloOwnerUserId: true,
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
          // The client's recency folds only opened tracks (`relationshipIsOpened`).
          openedAt: true,
        },
        with: {
          // Newest live EOI per relationship — its `submittedAt` is a recency signal.
          expressionsOfInterest: {
            where: (t, { isNull: childIsNull }) => childIsNull(t.deletedAt),
            columns: { id: true, submittedAt: true },
            orderBy: (t, { desc: childDesc }) => [childDesc(t.submittedAt)],
            limit: 1,
          },
          // Status of the relationship's LIVE current proposal (at most one row).
          proposals: {
            where: (t, { and: childAnd, eq: childEq, isNull: childIsNull }) =>
              childAnd(childEq(t.isCurrent, true), childIsNull(t.deletedAt)),
            columns: { status: true },
            limit: 1,
          },
        },
      },
    },
    orderBy: desc(projectRequests.createdAt),
  });

  // SHAPE-PRESERVING GRAFT (BAL-424) — see the module docblock. ONE batched call over EVERY
  // relationship across ALL rows; never one per row, or the inbox becomes an N+1.
  const latestByRelationship = await conversationsRepository.latestMessagesForRelationships(
    rows.flatMap((row) => row.relationships.map((relationship) => relationship.id))
  );

  return rows.map((row) => ({
    ...row,
    relationships: row.relationships.map((relationship) => {
      const latest = latestByRelationship.get(relationship.id);
      return {
        ...relationship,
        conversationMessages: latest === undefined ? [] : [latest],
      };
    }),
  }));
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
  async listAll(input?: {
    statusFilter?: ProjectRequestStatus;
    /**
     * BAL-540 — statuses to EXCLUDE, IN SQL. The admin triage board and pipeline kanban pass
     * `['closed']`: a terminal request must never enter the board, and the JavaScript filter
     * they used before still paid to hydrate every child row of every closed request first.
     * Combines with `statusFilter` by AND (nobody does both today; the semantics are the
     * obvious ones if they ever do).
     */
    excludeStatuses?: readonly ProjectRequestStatus[];
  }): Promise<PortfolioRequestRow[]> {
    return queryPortfolioRequests({
      statusFilter: input?.statusFilter,
      excludeStatuses: input?.excludeStatuses,
    });
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
        clientBillingConfirmedAt: projectRequests.clientBillingConfirmedAt,
        expertTermsConfirmedAt: projectRequests.expertTermsConfirmedAt,
        currentProposalStatus: proposals.status,
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
      // At most one row per relationship (`proposal_current_per_relationship_idx`), so the
      // LEFT JOIN cannot fan the result out.
      .leftJoin(
        proposals,
        and(
          eq(proposals.relationshipId, requestExpertRelationships.id),
          eq(proposals.isCurrent, true),
          isNull(proposals.deletedAt)
        )
      )
      .where(
        and(
          eq(requestExpertRelationships.expertProfileId, expertProfileId),
          expertCanSeeRelationship(),
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
      clientBillingConfirmedAt: row.clientBillingConfirmedAt,
      expertTermsConfirmedAt: row.expertTermsConfirmedAt,
      currentProposalStatus: row.currentProposalStatus,
      newestEoiAt: newestEoiByRelationship.get(row.relationshipId) ?? null,
    }));
  },

  /**
   * Expert "Your move" detail batch. For the given project requests, what the expert's own
   * card needs and the portfolio row does not: brief, timeline, product and tag names, kickoff
   * gates, the relationship's LIVE current proposal and the newest change request raised
   * against that current proposal row (a resubmit is a fresh row, so older versions' change
   * requests hang off older rows and never appear).
   *
   * Scoped to the caller: a request the expert has no live, non-declined relationship on is
   * absent from the result, even when the request is closed (the closed-request history
   * exception belongs to the inbox list only). No budget or price column is selected. Four fixed queries regardless of input
   * size; empty input returns an empty Map without touching the DB.
   */
  async listExpertMoveDetails(input: {
    expertProfileId: string;
    projectRequestIds: readonly string[];
  }): Promise<Map<string, ExpertMoveDetail>> {
    const result = new Map<string, ExpertMoveDetail>();
    if (input.projectRequestIds.length === 0) {
      return result;
    }
    const requestIds = [...input.projectRequestIds];

    const [requestRows, productRows, tagRows] = await Promise.all([
      db
        .select({
          projectRequestId: projectRequests.id,
          requestStatus: projectRequests.status,
          descriptionHtml: projectRequests.description,
          timeline: projectRequests.timeline,
          clientBillingConfirmedAt: projectRequests.clientBillingConfirmedAt,
          expertTermsConfirmedAt: projectRequests.expertTermsConfirmedAt,
          proposalId: proposals.id,
          proposalStatus: proposals.status,
          proposalVersion: proposals.version,
          proposalUpdatedAt: proposals.updatedAt,
        })
        .from(projectRequests)
        .innerJoin(
          requestExpertRelationships,
          and(
            eq(requestExpertRelationships.projectRequestId, projectRequests.id),
            eq(requestExpertRelationships.expertProfileId, input.expertProfileId),
            isNull(requestExpertRelationships.deletedAt),
            ne(requestExpertRelationships.status, 'declined')
          )
        )
        .leftJoin(
          proposals,
          and(
            eq(proposals.relationshipId, requestExpertRelationships.id),
            eq(proposals.isCurrent, true),
            isNull(proposals.deletedAt)
          )
        )
        .where(and(inArray(projectRequests.id, requestIds), isNull(projectRequests.deletedAt))),
      db
        .select({
          projectRequestId: projectRequestProducts.projectRequestId,
          name: products.name,
        })
        .from(projectRequestProducts)
        .innerJoin(products, eq(products.id, projectRequestProducts.productId))
        .where(
          and(
            inArray(projectRequestProducts.projectRequestId, requestIds),
            isNull(projectRequestProducts.deletedAt)
          )
        )
        .orderBy(asc(products.name)),
      db
        .select({
          projectRequestId: projectRequestTags.projectRequestId,
          name: projectTags.name,
        })
        .from(projectRequestTags)
        .innerJoin(
          projectTags,
          and(eq(projectTags.id, projectRequestTags.projectTagId), isNull(projectTags.deletedAt))
        )
        .where(
          and(
            inArray(projectRequestTags.projectRequestId, requestIds),
            isNull(projectRequestTags.deletedAt)
          )
        )
        .orderBy(asc(projectTags.name)),
    ]);

    const proposalIds = requestRows.flatMap((row) =>
      row.proposalId === null ? [] : [row.proposalId]
    );
    const changeRows =
      proposalIds.length === 0
        ? []
        : await db
            .selectDistinctOn([proposalChangeRequests.proposalId], {
              proposalId: proposalChangeRequests.proposalId,
              note: proposalChangeRequests.note,
              section: proposalChangeRequests.section,
              createdAt: proposalChangeRequests.createdAt,
            })
            .from(proposalChangeRequests)
            .where(
              and(
                inArray(proposalChangeRequests.proposalId, proposalIds),
                isNull(proposalChangeRequests.deletedAt)
              )
            )
            .orderBy(
              proposalChangeRequests.proposalId,
              desc(proposalChangeRequests.createdAt),
              desc(proposalChangeRequests.id)
            );
    const changeByProposal = new Map(changeRows.map((row) => [row.proposalId, row]));

    const namesByRequest = (rows: { projectRequestId: string; name: string }[]) => {
      const grouped = new Map<string, string[]>();
      for (const row of rows) {
        const names = grouped.get(row.projectRequestId) ?? [];
        names.push(row.name);
        grouped.set(row.projectRequestId, names);
      }
      return grouped;
    };
    const productsByRequest = namesByRequest(productRows);
    const tagsByRequest = namesByRequest(tagRows);

    for (const row of requestRows) {
      const change = row.proposalId === null ? undefined : changeByProposal.get(row.proposalId);
      result.set(row.projectRequestId, {
        projectRequestId: row.projectRequestId,
        requestStatus: row.requestStatus,
        descriptionHtml: row.descriptionHtml,
        timeline: row.timeline,
        productNames: productsByRequest.get(row.projectRequestId) ?? [],
        tagNames: tagsByRequest.get(row.projectRequestId) ?? [],
        clientBillingConfirmedAt: row.clientBillingConfirmedAt,
        expertTermsConfirmedAt: row.expertTermsConfirmedAt,
        currentProposal:
          row.proposalId === null ||
          row.proposalStatus === null ||
          row.proposalVersion === null ||
          row.proposalUpdatedAt === null
            ? null
            : {
                id: row.proposalId,
                status: row.proposalStatus,
                version: row.proposalVersion,
                updatedAt: row.proposalUpdatedAt,
              },
        latestChangeRequest:
          change === undefined
            ? null
            : { note: change.note, section: change.section, createdAt: change.createdAt },
      });
    }
    return result;
  },

  /**
   * Client "Your move" detail batch. For the given project requests of ONE company: the request's
   * expert-terms gate plus, per live non-declined relationship, the LIVE current proposal's
   * status, version, timeframe, live milestone count and submission time. Scoped by
   * `companyId`, so another company's request id is absent. No price or fee column is selected.
   * Two fixed queries regardless of input size (the milestone count is one grouped `count(*)`);
   * empty input returns an empty Map without touching the DB.
   */
  async listClientMoveDetails(input: {
    companyId: string;
    projectRequestIds: readonly string[];
  }): Promise<Map<string, ClientMoveDetail>> {
    const result = new Map<string, ClientMoveDetail>();
    if (input.projectRequestIds.length === 0) {
      return result;
    }

    const rows = await db
      .select({
        projectRequestId: projectRequests.id,
        expertTermsConfirmedAt: projectRequests.expertTermsConfirmedAt,
        relationshipId: requestExpertRelationships.id,
        expertProfileId: requestExpertRelationships.expertProfileId,
        relationshipStatus: requestExpertRelationships.status,
        proposalId: proposals.id,
        proposalStatus: proposals.status,
        proposalVersion: proposals.version,
        timeframeWeeks: proposals.timeframeWeeks,
        submittedAt: proposals.submittedAt,
      })
      .from(projectRequests)
      .leftJoin(
        requestExpertRelationships,
        and(
          eq(requestExpertRelationships.projectRequestId, projectRequests.id),
          isNull(requestExpertRelationships.deletedAt),
          ne(requestExpertRelationships.status, 'declined')
        )
      )
      .leftJoin(
        proposals,
        and(
          eq(proposals.relationshipId, requestExpertRelationships.id),
          eq(proposals.isCurrent, true),
          isNull(proposals.deletedAt)
        )
      )
      .where(
        and(
          eq(projectRequests.companyId, input.companyId),
          inArray(projectRequests.id, [...input.projectRequestIds]),
          isNull(projectRequests.deletedAt)
        )
      )
      .orderBy(asc(requestExpertRelationships.createdAt), asc(requestExpertRelationships.id));

    const proposalIds = rows.flatMap((row) => (row.proposalId === null ? [] : [row.proposalId]));
    const countRows =
      proposalIds.length === 0
        ? []
        : await db
            .select({
              proposalId: proposalMilestones.proposalId,
              milestoneCount: sql<number>`count(*)`.mapWith(Number),
            })
            .from(proposalMilestones)
            .where(
              and(
                inArray(proposalMilestones.proposalId, proposalIds),
                isNull(proposalMilestones.deletedAt)
              )
            )
            .groupBy(proposalMilestones.proposalId);
    const milestoneCountByProposal = new Map(
      countRows.map((row) => [row.proposalId, row.milestoneCount])
    );

    for (const row of rows) {
      const detail = result.get(row.projectRequestId) ?? {
        projectRequestId: row.projectRequestId,
        expertTermsConfirmedAt: row.expertTermsConfirmedAt,
        relationships: [],
      };
      if (
        row.relationshipId !== null &&
        row.expertProfileId !== null &&
        row.relationshipStatus !== null
      ) {
        detail.relationships.push({
          relationshipId: row.relationshipId,
          expertProfileId: row.expertProfileId,
          status: row.relationshipStatus,
          currentProposal:
            row.proposalId === null ||
            row.proposalStatus === null ||
            row.proposalVersion === null ||
            row.submittedAt === null
              ? null
              : {
                  status: row.proposalStatus,
                  version: row.proposalVersion,
                  timeframeWeeks: row.timeframeWeeks,
                  milestoneCount: milestoneCountByProposal.get(row.proposalId) ?? 0,
                  submittedAt: row.submittedAt,
                },
        });
      }
      result.set(row.projectRequestId, detail);
    }
    return result;
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
  /** Kickoff gate: the client's billing confirmation (null = outstanding). */
  clientBillingConfirmedAt: Date | null;
  /** Kickoff gate: the expert's terms confirmation (null = outstanding). */
  expertTermsConfirmedAt: Date | null;
  /** Status of the relationship's LIVE current proposal (null = none). */
  currentProposalStatus: ProposalStatus | null;
  newestEoiAt: Date | null;
}

/**
 * Everything an expert's "Your move" card needs beyond the portfolio row. Deliberately has no
 * budget or price field.
 */
export interface ExpertMoveDetail {
  projectRequestId: string;
  requestStatus: ProjectRequestStatus;
  descriptionHtml: string;
  timeline: string | null;
  productNames: string[];
  tagNames: string[];
  clientBillingConfirmedAt: Date | null;
  expertTermsConfirmedAt: Date | null;
  currentProposal: { id: string; status: ProposalStatus; version: number; updatedAt: Date } | null;
  latestChangeRequest: {
    note: string;
    section: ProposalChangeSection;
    createdAt: Date;
  } | null;
}

/**
 * Everything a client's "Your move" card needs beyond the portfolio row. Deliberately has no
 * budget, price or fee field.
 */
export interface ClientMoveDetail {
  projectRequestId: string;
  expertTermsConfirmedAt: Date | null;
  relationships: {
    relationshipId: string;
    expertProfileId: string;
    status: RequestExpertRelationshipStatus;
    currentProposal: {
      status: ProposalStatus;
      version: number;
      timeframeWeeks: number | null;
      milestoneCount: number;
      submittedAt: Date;
    } | null;
  }[];
}

import { and, asc, eq, inArray, isNull, lte, sql, type SQL } from 'drizzle-orm';
import { db } from '../client';
import {
  engagementMilestones,
  engagements,
  projectEngagements,
  projectRequests,
  type Engagement,
  type EngagementMilestone,
  type NewProjectEngagement,
  type ProjectEngagement,
  type ProjectRequest,
} from '../schema';
import type { PricingMethod, ProposalCadence } from './proposal-types';
import { isAllowedTransition, InvalidStatusTransitionError } from './project-requests';
import { assertEngagementTermsCoherent } from './proposal-coherence';
import { listByProposalTx } from './proposal-milestones';
import { engagementMilestonesRepository, snapshotFromProposalTx } from './engagement-milestones';
import { recordDeliveryAudit } from './_shared/delivery-audit';
import {
  insertEngagementRowTx,
  lockEngagementRowTx,
  projectDeliveryToEngagementStatus,
  type DbTx,
  type ProjectDeliveryStatus,
} from './_shared/engagement-supertype';

/**
 * The PROJECT engagement repository (BAL-417 / ADR-1045 §1). The project delivery
 * lifecycle MOVED here verbatim from `engagements.ts`, which is now the type-agnostic
 * supertype repository. "Engagement" in pre-BAL-417 code meant *Project*; this file is
 * where that meaning now lives.
 */

/** Re-exported (declared in `_shared/` so `engagement-lock.ts` can import it cycle-free). */
export type { ProjectDeliveryStatus };

/**
 * COHERENCE (BAL-293): assert a project's snapshotted commercial terms are
 * coherent (header-only: `price_negative` / `deposit_negative` / `tm_missing_rate`)
 * BEFORE the row is inserted. Shared by BOTH write paths (`create` and
 * `materializeFromKickoff`, which BYPASSES `create` and inserts directly) so
 * neither can drift — both MUST call it. Throws `EngagementTermsCoherenceError`.
 *
 * ⚠ Post-BAL-417 the discipline must hold ACROSS TWO TABLES IN ONE TRANSACTION: the
 * guard runs before the PARENT insert, so a coherence failure leaves neither row.
 */
function assertTermsBeforeInsert(input: {
  pricingMethod: PricingMethod;
  priceCents: number;
  depositCents?: number;
  rateCents?: number;
  cadence?: ProposalCadence;
}): void {
  assertEngagementTermsCoherent({
    pricingMethod: input.pricingMethod,
    priceCents: input.priceCents,
    depositCents: input.depositCents ?? null,
    rateCents: input.rateCents ?? null,
    cadence: input.cadence ?? null,
  });
}

/**
 * Both persisted kickoff gates (`client_billing` + `expert_terms`) must be
 * confirmed before a request can be approved and its engagement materialised.
 * The third (admin "settle invoice + approve") gate IS the approval action
 * itself, so it is not represented here.
 */
export class KickoffGatesIncompleteError extends Error {
  constructor() {
    super('Both client and expert kickoff gates must be confirmed before approval');
    this.name = 'KickoffGatesIncompleteError';
  }
}

// ── Delivery lifecycle transitions (BAL-330, relocated by BAL-417) ────────
//
// Mirrors the proposal transition pattern (proposals.ts): a `Record` transition
// map + `isAllowed*Transition` guard + typed `Invalid*TransitionError` + a shared
// `advance*(tx, …)` writer composable inside any caller's transaction.
//
// COMPLETED_AT SEMANTICS: there is NO `completed_at`. A completed project's
// completion timestamp IS `accepted_at` (client or auto); any "completed on" display
// derives from `accepted_at` where the delivery status is `completed`.
//
// LOCK ORDER: every transition locks the PARENT `engagements` row FOR UPDATE first,
// THEN the `project_engagements` child, THEN any milestone. Never the reverse
// (deadlock hazard).

/**
 * Allowed PROJECT delivery transitions (BAL-330, relocated by BAL-417).
 *
 *   active             → pending_acceptance (requestCompletion) | cancelled
 *   pending_acceptance → active (withdraw / requestChanges) | completed (accept) | cancelled
 *   completed          → []  terminal
 *   cancelled          → []  terminal
 *
 * Ordering carries no semantics — this map is the single source of truth for legal
 * PROJECT moves. The supertype `engagements.status` has NO transition map of its own;
 * it is written only as the projection of this one.
 */
export const PROJECT_DELIVERY_TRANSITIONS: Record<
  ProjectDeliveryStatus,
  readonly ProjectDeliveryStatus[]
> = {
  active: ['pending_acceptance', 'cancelled'],
  pending_acceptance: ['active', 'completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

export function isAllowedProjectDeliveryTransition(
  from: ProjectDeliveryStatus,
  to: ProjectDeliveryStatus
): boolean {
  return PROJECT_DELIVERY_TRANSITIONS[from].includes(to);
}

/** NAME PRESERVED across BAL-417 (mapped to `STATUS_CHANGED` in the web action layer). */
export class InvalidEngagementTransitionError extends Error {
  constructor(
    public readonly from: ProjectDeliveryStatus,
    public readonly to: ProjectDeliveryStatus
  ) {
    super(`Invalid engagement status transition: ${from} → ${to}`);
    this.name = 'InvalidEngagementTransitionError';
  }
}

export class MilestonesIncompleteError extends Error {
  constructor(
    public readonly engagementId: string,
    public readonly outstanding: number
  ) {
    super(`Engagement ${engagementId} has ${outstanding} milestone(s) not yet completed`);
    this.name = 'MilestonesIncompleteError';
  }
}

/**
 * D7 auto-accept window: a `pending_acceptance` project auto-accepts this many
 * days after the completion request. Consumed only in D7 (the sweep computes
 * `cutoff = now - AUTO_ACCEPT_DAYS` and passes it to `listPendingAutoAccept`) —
 * the repo stays policy-free. Plain typed const, mirroring `QUIET_THRESHOLD_DAYS`.
 *
 * FOOTGUN (memory `reference_balo_db_client_bundle_footgun`): do NOT value-import
 * this into a web *client* component — `@balo/db`'s barrel re-exports `postgres` and
 * breaks `next build`. If a later slice needs to DISPLAY the window client-side, lift
 * it to a pure `@balo/shared` subpath there.
 */
export const AUTO_ACCEPT_DAYS = 7;

/**
 * The FLAT project-engagement row (BAL-417). The supertype's universal columns with
 * `status` REPLACED by the PROJECT delivery status (the 4-value union every delivery
 * surface switches on), plus every project-only column.
 *
 * DELIBERATELY shape-compatible with the pre-BAL-417 `Engagement` so the BAL-329..338
 * delivery surfaces keep their field reads (`e.pricingMethod`, `e.completionRequestedAt`,
 * `e.status === 'pending_acceptance'`, …) with NO semantic change. The supertype
 * `Engagement` type is now a strictly SMALLER, type-agnostic row and is NOT what the
 * delivery surfaces consume.
 *
 * The child's own `engagementType`/`created_at`/`updated_at`/`deleted_at` are
 * deliberately NOT surfaced — the PARENT's are the SSOT; the child's exist only to
 * make the partial indexes and the composite FK correct.
 */
export type ProjectEngagementRow = Omit<Engagement, 'status'> & {
  status: ProjectDeliveryStatus;
} & Omit<
    ProjectEngagement,
    'engagementId' | 'engagementType' | 'deliveryStatus' | 'createdAt' | 'updatedAt' | 'deletedAt'
  >;

/**
 * The ONE place a parent + child pair becomes a flat row. Used by every writer and
 * reader.
 *
 * ⚠ SPREAD ORDER IS LOAD-BEARING AND THE TYPE SYSTEM CANNOT CATCH IT. Both rows carry
 * a `status`-shaped field (`parent.status` is the 3-value coarse projection;
 * `child.deliveryStatus` is the 4-value truth). `ProjectEngagementRow` DECLARES the
 * 4-value union, so `{...child, ...parent}` typechecks perfectly while pinning
 * `status` to the coarse value at runtime — every in-review project would then render
 * as "Active", every `case 'pending_acceptance'` arm would be dead code, and no
 * `assertNever` guard would ever fire. Zero compile errors, zero test failures against
 * hand-built fixtures.
 *
 * WRITE IT EXACTLY LIKE THIS — `status` assigned LAST, after both spreads.
 */
function toProjectRow(parent: Engagement, child: ProjectEngagement): ProjectEngagementRow {
  const {
    engagementId: _engagementId,
    engagementType: _engagementType,
    deliveryStatus,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    deletedAt: _deletedAt,
    ...childRest
  } = child;
  return { ...parent, ...childRest, status: deliveryStatus };
}

/**
 * Lock the LIVE project (PARENT row → THEN child row, FOR UPDATE) and return both.
 * Throws `Error` (missing/soft-deleted parent, missing child) /
 * `EngagementTypeMismatchError` (the id is not a project).
 */
async function lockProjectPairTx(
  tx: DbTx,
  engagementId: string
): Promise<{ parent: Engagement; child: ProjectEngagement }> {
  const parent = await lockEngagementRowTx(tx, engagementId, 'project');
  const [child] = await tx
    .select()
    .from(projectEngagements)
    .where(
      and(eq(projectEngagements.engagementId, engagementId), isNull(projectEngagements.deletedAt))
    )
    .for('update');

  if (child === undefined) {
    throw new Error(`Project engagement child row missing: ${engagementId}`);
  }
  return { parent, child };
}

/**
 * Shared PROJECT transition writer (was `advanceEngagementStatus`). Locks the PARENT
 * row FOR UPDATE via `lockEngagementRowTx(tx, id, 'project')` (lock order: parent →
 * child), locks the child, validates against `PROJECT_DELIVERY_TRANSITIONS` (+ optional
 * `expectedFrom`), then writes BOTH tables in the caller's transaction:
 * `project_engagements.{delivery_status, ...set}` AND
 * `engagements.status = projectDeliveryToEngagementStatus(to)`. Returns the flat row
 * via `toProjectRow`.
 *
 * The two-table write is the WHOLE POINT — writing only the child would let the
 * supertype status drift, and every type-agnostic reader (and the parent half of
 * `lockActiveEngagement`) reads the supertype status.
 *
 * ⚠ `set` CANNOT CARRY `deliveryStatus`. The child's status is DERIVED from `input.to`
 * and the parent's is written as `projectDeliveryToEngagementStatus(input.to)`; a `set`
 * that could override the child's would write TWO DIFFERENT VALUES to the two tables in
 * one transaction, silently breaking the projection invariant the whole supertype split
 * rests on. It is excluded from the type AND written LAST at runtime (the same
 * "status last" rule the read folds follow) so neither layer alone is load-bearing.
 * `engagementId` / `engagementType` / `deletedAt` are excluded for the same reason:
 * the identity pair is the composite FK, and soft-delete has exactly ONE sanctioned
 * writer (`softDeleteEngagementTx`).
 */
export async function advanceProjectDelivery(
  tx: DbTx,
  input: {
    engagementId: string;
    to: ProjectDeliveryStatus;
    expectedFrom?: ProjectDeliveryStatus;
    set?: Omit<
      Partial<NewProjectEngagement>,
      'deliveryStatus' | 'engagementId' | 'engagementType' | 'deletedAt'
    >;
  }
): Promise<ProjectEngagementRow> {
  const { child } = await lockProjectPairTx(tx, input.engagementId);

  if (input.expectedFrom !== undefined && child.deliveryStatus !== input.expectedFrom) {
    throw new InvalidEngagementTransitionError(child.deliveryStatus, input.to);
  }
  if (!isAllowedProjectDeliveryTransition(child.deliveryStatus, input.to)) {
    throw new InvalidEngagementTransitionError(child.deliveryStatus, input.to);
  }

  const [updatedChild] = await tx
    .update(projectEngagements)
    // STATUS LAST — the derived value wins at runtime as well as in the type.
    .set({ ...input.set, deliveryStatus: input.to })
    .where(eq(projectEngagements.engagementId, input.engagementId))
    .returning();

  if (updatedChild === undefined) {
    throw new Error(`Failed to update engagement: ${input.engagementId}`);
  }

  const [updatedParent] = await tx
    .update(engagements)
    .set({ status: projectDeliveryToEngagementStatus(input.to) })
    .where(eq(engagements.id, input.engagementId))
    .returning();

  if (updatedParent === undefined) {
    throw new Error(`Failed to update engagement: ${input.engagementId}`);
  }

  return toProjectRow(updatedParent, updatedChild);
}

/**
 * Lock the LIVE project and validate that `→ to` is a legal move from its current
 * delivery status, returning the locked pair. Shared pre-step of the transitions that
 * must inspect the current row BEFORE the flip (`requestCompletion` reads live
 * milestones under this lock; `cancelEngagement` captures the `from` status).
 * `advanceProjectDelivery` then re-locks the same rows reentrantly in the same tx.
 */
async function lockProjectForTransition(
  tx: DbTx,
  engagementId: string,
  to: ProjectDeliveryStatus
): Promise<{ parent: Engagement; child: ProjectEngagement }> {
  const pair = await lockProjectPairTx(tx, engagementId);
  if (!isAllowedProjectDeliveryTransition(pair.child.deliveryStatus, to)) {
    throw new InvalidEngagementTransitionError(pair.child.deliveryStatus, to);
  }
  return pair;
}

// ── The three hydrated read graphs ───────────────────────────────────────
//
// All three stay ROOTED on `engagements`, because the scope filter (companyId /
// expertProfileId), the `engagement_type = 'project'` filter and the soft-delete
// filter all live on the PARENT, and Drizzle's relational query builder cannot filter
// parent rows by a nested relation's columns.
//
// CONSEQUENCE: the four relocated relations (`projectRequest`, `acceptedBy`,
// `cancelledBy`, `changeRequestedBy`) are GRANDCHILDREN here — declared under
// `with: { projectEngagement: { with: { … } } }` — and each fold HOISTS them back to
// the top level, because every consumer reads them flat.

/**
 * The hydrated project + live milestones + expert (with user + nullable agency)
 * graph behind `findWithMilestones`. A standalone module function so its INFERRED
 * return type is the single source of truth for `ProjectEngagementWithMilestones`.
 * `agency` is a LEFT-JOIN `one` relation → `Agency | null` (a freelancer expert has
 * `agency: null`; the caller falls back to the expert's own name).
 *
 * A CASE id returns `undefined` — the `engagement_type = 'project'` filter is what
 * makes `/engagements/[id]` (the PROJECT delivery workspace) 404 for a case rather
 * than half-hydrate one.
 */
function queryProjectEngagementWithMilestones(id: string) {
  return db.query.engagements.findFirst({
    where: and(
      eq(engagements.id, id),
      eq(engagements.engagementType, 'project'),
      isNull(engagements.deletedAt)
    ),
    // SECURITY (BAL-417): explicit ROOT allow-list. The parent still carries
    // `balo_fee_bps` (a margin field), `deleted_at` and `engagement_type`; hydrating it
    // wholesale is what would eventually ship a raw margin to a browser through a
    // Server Action over this shape. `baloFeeBps` IS required here — the workspace
    // view grosses up per lens server-side (`applyBaloFee(priceCents, baloFeeBps)`).
    columns: {
      id: true,
      companyId: true,
      expertProfileId: true,
      currency: true,
      baloFeeBps: true,
      activatedAt: true,
      createdAt: true,
      updatedAt: true,
    },
    with: {
      milestones: {
        where: (m, { isNull: childIsNull }) => childIsNull(m.deletedAt),
        orderBy: (m, { asc: childAsc }) => [childAsc(m.sortOrder), childAsc(m.id)],
      },
      // SECURITY (BAL-330 review): explicit `columns:` projections so this
      // consumer-facing shape carries ONLY what a party-aware delivery view needs
      // (the expert's person display name + avatar, and the agency name + logo) and
      // NEVER the secret/PII fields these full rows would otherwise bundle —
      // `expertProfile.stripeConnectId`, `agency.stripeConnectId`, `user.workosId`,
      // and the expert's email/phone. A later Server Action can safely return this to
      // a client component. Notification/billing slices query their own data.
      expertProfile: {
        columns: { id: true, agencyId: true, type: true, headline: true },
        with: {
          user: { columns: { id: true, firstName: true, lastName: true, avatarUrl: true } },
          agency: { columns: { id: true, name: true, logoUrl: true } },
        },
      },
      // BAL-331 delivery workspace: all additive, all `columns:`-projected, PII-safe
      // (same discipline as `expertProfile` above — never bundle a full row).
      //   - company: the client party's display name for per-lens headers.
      //   - projectRequest: the header title (LEFT-JOIN `one` → null for a retainer
      //     engagement with no `project_request_id`; the caller falls back).
      //   - acceptedBy / changeRequestedBy: retrospective client-person attribution
      //     (each nullable — `acceptedBy` is NULL on the D7 auto path, and both are
      //     NULL until the corresponding transition happens).
      company: { columns: { id: true, name: true } },
      projectEngagement: {
        columns: {
          deliveryStatus: true,
          projectRequestId: true,
          // The originating proposal id. NOT a margin or PII field — an FK the
          // request-completion action follows to read the proposal's
          // `timeframeWeeks` for the `proposed_timeframe_weeks` analytics dimension
          // (`_actions/request-completion.ts`). Before BAL-417 this graph had no root
          // `columns:` and hydrated it for free; the explicit allow-list must keep
          // listing it or that dimension silently degrades to `null`.
          sourceProposalId: true,
          pricingMethod: true,
          priceCents: true,
          cadence: true,
          completionRequestedAt: true,
          changeRequestNote: true,
          changeRequestedAt: true,
          acceptedAt: true,
          acceptanceMethod: true,
          cancelledAt: true,
          cancellationReason: true,
        },
        with: {
          projectRequest: { columns: { id: true, title: true } },
          acceptedBy: { columns: { id: true, firstName: true, lastName: true } },
          changeRequestedBy: { columns: { id: true, firstName: true, lastName: true } },
        },
      },
    },
  });
}

type WorkspaceGraphRow = NonNullable<
  Awaited<ReturnType<typeof queryProjectEngagementWithMilestones>>
>;

/**
 * Flatten the workspace graph: the child's scalar columns AND its hydrated relations
 * are lifted to the top level so every existing consumer read keeps working. `status`
 * is assigned LAST from `deliveryStatus` (see `toProjectRow`).
 *
 * The `where` guarantees `engagementType === 'project'`, so a null child means a
 * writer bypassed the repository — throw, never silently skip.
 */
function foldWorkspaceRow(row: WorkspaceGraphRow) {
  const child = row.projectEngagement;
  if (child === null) {
    throw new Error(`Project engagement child row missing: ${row.id}`);
  }
  const { projectEngagement: _child, ...parent } = row;
  const { deliveryStatus, projectRequest, acceptedBy, changeRequestedBy, ...childScalars } = child;
  return {
    ...parent,
    ...childScalars,
    projectRequest, // HOISTED grandchild
    acceptedBy, // HOISTED grandchild
    changeRequestedBy, // HOISTED grandchild
    status: deliveryStatus, // LAST — see `toProjectRow`
  };
}

/** Live project + its live milestones + expert (user + nullable agency), FLATTENED. */
export type ProjectEngagementWithMilestones = ReturnType<typeof foldWorkspaceRow>;

/** Derived milestone-progress counts + a `lastActivityAt` proxy for one engagement. */
interface MilestoneProgressAgg {
  totalMilestones: number;
  completedMilestones: number;
  inProgressMilestones: number;
  lastMilestoneActivityAt: Date | null;
}

/**
 * ONE batched grouped milestone aggregate over the given engagement ids →
 * a Map keyed by engagement id. Shared by `listPortfolio` AND `listAllWithProgress`
 * (dedup, not copy — keeps the Sonar new-code duplication gate green). Counts live
 * milestones only; `lastMilestoneActivityAt = MAX(GREATEST(started_at, completed_at))`
 * is NULL only when no live milestone has any activity (GREATEST ignores NULLs). The
 * raw-SQL activity aggregate is coerced string→Date here (Drizzle does NOT apply the
 * timestamptz→Date codec to a `sql` fragment). Empty ids → empty Map.
 *
 * It needs no `engagement_type` filter of its own: it is only ever handed ids that
 * came from a project-filtered list.
 */
async function aggregateMilestoneProgress(
  engagementIds: string[]
): Promise<Map<string, MilestoneProgressAgg>> {
  if (engagementIds.length === 0) {
    return new Map();
  }

  const aggregates = await db
    .select({
      engagementId: engagementMilestones.engagementId,
      totalMilestones: sql<number>`cast(count(*) as int)`,
      completedMilestones: sql<number>`cast(count(*) filter (where ${engagementMilestones.status} = 'completed') as int)`,
      inProgressMilestones: sql<number>`cast(count(*) filter (where ${engagementMilestones.status} = 'in_progress') as int)`,
      // GREATEST ignores NULLs; MAX is NULL only when no live milestone has any
      // activity. Drizzle hands this raw fragment back as a string → coerced below.
      lastMilestoneActivityAt: sql<
        string | Date | null
      >`max(greatest(${engagementMilestones.startedAt}, ${engagementMilestones.completedAt}))`,
    })
    .from(engagementMilestones)
    .where(
      and(
        inArray(engagementMilestones.engagementId, engagementIds),
        isNull(engagementMilestones.deletedAt)
      )
    )
    .groupBy(engagementMilestones.engagementId);

  return new Map(
    aggregates.map((agg): [string, MilestoneProgressAgg] => {
      const rawActivity = agg.lastMilestoneActivityAt ?? null;
      let lastMilestoneActivityAt: Date | null = null;
      if (rawActivity !== null) {
        lastMilestoneActivityAt = rawActivity instanceof Date ? rawActivity : new Date(rawActivity);
      }
      return [
        agg.engagementId,
        {
          totalMilestones: agg.totalMilestones,
          completedMilestones: agg.completedMilestones,
          inProgressMilestones: agg.inProgressMilestones,
          lastMilestoneActivityAt,
        },
      ];
    })
  );
}

/**
 * The batched, counterpart-hydrated project graph behind `listPortfolio` — a
 * standalone module function so its INFERRED return type is the single source of
 * truth for `PortfolioProjectEngagementView`. Scope is the party lens: a company
 * (client), an expert profile (expert), or platform-wide (admin). Returns EVERY
 * non-deleted delivery status; the web loader owns render policy, the repo stays
 * policy-free.
 *
 * `eq(engagements.engagementType, 'project')` (D5) is what keeps Cases out of the
 * delivery inbox — a leaked Case would render a fabricated pricing pill and be counted
 * in the oversight tiles.
 */
function queryPortfolioProjectEngagements(
  scope: { companyId: string } | { expertProfileId: string } | { platform: true }
) {
  let scopeCondition: SQL | undefined;
  if ('companyId' in scope) {
    scopeCondition = eq(engagements.companyId, scope.companyId);
  } else if ('expertProfileId' in scope) {
    scopeCondition = eq(engagements.expertProfileId, scope.expertProfileId);
  }

  return db.query.engagements.findMany({
    where: and(
      eq(engagements.engagementType, 'project'),
      isNull(engagements.deletedAt),
      scopeCondition
    ),
    columns: {
      id: true,
      companyId: true,
      expertProfileId: true,
      activatedAt: true,
      createdAt: true,
      updatedAt: true,
    },
    with: {
      // SECURITY (mirrors queryProjectEngagementWithMilestones): explicit allow-lists
      // so this consumer-facing shape carries ONLY the counterpart identity an inbox
      // row needs (client name; expert person + avatar; agency name + logo) and
      // NEVER the secret/PII fields these full rows would otherwise bundle —
      // `stripeConnectId`, `workosId`, the expert's email/phone. A Server Action
      // can safely return this to a client component.
      company: { columns: { id: true, name: true } },
      expertProfile: {
        columns: { id: true, agencyId: true, type: true },
        with: {
          user: { columns: { id: true, firstName: true, lastName: true, avatarUrl: true } },
          agency: { columns: { id: true, name: true, logoUrl: true } },
        },
      },
      projectEngagement: {
        columns: {
          deliveryStatus: true,
          projectRequestId: true,
          changeRequestNote: true,
          changeRequestedAt: true,
          completionRequestedAt: true,
          acceptedAt: true,
          acceptanceMethod: true,
        },
        with: {
          projectRequest: { columns: { id: true, title: true } },
        },
      },
    },
  });
}

type PortfolioGraphRow = Awaited<ReturnType<typeof queryPortfolioProjectEngagements>>[number];

/** See `foldWorkspaceRow` — same flatten + hoist + status-last rule. */
function foldPortfolioRow(row: PortfolioGraphRow) {
  const child = row.projectEngagement;
  if (child === null) {
    throw new Error(`Project engagement child row missing: ${row.id}`);
  }
  const { projectEngagement: _child, ...parent } = row;
  const { deliveryStatus, projectRequest, ...childScalars } = child;
  return {
    ...parent,
    ...childScalars,
    projectRequest, // HOISTED grandchild
    status: deliveryStatus, // LAST
  };
}

/**
 * One A7 portfolio project row: the counterpart-hydrated identity graph plus
 * derived milestone-progress counts and a `lastActivityAt` recency proxy. The
 * web loader folds this into a delivery inbox row across all three lenses
 * (BAL-336). `projectRequest` is null for a retainer-shaped project.
 */
export type PortfolioProjectEngagementView = ReturnType<typeof foldPortfolioRow> & {
  totalMilestones: number;
  completedMilestones: number;
  inProgressMilestones: number;
  lastActivityAt: Date | null;
};

/**
 * The parties-hydrated read behind the admin oversight list (BAL-335) —
 * `listAllWithProgress`. A standalone module function so its INFERRED row type is
 * the single source of truth for `AdminProjectEngagementListItem`.
 *
 * `acceptedBy` / `cancelledBy` are nullable `one` relations over the existing actor FK
 * columns (now on the child) — NULL on the auto-accept path / when never cancelled —
 * hydrated name-only for retrospective attribution ("Accepted by {name} @ company",
 * "Cancelled by {name} @ Balo").
 *
 * `eq(engagements.engagementType, 'project')` (D5) is what keeps Cases out of admin
 * oversight — `derivePricingLabel` reads `pricingMethod`/`priceCents` unconditionally
 * and a leaked Case would render a fabricated "Fixed · A$0" pill.
 */
function queryProjectEngagementsWithParties() {
  return db.query.engagements.findMany({
    where: and(eq(engagements.engagementType, 'project'), isNull(engagements.deletedAt)),
    // SECURITY (BAL-417): explicit ROOT allow-list — NO `baloFeeBps` (the oversight
    // row reads `currency` but never grosses up), no `deleted_at`, no `engagement_type`.
    columns: {
      id: true,
      companyId: true,
      expertProfileId: true,
      currency: true,
      activatedAt: true,
      createdAt: true,
      updatedAt: true,
    },
    with: {
      company: { columns: { id: true, name: true } },
      // SECURITY: explicit columns — NEVER stripeConnectId / workosId / email / phone.
      expertProfile: {
        columns: { id: true, agencyId: true, type: true, headline: true },
        with: {
          user: { columns: { id: true, firstName: true, lastName: true, avatarUrl: true } },
          agency: { columns: { id: true, name: true, logoUrl: true } },
        },
      },
      projectEngagement: {
        columns: {
          deliveryStatus: true,
          projectRequestId: true,
          pricingMethod: true,
          priceCents: true,
          rateCents: true,
          completionRequestedAt: true,
          acceptedAt: true,
          acceptanceMethod: true,
          cancelledAt: true,
          cancellationReason: true,
        },
        with: {
          projectRequest: { columns: { id: true, title: true } },
          // Actor attribution — name + platformRole only (PII-safe), nullable relations.
          // `platformRole` (NOT PII) lets the web deriver name the actor's affiliation
          // from data (Balo staff vs client member vs expert) instead of hard-coding it.
          acceptedBy: {
            columns: { id: true, firstName: true, lastName: true, platformRole: true },
          },
          cancelledBy: {
            columns: { id: true, firstName: true, lastName: true, platformRole: true },
          },
        },
      },
    },
  });
}

type AdminGraphRow = Awaited<ReturnType<typeof queryProjectEngagementsWithParties>>[number];

/** See `foldWorkspaceRow` — same flatten + hoist + status-last rule. */
function foldAdminRow(row: AdminGraphRow) {
  const child = row.projectEngagement;
  if (child === null) {
    throw new Error(`Project engagement child row missing: ${row.id}`);
  }
  const { projectEngagement: _child, ...parent } = row;
  const { deliveryStatus, projectRequest, acceptedBy, cancelledBy, ...childScalars } = child;
  return {
    ...parent,
    ...childScalars,
    projectRequest, // HOISTED grandchild
    acceptedBy, // HOISTED grandchild
    cancelledBy, // HOISTED grandchild
    status: deliveryStatus, // LAST
  };
}

/**
 * A project hydrated with its parties (client company, expert person + nullable
 * agency, originating request) PLUS derived milestone progress counts and the
 * `lastActivityAt` proxy — one admin oversight list row (BAL-335). The web "stalled"
 * flag is a later derivation from `lastActivityAt` vs a threshold.
 */
export type AdminProjectEngagementListItem = ReturnType<typeof foldAdminRow> & {
  totalMilestones: number;
  completedMilestones: number;
  inProgressMilestones: number;
  lastActivityAt: Date | null;
};

export const projectEngagementsRepository = {
  /**
   * Create a project engagement — the durable delivery object and the A6 forward seam.
   *
   * THE SEAM: the origination provenance (`sourceProposalId`, `relationshipId`,
   * `projectRequestId`) is ALL OPTIONAL. A6.5 passes them (snapshotting the
   * accepted proposal's terms); a future retainer/embedded product passes NONE of
   * them — only `companyId` + `expertProfileId` + commercial terms — and the rows
   * are still created. "Expressible without a proposal/milestones" is literally
   * true.
   *
   * Commercial terms are SNAPSHOTTED here (copied at create), never read back via
   * FK. Defaults: `billingModel` 'proposal', `approvalModel` 'admin_invoice',
   * `deliveryStatus` 'active' (projecting to parent `status` 'active'),
   * `activatedAt` = `input.activatedAt ?? now`.
   *
   * ONE transaction, two inserts (parent then child) — a coherence failure or a
   * constraint violation leaves BOTH tables empty.
   *
   * CONTRACT — bare INSERT. Raw FK violation (23503) on an unknown `companyId` /
   * `expertProfileId` (both ON DELETE cascade) or a bad provenance id; CHECK
   * (23514) on a negative `priceCents`/`depositCents`/`rateCents`.
   */
  async create(input: {
    companyId: string;
    expertProfileId: string;
    sourceProposalId?: string;
    relationshipId?: string;
    projectRequestId?: string;
    pricingMethod: PricingMethod;
    priceCents: number;
    /**
     * Balo service margin snapshot (bps). OPTIONAL on this seam writer: a
     * retainer/embedded engagement has no proposal to snapshot from, so an omitted
     * value falls through to the column default (2500). `materializeFromKickoff`
     * (which always has an accepted proposal) requires it.
     */
    baloFeeBps?: number;
    currency?: string;
    depositCents?: number;
    rateCents?: number;
    cadence?: ProposalCadence;
    billingModel?: string;
    approvalModel?: string;
    activatedAt?: Date;
  }): Promise<ProjectEngagementRow> {
    assertTermsBeforeInsert(input);

    return db.transaction(async (tx) => {
      const parent = await insertEngagementRowTx(tx, {
        engagementType: 'project',
        companyId: input.companyId,
        expertProfileId: input.expertProfileId,
        currency: input.currency,
        baloFeeBps: input.baloFeeBps,
        activatedAt: input.activatedAt ?? new Date(),
      });

      const [child] = await tx
        .insert(projectEngagements)
        .values({
          engagementId: parent.id,
          sourceProposalId: input.sourceProposalId,
          relationshipId: input.relationshipId,
          projectRequestId: input.projectRequestId,
          pricingMethod: input.pricingMethod,
          priceCents: input.priceCents,
          depositCents: input.depositCents,
          rateCents: input.rateCents,
          cadence: input.cadence,
          billingModel: input.billingModel,
          approvalModel: input.approvalModel,
        })
        .returning();

      if (child === undefined) {
        throw new Error('Failed to create engagement');
      }
      return toProjectRow(parent, child);
    });
  },

  /**
   * The A6.5 accept→approve writer: in ONE transaction, advance an `accepted`
   * request to `kickoff_approved` AND materialise its project engagement
   * (snapshotting the passed terms). Locks the request FOR UPDATE first (serialising
   * concurrent approvals — the second caller sees `kickoff_approved` and is rejected).
   *
   * Guards, in order:
   *  - missing/soft-deleted request → `Error`
   *  - status is not `accepted` (or the edge to `kickoff_approved` is illegal) →
   *    `InvalidStatusTransitionError`
   *  - either persisted kickoff gate is still NULL → `KickoffGatesIncompleteError`
   *  - incoherent snapshotted terms → `EngagementTermsCoherenceError`
   *
   * The engagement's `billingModel`/`approvalModel`/`deliveryStatus`/`currency` come
   * from the table defaults (`'proposal'`/`'admin_invoice'`/`'active'`/`'aud'`) unless
   * `currency` is passed; `activatedAt` is set to now. Returns the materialised
   * project engagement plus the advanced request.
   */
  async materializeFromKickoff(input: {
    requestId: string;
    companyId: string;
    expertProfileId: string;
    sourceProposalId: string;
    relationshipId: string;
    /**
     * The approving admin (BAL-330). Recorded as the milestone snapshot author
     * (`engagement_milestones.created_by_user_id`) and the actor on the
     * `engagement.milestones_snapshotted` audit event. `admin.id` in the caller.
     */
    approvingAdminUserId: string;
    pricingMethod: PricingMethod;
    priceCents: number;
    baloFeeBps: number;
    currency?: string;
    depositCents?: number;
    rateCents?: number;
    cadence?: ProposalCadence;
  }): Promise<{ engagement: ProjectEngagementRow; request: ProjectRequest }> {
    return db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(projectRequests)
        .where(and(eq(projectRequests.id, input.requestId), isNull(projectRequests.deletedAt)))
        .for('update');

      if (current === undefined) {
        throw new Error(`Project request not found: ${input.requestId}`);
      }

      if (
        current.status !== 'accepted' ||
        !isAllowedTransition(current.status, 'kickoff_approved')
      ) {
        throw new InvalidStatusTransitionError(current.status, 'kickoff_approved');
      }

      if (current.clientBillingConfirmedAt === null || current.expertTermsConfirmedAt === null) {
        throw new KickoffGatesIncompleteError();
      }

      // COHERENCE (BAL-293): guard the snapshotted terms BEFORE the direct inserts.
      // This path BYPASSES `create`, so the shared guard MUST be invoked here too.
      // Throw → whole tx rolls back: request stays `accepted`, NEITHER engagement row.
      assertTermsBeforeInsert(input);

      const [request] = await tx
        .update(projectRequests)
        .set({ status: 'kickoff_approved' })
        .where(eq(projectRequests.id, input.requestId))
        .returning();

      if (request === undefined) {
        throw new Error(`Failed to advance request: ${input.requestId}`);
      }

      const parent = await insertEngagementRowTx(tx, {
        engagementType: 'project',
        companyId: input.companyId,
        expertProfileId: input.expertProfileId,
        currency: input.currency,
        baloFeeBps: input.baloFeeBps,
        activatedAt: new Date(),
      });

      const [child] = await tx
        .insert(projectEngagements)
        .values({
          engagementId: parent.id,
          sourceProposalId: input.sourceProposalId,
          relationshipId: input.relationshipId,
          projectRequestId: input.requestId,
          pricingMethod: input.pricingMethod,
          priceCents: input.priceCents,
          depositCents: input.depositCents,
          rateCents: input.rateCents,
          cadence: input.cadence,
        })
        .returning();

      if (child === undefined) {
        throw new Error('Failed to materialise engagement');
      }

      // BAL-330: snapshot the accepted proposal's live milestones into the new
      // engagement (same tx). A zero-milestone proposal → zero rows; the snapshot
      // audit still records `milestone_count: 0`. Milestones FK the SUPERTYPE id.
      const sources = await listByProposalTx(tx, input.sourceProposalId);
      await snapshotFromProposalTx(tx, {
        engagementId: parent.id,
        approvingAdminUserId: input.approvingAdminUserId,
        sources,
      });
      await recordDeliveryAudit(tx, {
        actorUserId: input.approvingAdminUserId,
        action: 'engagement.milestones_snapshotted',
        entityType: 'engagement',
        entityId: parent.id,
        engagementId: parent.id,
        metadata: { milestone_count: sources.length, source_proposal_id: input.sourceProposalId },
      });

      return { engagement: toProjectRow(parent, child), request };
    });
  },

  /**
   * The live project-engagement id for a source project request (BAL-331 deep-link
   * resolution). CHILD-ROOTED, joined to the LIVE parent — so it is project-only by
   * construction. At most one live project engagement per request
   * (`project_engagement_request_unique_idx`, partial on `project_request_id IS NOT
   * NULL AND deleted_at IS NULL`), so this is deterministic. Returns `undefined`
   * for retainers / not-yet-approved requests / soft-deleted engagements.
   */
  async findIdByProjectRequestId(projectRequestId: string): Promise<string | undefined> {
    const [row] = await db
      .select({ id: projectEngagements.engagementId })
      .from(projectEngagements)
      .innerJoin(engagements, eq(engagements.id, projectEngagements.engagementId))
      .where(
        and(
          eq(projectEngagements.projectRequestId, projectRequestId),
          isNull(projectEngagements.deletedAt),
          isNull(engagements.deletedAt)
        )
      )
      .limit(1);
    return row?.id;
  },

  /**
   * A live PROJECT hydrated with its LIVE milestones (ordered `sort_order` asc,
   * ties by id) and its expert (user + nullable agency — a freelancer gets
   * `agency: null`), FLATTENED. Returns `undefined` when the engagement is
   * missing/soft-deleted OR is not a project (a Case id 404s the project workspace).
   */
  async findWithMilestones(id: string): Promise<ProjectEngagementWithMilestones | undefined> {
    const row = await queryProjectEngagementWithMilestones(id);
    return row === undefined || row === null ? undefined : foldWorkspaceRow(row);
  },

  /** Live, ordered milestones for an engagement (delegates to the milestone repo). */
  async listMilestones(engagementId: string): Promise<EngagementMilestone[]> {
    return engagementMilestonesRepository.listByEngagement(engagementId);
  },

  /**
   * All non-deleted PROJECT engagements for a party lens (company / expert /
   * platform), counterpart-hydrated (company name, project-request title, expert
   * person + nullable agency) with derived milestone progress + a `lastActivityAt`
   * recency proxy, newest activity first. Returns EVERY non-deleted delivery status
   * (`active`, `pending_acceptance`, `completed`, `cancelled`) — the web A7 loader
   * owns render policy (excluding `completed` re-creates the "vanishes from inbox"
   * defect BAL-336 fixes; excluding `cancelled` leaves the client dedup rendering
   * a stale request row for a dead project). Two queries, independent of row count:
   * one relational graph + one grouped aggregate. Explicit `columns:` projections —
   * NEVER stripeConnectId / workosId / email / phone. Empty → `[]`.
   */
  async listPortfolio(
    scope: { companyId: string } | { expertProfileId: string } | { platform: true }
  ): Promise<PortfolioProjectEngagementView[]> {
    const rows = await queryPortfolioProjectEngagements(scope);
    if (rows.length === 0) {
      return [];
    }

    const folded = rows.map(foldPortfolioRow);
    const byId = await aggregateMilestoneProgress(folded.map((r) => r.id));

    const hydrated = folded.map((e) => {
      const agg = byId.get(e.id);
      const lastActivityAt = agg?.lastMilestoneActivityAt ?? e.activatedAt ?? e.createdAt;
      return {
        ...e,
        totalMilestones: agg?.totalMilestones ?? 0,
        completedMilestones: agg?.completedMilestones ?? 0,
        inProgressMilestones: agg?.inProgressMilestones ?? 0,
        lastActivityAt,
      };
    });

    hydrated.sort(
      (a, b) => (b.lastActivityAt?.getTime() ?? 0) - (a.lastActivityAt?.getTime() ?? 0)
    );
    return hydrated;
  },

  /**
   * The admin oversight list (BAL-335): EVERY non-deleted PROJECT engagement (all
   * delivery statuses) hydrated with its parties (client company, expert person +
   * nullable agency, originating request) and derived milestone progress. Per row:
   * `totalMilestones`, `completedMilestones`, `inProgressMilestones` (over LIVE
   * milestones), and `lastActivityAt = MAX(GREATEST(started_at, completed_at))` over
   * live milestones, falling back to `activated_at` / `created_at` when there is no
   * milestone activity. Ordered by `lastActivityAt` desc.
   *
   * `opts.statuses` (optional) narrows to those DELIVERY statuses. ⚠ THE NARROW IS
   * APPLIED IN JS, on the flattened rows, immediately after the fold and BEFORE the
   * progress aggregate (so the aggregate's id list is already narrowed). It cannot be
   * SQL here: the discriminating column lives on the CHILD, and putting a `where` on a
   * Drizzle `one` relation LEFT-joins — non-matching parents come back with
   * `projectEngagement: null` and would hit the fold's throw. IF A FUTURE CALLER NEEDS
   * SQL-LEVEL NARROWING ON A LARGE TABLE, rebuild this read as an explicit
   * `innerJoin(projectEngagements)` core query plus a second hydration pass — do NOT
   * add a `where` to the nested relation. Costs nothing today: the only production
   * caller passes no arguments.
   *
   * Excludes soft-deleted engagements and soft-deleted milestones. One batched
   * aggregate (no N+1). The parties projection is PII-safe.
   */
  async listAllWithProgress(opts?: {
    statuses?: readonly ProjectDeliveryStatus[];
  }): Promise<AdminProjectEngagementListItem[]> {
    const rows = await queryProjectEngagementsWithParties();
    if (rows.length === 0) {
      return [];
    }

    const folded = rows.map(foldAdminRow);
    const statuses = opts?.statuses;
    const narrowed =
      statuses !== undefined && statuses.length > 0
        ? folded.filter((r) => statuses.includes(r.status))
        : folded;
    if (narrowed.length === 0) {
      return [];
    }

    const progressById = await aggregateMilestoneProgress(narrowed.map((r) => r.id));

    const items = narrowed.map((row) => {
      const progress = progressById.get(row.id);
      const lastActivityAt = progress?.lastMilestoneActivityAt ?? row.activatedAt ?? row.createdAt;
      return {
        ...row,
        totalMilestones: progress?.totalMilestones ?? 0,
        completedMilestones: progress?.completedMilestones ?? 0,
        inProgressMilestones: progress?.inProgressMilestones ?? 0,
        lastActivityAt,
      };
    });

    items.sort((a, b) => (b.lastActivityAt?.getTime() ?? 0) - (a.lastActivityAt?.getTime() ?? 0));
    return items;
  },

  /**
   * The D7 auto-accept sweep source: live projects whose `delivery_status =
   * 'pending_acceptance'` and `completion_requested_at <= cutoff`, oldest request
   * first. The CALLER computes `cutoff = now - AUTO_ACCEPT_DAYS` (the repo stays
   * policy-free). CHILD-ROOTED, so it rides `project_engagement_delivery_completion_idx`
   * and is TYPE-SCOPED FOR FREE — a Case can never be selected by the sweep.
   */
  async listPendingAutoAccept(cutoff: Date): Promise<ProjectEngagementRow[]> {
    const rows = await db
      .select({ parent: engagements, child: projectEngagements })
      .from(projectEngagements)
      .innerJoin(engagements, eq(engagements.id, projectEngagements.engagementId))
      .where(
        and(
          eq(projectEngagements.deliveryStatus, 'pending_acceptance'),
          lte(projectEngagements.completionRequestedAt, cutoff),
          isNull(projectEngagements.deletedAt),
          isNull(engagements.deletedAt)
        )
      )
      .orderBy(asc(projectEngagements.completionRequestedAt));

    return rows.map((r) => toProjectRow(r.parent, r.child));
  },

  // ── Delivery lifecycle transitions (BAL-330) ───────────────────────────
  // All run in `db.transaction`, lock the PARENT engagement FOR UPDATE then the
  // child, and `recordDeliveryAudit(tx, …)` in the SAME tx as the state change.
  // audit_events (BAL-344) has no engagement_id column → the shared helper folds the
  // engagement id into `metadata.engagementId`.

  /**
   * The expert requests completion (active → pending_acceptance). Guards, under the
   * engagement lock: delivery status is `active` (else
   * `InvalidEngagementTransitionError`) AND every LIVE milestone is `completed`. A
   * ZERO-milestone project passes vacuously (the retainer/embedded seam) — this is
   * DELIBERATE. Any incomplete live milestone → `MilestonesIncompleteError` (nothing
   * mutated). Clears any prior `change_request_note`.
   *
   * NOTE the parent does NOT change: `pending_acceptance` projects to `'active'`.
   */
  async requestCompletion(input: {
    engagementId: string;
    userId: string;
  }): Promise<ProjectEngagementRow> {
    return db.transaction(async (tx) => {
      await lockProjectForTransition(tx, input.engagementId, 'pending_acceptance');

      // Under the engagement lock (single-writer gate): read live milestones and
      // require every one completed. Zero milestones ⇒ vacuously allowed.
      const liveMilestones = await tx
        .select({ status: engagementMilestones.status })
        .from(engagementMilestones)
        .where(
          and(
            eq(engagementMilestones.engagementId, input.engagementId),
            isNull(engagementMilestones.deletedAt)
          )
        );
      const outstanding = liveMilestones.filter((m) => m.status !== 'completed').length;
      if (outstanding > 0) {
        throw new MilestonesIncompleteError(input.engagementId, outstanding);
      }

      const advanced = await advanceProjectDelivery(tx, {
        engagementId: input.engagementId,
        to: 'pending_acceptance',
        expectedFrom: 'active',
        set: {
          completionRequestedByUserId: input.userId,
          completionRequestedAt: new Date(),
          changeRequestNote: null,
        },
      });

      await recordDeliveryAudit(tx, {
        actorUserId: input.userId,
        action: 'engagement.completion_requested',
        entityType: 'engagement',
        entityId: input.engagementId,
        engagementId: input.engagementId,
        metadata: { from: 'active', to: 'pending_acceptance' },
      });
      return advanced;
    });
  },

  /**
   * Withdraw a completion request (pending_acceptance → active). Clears the
   * completion-request stamps. Illegal from any non-`pending_acceptance` delivery
   * status (`InvalidEngagementTransitionError`, via `expectedFrom`).
   */
  async withdrawCompletionRequest(input: {
    engagementId: string;
    userId: string;
  }): Promise<ProjectEngagementRow> {
    return db.transaction(async (tx) => {
      const advanced = await advanceProjectDelivery(tx, {
        engagementId: input.engagementId,
        to: 'active',
        expectedFrom: 'pending_acceptance',
        set: {
          completionRequestedByUserId: null,
          completionRequestedAt: null,
        },
      });

      await recordDeliveryAudit(tx, {
        actorUserId: input.userId,
        action: 'engagement.completion_withdrawn',
        entityType: 'engagement',
        entityId: input.engagementId,
        engagementId: input.engagementId,
        metadata: { from: 'pending_acceptance', to: 'active' },
      });
      return advanced;
    });
  },

  /**
   * Accept a completion request (pending_acceptance → completed). Discriminated
   * union: the `client` path carries the accepting `userId`; the `auto` path
   * (D7 sweep) type-CANNOT supply a user — `accepted_by_user_id` and the audit actor
   * are both NULL. `accepted_at` is the completion timestamp (no `completed_at`).
   *
   * The clearest two-table write: the child gets the acceptance stamps, the PARENT
   * flips to `'completed'`.
   */
  async acceptCompletion(
    input: { engagementId: string } & ({ method: 'client'; userId: string } | { method: 'auto' })
  ): Promise<ProjectEngagementRow> {
    return db.transaction(async (tx) => {
      const actorUserId = input.method === 'client' ? input.userId : null;

      const advanced = await advanceProjectDelivery(tx, {
        engagementId: input.engagementId,
        to: 'completed',
        expectedFrom: 'pending_acceptance',
        set: {
          acceptedByUserId: actorUserId,
          acceptedAt: new Date(),
          acceptanceMethod: input.method,
        },
      });

      await recordDeliveryAudit(tx, {
        actorUserId,
        action: 'engagement.accepted',
        entityType: 'engagement',
        entityId: input.engagementId,
        engagementId: input.engagementId,
        metadata: { from: 'pending_acceptance', to: 'completed', acceptance_method: input.method },
      });
      return advanced;
    });
  },

  /**
   * The client requests changes instead of accepting (pending_acceptance → active).
   * Stores the note + attribution and clears the completion-request stamps. `note`
   * is required by the type (emptiness is validated at the web boundary). Illegal
   * from any non-`pending_acceptance` delivery status.
   */
  async requestChanges(input: {
    engagementId: string;
    userId: string;
    note: string;
  }): Promise<ProjectEngagementRow> {
    return db.transaction(async (tx) => {
      const advanced = await advanceProjectDelivery(tx, {
        engagementId: input.engagementId,
        to: 'active',
        expectedFrom: 'pending_acceptance',
        set: {
          changeRequestNote: input.note,
          changeRequestedByUserId: input.userId,
          changeRequestedAt: new Date(),
          completionRequestedByUserId: null,
          completionRequestedAt: null,
        },
      });

      await recordDeliveryAudit(tx, {
        actorUserId: input.userId,
        action: 'engagement.changes_requested',
        entityType: 'engagement',
        entityId: input.engagementId,
        engagementId: input.engagementId,
        metadata: { from: 'pending_acceptance', to: 'active', note: input.note },
      });
      return advanced;
    });
  },

  /**
   * Cancel a project (active | pending_acceptance → cancelled). Captures the
   * `from` delivery status under the lock for the audit metadata; NO `expectedFrom`
   * (two legal sources). Terminal statuses (completed/cancelled) →
   * `InvalidEngagementTransitionError`. `reason` is required by the type.
   *
   * PROJECT-ONLY: a Case's terminal state is `completed` + `closed_*`, never
   * `cancelled`, so `engagements.status = 'cancelled'` has exactly one writer and it
   * is this one.
   */
  async cancelEngagement(input: {
    engagementId: string;
    userId: string;
    reason: string;
  }): Promise<ProjectEngagementRow> {
    return db.transaction(async (tx) => {
      const { child } = await lockProjectForTransition(tx, input.engagementId, 'cancelled');
      const from = child.deliveryStatus;

      const advanced = await advanceProjectDelivery(tx, {
        engagementId: input.engagementId,
        to: 'cancelled',
        set: {
          cancelledByUserId: input.userId,
          cancelledAt: new Date(),
          cancellationReason: input.reason,
        },
      });

      await recordDeliveryAudit(tx, {
        actorUserId: input.userId,
        action: 'engagement.cancelled',
        entityType: 'engagement',
        entityId: input.engagementId,
        engagementId: input.engagementId,
        metadata: { from, to: 'cancelled', reason: input.reason },
      });
      return advanced;
    });
  },
};

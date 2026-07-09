import { and, asc, desc, eq, inArray, isNull, lte, sql, type SQL } from 'drizzle-orm';
import { db } from '../client';
import {
  engagementMilestones,
  engagements,
  projectRequests,
  type Engagement,
  type EngagementMilestone,
  type ProjectRequest,
} from '../schema';
import type { PricingMethod, ProposalCadence } from './proposal-types';
import { isAllowedTransition, InvalidStatusTransitionError } from './project-requests';
import { assertEngagementTermsCoherent } from './proposal-coherence';
import { listByProposalTx } from './proposal-milestones';
import { engagementMilestonesRepository, snapshotFromProposalTx } from './engagement-milestones';
import { recordDeliveryAudit } from './_shared/delivery-audit';

/** Active transaction handle (matches `advanceProposalStatus` in proposals.ts). */
type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Engagement status, derived from the schema column (single source of truth). */
export type EngagementStatus = Engagement['status'];

/**
 * COHERENCE (BAL-293): assert an engagement's snapshotted commercial terms are
 * coherent (header-only: `price_negative` / `deposit_negative` / `tm_missing_rate`)
 * BEFORE the row is inserted. Shared by BOTH write paths (`create` and
 * `materializeFromKickoff`, which BYPASSES `create` and inserts directly) so
 * neither can drift — both MUST call it. Throws `EngagementTermsCoherenceError`.
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

// ── Delivery lifecycle transitions (BAL-330) ─────────────────────────────
//
// Mirrors the proposal transition pattern (proposals.ts): a `Record` transition
// map + `isAllowed*Transition` guard + typed `Invalid*TransitionError` + a shared
// `advance*Status(tx, …)` writer composable inside any caller's transaction.
//
// COMPLETED_AT SEMANTICS: there is NO `engagements.completed_at`. A completed
// engagement's completion timestamp IS `accepted_at` (client or auto); any "completed
// on" display derives from `accepted_at` where `status = 'completed'`.
//
// LOCK ORDER: every transition locks the engagement row FOR UPDATE first (and every
// milestone transition locks the engagement before the milestone), so the engagement
// lock is a single-writer gate over the whole engagement. Never lock a milestone
// before its engagement (deadlock hazard).

/**
 * Allowed engagement status transitions (BAL-330).
 *
 *   active             → pending_acceptance (requestCompletion) | cancelled
 *   pending_acceptance → active (withdraw / requestChanges) | completed (accept) | cancelled
 *   completed          → []  terminal
 *   cancelled          → []  terminal
 *
 * Ordering carries no semantics — this map is the single source of truth.
 */
export const ENGAGEMENT_STATUS_TRANSITIONS: Record<EngagementStatus, readonly EngagementStatus[]> =
  {
    active: ['pending_acceptance', 'cancelled'],
    pending_acceptance: ['active', 'completed', 'cancelled'],
    completed: [],
    cancelled: [],
  };

export function isAllowedEngagementTransition(
  from: EngagementStatus,
  to: EngagementStatus
): boolean {
  return ENGAGEMENT_STATUS_TRANSITIONS[from].includes(to);
}

export class InvalidEngagementTransitionError extends Error {
  constructor(
    public readonly from: EngagementStatus,
    public readonly to: EngagementStatus
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
 * D7 auto-accept window: a `pending_acceptance` engagement auto-accepts this many
 * days after the completion request. Consumed only in D7 (the sweep computes
 * `cutoff = now - AUTO_ACCEPT_DAYS` and passes it to `listPendingAutoAccept`) — D0
 * defines it and keeps the repo policy-free. Plain typed const, mirroring
 * `QUIET_THRESHOLD_DAYS` (not a Zod module).
 *
 * FOOTGUN (memory `reference_balo_db_client_bundle_footgun`): do NOT value-import
 * this into a web *client* component — `@balo/db`'s barrel re-exports `postgres` and
 * breaks `next build`. If a later slice needs to DISPLAY the window client-side, lift
 * it to a pure `@balo/shared` subpath there.
 */
export const AUTO_ACCEPT_DAYS = 7;

/**
 * Shared engagement transition writer. Locks the LIVE engagement FOR UPDATE,
 * validates against `ENGAGEMENT_STATUS_TRANSITIONS` (+ optional `expectedFrom`),
 * applies `{ status: to, ...set }`, returns the row. Exported so cross-cutting
 * writers advance the engagement inside their own transaction atomically with the
 * audit write — mirrors `advanceProposalStatus`.
 *
 * `tx` is the active transaction. Throws `InvalidEngagementTransitionError` for
 * illegal moves / `expectedFrom` mismatch and `Error` for a missing/soft-deleted
 * engagement.
 */
export async function advanceEngagementStatus(
  tx: DbTx,
  input: {
    id: string;
    to: EngagementStatus;
    expectedFrom?: EngagementStatus;
    set?: Partial<typeof engagements.$inferInsert>;
  }
): Promise<Engagement> {
  const [current] = await tx
    .select()
    .from(engagements)
    .where(and(eq(engagements.id, input.id), isNull(engagements.deletedAt)))
    .for('update');

  if (current === undefined) {
    throw new Error(`Engagement not found: ${input.id}`);
  }

  if (input.expectedFrom !== undefined && current.status !== input.expectedFrom) {
    throw new InvalidEngagementTransitionError(current.status, input.to);
  }

  if (!isAllowedEngagementTransition(current.status, input.to)) {
    throw new InvalidEngagementTransitionError(current.status, input.to);
  }

  const [updated] = await tx
    .update(engagements)
    .set({ status: input.to, ...input.set })
    .where(eq(engagements.id, input.id))
    .returning();

  if (updated === undefined) {
    throw new Error(`Failed to update engagement: ${input.id}`);
  }

  return updated;
}

/**
 * Lock the LIVE engagement FOR UPDATE and validate that `→ to` is a legal move from
 * its current status, returning the locked row. Shared pre-step of the transitions
 * that must inspect the current row BEFORE the flip (`requestCompletion` reads live
 * milestones under this lock; `cancelEngagement` captures the `from` status).
 * `advanceEngagementStatus` then re-locks the same row reentrantly in the same tx.
 * Throws `Error` (missing/soft-deleted) / `InvalidEngagementTransitionError`.
 */
async function lockEngagementForTransition(
  tx: DbTx,
  engagementId: string,
  to: EngagementStatus
): Promise<Engagement> {
  const [current] = await tx
    .select()
    .from(engagements)
    .where(and(eq(engagements.id, engagementId), isNull(engagements.deletedAt)))
    .for('update');

  if (current === undefined) {
    throw new Error(`Engagement not found: ${engagementId}`);
  }
  if (!isAllowedEngagementTransition(current.status, to)) {
    throw new InvalidEngagementTransitionError(current.status, to);
  }
  return current;
}

/**
 * The hydrated engagement + live milestones + expert (with user + nullable agency)
 * graph behind `findEngagementWithMilestones`. A standalone module function so its
 * INFERRED return type is the single source of truth for `EngagementWithMilestones`
 * (mirrors projects-inbox's `PortfolioRequestRow`). `agency` is a LEFT-JOIN `one`
 * relation → `Agency | null` (a freelancer expert has `agency: null`; the caller
 * falls back to the expert's own name).
 */
function queryEngagementWithMilestones(id: string) {
  return db.query.engagements.findFirst({
    where: and(eq(engagements.id, id), isNull(engagements.deletedAt)),
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
      projectRequest: { columns: { id: true, title: true } },
      acceptedBy: { columns: { id: true, firstName: true, lastName: true } },
      changeRequestedBy: { columns: { id: true, firstName: true, lastName: true } },
    },
  });
}

/** Live engagement + its live milestones + expert (user + nullable agency). */
export type EngagementWithMilestones = NonNullable<
  Awaited<ReturnType<typeof queryEngagementWithMilestones>>
>;

/**
 * An active engagement plus derived milestone progress counts and a
 * `lastActivityAt` proxy (the later web "stalled" flag is DERIVED from
 * `lastActivityAt` vs a threshold — D0 exposes only the raw signal).
 */
export type EngagementWithProgress = Engagement & {
  totalMilestones: number;
  completedMilestones: number;
  inProgressMilestones: number;
  lastActivityAt: Date | null;
};

/** Derived milestone-progress counts + a `lastActivityAt` proxy for one engagement. */
interface MilestoneProgressAgg {
  totalMilestones: number;
  completedMilestones: number;
  inProgressMilestones: number;
  lastMilestoneActivityAt: Date | null;
}

/**
 * ONE batched grouped milestone aggregate over the given engagement ids →
 * a Map keyed by engagement id. Shared by `listActiveWithProgress`,
 * `listPortfolioEngagements`, AND `listAllWithProgress` (dedup, not copy — keeps the
 * Sonar new-code duplication gate green). Counts live milestones only; `lastMilestoneActivityAt
 * = MAX(GREATEST(started_at, completed_at))` is NULL only when no live milestone
 * has any activity (GREATEST ignores NULLs). The raw-SQL activity aggregate is
 * coerced string→Date here (Drizzle does NOT apply the timestamptz→Date codec to
 * a `sql` fragment). Empty ids → empty Map.
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
 * The batched, counterpart-hydrated engagement graph behind
 * `listPortfolioEngagements` — a standalone module function so its INFERRED
 * return type is the single source of truth for `PortfolioEngagementView`
 * (mirrors `queryEngagementWithMilestones`). Scope is the party lens: a company
 * (client), an expert profile (expert), or platform-wide (admin — no party
 * scope, mirroring `listAll`). Returns EVERY non-deleted status; the web loader
 * owns render policy, the repo stays policy-free.
 */
function queryPortfolioEngagements(
  scope: { companyId: string } | { expertProfileId: string } | { platform: true }
) {
  let scopeCondition: SQL | undefined;
  if ('companyId' in scope) {
    scopeCondition = eq(engagements.companyId, scope.companyId);
  } else if ('expertProfileId' in scope) {
    scopeCondition = eq(engagements.expertProfileId, scope.expertProfileId);
  }

  return db.query.engagements.findMany({
    where: and(isNull(engagements.deletedAt), scopeCondition),
    columns: {
      id: true,
      companyId: true,
      expertProfileId: true,
      projectRequestId: true,
      status: true,
      changeRequestNote: true,
      changeRequestedAt: true,
      completionRequestedAt: true,
      acceptedAt: true,
      acceptanceMethod: true,
      activatedAt: true,
      createdAt: true,
      updatedAt: true,
    },
    with: {
      // SECURITY (mirrors queryEngagementWithMilestones): explicit allow-lists so
      // this consumer-facing shape carries ONLY the counterpart identity an inbox
      // row needs (client name; expert person + avatar; agency name + logo) and
      // NEVER the secret/PII fields these full rows would otherwise bundle —
      // `stripeConnectId`, `workosId`, the expert's email/phone. A Server Action
      // can safely return this to a client component.
      company: { columns: { id: true, name: true } },
      projectRequest: { columns: { id: true, title: true } },
      expertProfile: {
        columns: { id: true, agencyId: true, type: true },
        with: {
          user: { columns: { id: true, firstName: true, lastName: true, avatarUrl: true } },
          agency: { columns: { id: true, name: true, logoUrl: true } },
        },
      },
    },
  });
}

/** The hydrated identity graph element (non-null — `findMany` rows). */
type PortfolioEngagementIdentity = Awaited<ReturnType<typeof queryPortfolioEngagements>>[number];

/**
 * One A7 portfolio engagement row: the counterpart-hydrated identity graph plus
 * derived milestone-progress counts and a `lastActivityAt` recency proxy. The
 * web loader folds this into a delivery inbox row across all three lenses
 * (BAL-336). `projectRequest` is null for a retainer engagement.
 */
export type PortfolioEngagementView = PortfolioEngagementIdentity & {
  totalMilestones: number;
  completedMilestones: number;
  inProgressMilestones: number;
  lastActivityAt: Date | null;
};

/**
 * The parties-hydrated read behind the admin oversight list (BAL-335) —
 * `listAllWithProgress`. A standalone module function so its INFERRED row type is
 * the single source of truth for `EngagementWithParties` / `AdminEngagementListItem`
 * (mirrors `queryEngagementWithMilestones`).
 *
 * `acceptedBy` / `cancelledBy` are nullable `one` relations over the
 * existing actor FK columns — NULL on the auto-accept path / when never cancelled —
 * hydrated name-only for retrospective attribution ("Accepted by {name} @ company",
 * "Cancelled by {name} @ Balo").
 *
 * `statuses`: when non-empty, narrows to those engagement statuses (`inArray`);
 * omitted → every non-deleted engagement. Always filters `isNull(deletedAt)`.
 */
function queryEngagementsWithParties(statuses?: readonly EngagementStatus[]) {
  const statusFilter =
    statuses && statuses.length > 0 ? inArray(engagements.status, [...statuses]) : undefined;
  return db.query.engagements.findMany({
    where: and(isNull(engagements.deletedAt), statusFilter),
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
  });
}

type EngagementWithParties = Awaited<ReturnType<typeof queryEngagementsWithParties>>[number];

/**
 * An engagement hydrated with its parties (client company, expert person +
 * nullable agency, originating request) PLUS derived milestone progress counts and
 * the `lastActivityAt` proxy — one admin oversight list row (BAL-335). The web
 * "stalled" flag is a later derivation from `lastActivityAt` vs a threshold.
 */
export type AdminEngagementListItem = EngagementWithParties & {
  totalMilestones: number;
  completedMilestones: number;
  inProgressMilestones: number;
  lastActivityAt: Date | null;
};

export const engagementsRepository = {
  /**
   * Create an engagement — the durable delivery object and the A6 forward seam.
   *
   * THE SEAM: the origination provenance (`sourceProposalId`, `relationshipId`,
   * `projectRequestId`) is ALL OPTIONAL. A6.5 passes them (snapshotting the
   * accepted proposal's terms); a future retainer/embedded product passes NONE of
   * them — only `companyId` + `expertProfileId` + commercial terms — and the row
   * is still created. "Expressible without a proposal/milestones" is literally
   * true.
   *
   * Commercial terms are SNAPSHOTTED here (copied at create), never read back via
   * FK. Defaults: `billingModel` 'proposal', `approvalModel` 'admin_invoice',
   * `status` 'active', `activatedAt` = `input.activatedAt ?? now` (an `active`
   * engagement is activated now unless the caller overrides).
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
  }): Promise<Engagement> {
    assertTermsBeforeInsert(input);

    const [row] = await db
      .insert(engagements)
      .values({
        companyId: input.companyId,
        expertProfileId: input.expertProfileId,
        pricingMethod: input.pricingMethod,
        priceCents: input.priceCents,
        baloFeeBps: input.baloFeeBps,
        activatedAt: input.activatedAt ?? new Date(),
        sourceProposalId: input.sourceProposalId,
        relationshipId: input.relationshipId,
        projectRequestId: input.projectRequestId,
        currency: input.currency,
        depositCents: input.depositCents,
        rateCents: input.rateCents,
        cadence: input.cadence,
        billingModel: input.billingModel,
        approvalModel: input.approvalModel,
      })
      .returning();
    if (row === undefined) {
      throw new Error('Failed to create engagement');
    }
    return row;
  },

  /**
   * The A6.5 accept→approve writer: in ONE transaction, advance an `accepted`
   * request to `kickoff_approved` AND materialise its engagement (snapshotting
   * the passed terms). Locks the request FOR UPDATE first (serialising concurrent
   * approvals — the second caller sees `kickoff_approved` and is rejected).
   *
   * Guards, in order:
   *  - missing/soft-deleted request → `Error`
   *  - status is not `accepted` (or the edge to `kickoff_approved` is illegal) →
   *    `InvalidStatusTransitionError`
   *  - either persisted kickoff gate is still NULL → `KickoffGatesIncompleteError`
   *
   * The engagement's `billingModel`/`approvalModel`/`status`/`currency` come from
   * the table defaults (`'proposal'`/`'admin_invoice'`/`'active'`/`'aud'`) unless
   * `currency` is passed; `activatedAt` is set to now (an approved engagement is
   * active now). Returns the materialised engagement plus the advanced request.
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
  }): Promise<{ engagement: Engagement; request: ProjectRequest }> {
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

      // COHERENCE (BAL-293): guard the snapshotted terms BEFORE the direct insert.
      // This path BYPASSES `create`, so the shared guard MUST be invoked here too.
      // Throw → whole tx rolls back: request stays `accepted`, no engagement row.
      assertTermsBeforeInsert(input);

      const [request] = await tx
        .update(projectRequests)
        .set({ status: 'kickoff_approved' })
        .where(eq(projectRequests.id, input.requestId))
        .returning();

      if (request === undefined) {
        throw new Error(`Failed to advance request: ${input.requestId}`);
      }

      const [engagement] = await tx
        .insert(engagements)
        .values({
          companyId: input.companyId,
          expertProfileId: input.expertProfileId,
          sourceProposalId: input.sourceProposalId,
          relationshipId: input.relationshipId,
          projectRequestId: input.requestId,
          pricingMethod: input.pricingMethod,
          priceCents: input.priceCents,
          baloFeeBps: input.baloFeeBps,
          currency: input.currency,
          depositCents: input.depositCents,
          rateCents: input.rateCents,
          cadence: input.cadence,
          activatedAt: new Date(),
        })
        .returning();

      if (engagement === undefined) {
        throw new Error('Failed to materialise engagement');
      }

      // BAL-330: snapshot the accepted proposal's live milestones into the new
      // engagement (same tx). A zero-milestone proposal → zero rows; the snapshot
      // audit still records `milestone_count: 0`.
      const sources = await listByProposalTx(tx, input.sourceProposalId);
      await snapshotFromProposalTx(tx, {
        engagementId: engagement.id,
        approvingAdminUserId: input.approvingAdminUserId,
        sources,
      });
      await recordDeliveryAudit(tx, {
        actorUserId: input.approvingAdminUserId,
        action: 'engagement.milestones_snapshotted',
        entityType: 'engagement',
        entityId: engagement.id,
        engagementId: engagement.id,
        metadata: { milestone_count: sources.length, source_proposal_id: input.sourceProposalId },
      });

      return { engagement, request };
    });
  },

  /** Live engagement by id. */
  async findById(id: string): Promise<Engagement | undefined> {
    return db.query.engagements.findFirst({
      where: and(eq(engagements.id, id), isNull(engagements.deletedAt)),
    });
  },

  /**
   * The live engagement id for a source project request (BAL-331 deep-link
   * resolution). At most one live engagement per request
   * (`engagement_request_unique_idx`, partial on `project_request_id IS NOT NULL
   * AND deleted_at IS NULL`), so `findFirst` is deterministic. Returns `undefined`
   * for retainers / not-yet-approved requests / soft-deleted engagements.
   */
  async findIdByProjectRequestId(projectRequestId: string): Promise<string | undefined> {
    const row = await db.query.engagements.findFirst({
      where: and(eq(engagements.projectRequestId, projectRequestId), isNull(engagements.deletedAt)),
      columns: { id: true },
    });
    return row?.id;
  },

  /** Live engagements for a company, newest first. */
  async listByCompany(companyId: string): Promise<Engagement[]> {
    return db
      .select()
      .from(engagements)
      .where(and(eq(engagements.companyId, companyId), isNull(engagements.deletedAt)))
      .orderBy(desc(engagements.createdAt));
  },

  // ── Delivery lifecycle transitions (BAL-330) ───────────────────────────
  // All run in `db.transaction`, lock the engagement FOR UPDATE, and
  // `recordDeliveryAudit(tx, …)` in the SAME tx as the state change. audit_events
  // (BAL-344) has no engagement_id column → the shared helper folds the engagement
  // id into `metadata.engagementId`.

  /**
   * The expert requests completion (active → pending_acceptance). Guards, under the
   * engagement lock: status is `active` (else `InvalidEngagementTransitionError`)
   * AND every LIVE milestone is `completed`. A ZERO-milestone engagement passes
   * vacuously (the retainer/embedded seam) — this is DELIBERATE. Any incomplete live
   * milestone → `MilestonesIncompleteError` (nothing mutated). Clears any prior
   * `change_request_note`.
   */
  async requestCompletion(input: { engagementId: string; userId: string }): Promise<Engagement> {
    return db.transaction(async (tx) => {
      await lockEngagementForTransition(tx, input.engagementId, 'pending_acceptance');

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

      const advanced = await advanceEngagementStatus(tx, {
        id: input.engagementId,
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
   * completion-request stamps. Illegal from any non-`pending_acceptance` status
   * (`InvalidEngagementTransitionError`, via `expectedFrom`).
   */
  async withdrawCompletionRequest(input: {
    engagementId: string;
    userId: string;
  }): Promise<Engagement> {
    return db.transaction(async (tx) => {
      const advanced = await advanceEngagementStatus(tx, {
        id: input.engagementId,
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
   */
  async acceptCompletion(
    input: { engagementId: string } & ({ method: 'client'; userId: string } | { method: 'auto' })
  ): Promise<Engagement> {
    return db.transaction(async (tx) => {
      const actorUserId = input.method === 'client' ? input.userId : null;

      const advanced = await advanceEngagementStatus(tx, {
        id: input.engagementId,
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
   * from any non-`pending_acceptance` status.
   */
  async requestChanges(input: {
    engagementId: string;
    userId: string;
    note: string;
  }): Promise<Engagement> {
    return db.transaction(async (tx) => {
      const advanced = await advanceEngagementStatus(tx, {
        id: input.engagementId,
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
   * Cancel an engagement (active | pending_acceptance → cancelled). Captures the
   * `from` status under the lock for the audit metadata; NO `expectedFrom` (two
   * legal sources). Terminal statuses (completed/cancelled) →
   * `InvalidEngagementTransitionError`. `reason` is required by the type.
   */
  async cancelEngagement(input: {
    engagementId: string;
    userId: string;
    reason: string;
  }): Promise<Engagement> {
    return db.transaction(async (tx) => {
      const current = await lockEngagementForTransition(tx, input.engagementId, 'cancelled');
      const from = current.status;

      const advanced = await advanceEngagementStatus(tx, {
        id: input.engagementId,
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

  // ── Delivery reads (BAL-330) ───────────────────────────────────────────

  /**
   * A live engagement hydrated with its LIVE milestones (ordered `sort_order` asc,
   * ties by id) and its expert (user + nullable agency — a freelancer gets
   * `agency: null`). Returns `undefined` when the engagement is missing/soft-deleted.
   */
  async findEngagementWithMilestones(id: string): Promise<EngagementWithMilestones | undefined> {
    const row = await queryEngagementWithMilestones(id);
    return row ?? undefined;
  },

  /** Live, ordered milestones for an engagement (delegates to the milestone repo). */
  async listMilestones(engagementId: string): Promise<EngagementMilestone[]> {
    return engagementMilestonesRepository.listByEngagement(engagementId);
  },

  /**
   * Active engagements for a party (company OR expert) with derived milestone
   * progress. Per engagement: `totalMilestones`, `completedMilestones`,
   * `inProgressMilestones` (over LIVE milestones), and `lastActivityAt =
   * MAX(GREATEST(started_at, completed_at))` over live milestones, falling back to
   * the engagement's `activated_at` / `created_at` when there is no milestone
   * activity. Ordered by `lastActivityAt` desc. Excludes non-active engagements and
   * soft-deleted milestones. (The "stalled" flag is a later web derivation from
   * `lastActivityAt`.)
   */
  async listActiveWithProgress(
    scope: { companyId: string } | { expertProfileId: string }
  ): Promise<EngagementWithProgress[]> {
    const scopeCondition =
      'companyId' in scope
        ? eq(engagements.companyId, scope.companyId)
        : eq(engagements.expertProfileId, scope.expertProfileId);

    const activeEngagements = await db
      .select()
      .from(engagements)
      .where(and(eq(engagements.status, 'active'), isNull(engagements.deletedAt), scopeCondition));

    if (activeEngagements.length === 0) {
      return [];
    }

    const byEngagement = await aggregateMilestoneProgress(activeEngagements.map((e) => e.id));

    const rows = activeEngagements.map((engagement) => {
      const agg = byEngagement.get(engagement.id);
      const lastActivityAt =
        agg?.lastMilestoneActivityAt ?? engagement.activatedAt ?? engagement.createdAt;
      return {
        ...engagement,
        totalMilestones: agg?.totalMilestones ?? 0,
        completedMilestones: agg?.completedMilestones ?? 0,
        inProgressMilestones: agg?.inProgressMilestones ?? 0,
        lastActivityAt,
      };
    });

    rows.sort((a, b) => (b.lastActivityAt?.getTime() ?? 0) - (a.lastActivityAt?.getTime() ?? 0));
    return rows;
  },

  /**
   * All non-deleted engagements for a party lens (company / expert / platform),
   * counterpart-hydrated (company name, project-request title, expert person +
   * nullable agency) with derived milestone progress + a `lastActivityAt` recency
   * proxy, newest activity first. Returns EVERY non-deleted status (`active`,
   * `pending_acceptance`, `completed`, `cancelled`) — the web A7 loader owns
   * render policy (excluding `completed` re-creates the "vanishes from inbox"
   * defect BAL-336 fixes; excluding `cancelled` leaves the client dedup rendering
   * a stale request row for a dead project). Two queries, independent of row
   * count: one relational graph + one grouped aggregate. Explicit `columns:`
   * projections — NEVER stripeConnectId / workosId / email / phone. Empty → `[]`.
   */
  async listPortfolioEngagements(
    scope: { companyId: string } | { expertProfileId: string } | { platform: true }
  ): Promise<PortfolioEngagementView[]> {
    const rows = await queryPortfolioEngagements(scope);
    if (rows.length === 0) {
      return [];
    }

    const byId = await aggregateMilestoneProgress(rows.map((r) => r.id));

    const hydrated = rows.map((e) => {
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
   * The admin oversight list (BAL-335): EVERY non-deleted engagement (all statuses)
   * hydrated with its parties (client company, expert person + nullable agency,
   * originating request) and derived milestone progress. Per engagement:
   * `totalMilestones`, `completedMilestones`, `inProgressMilestones` (over LIVE
   * milestones), and `lastActivityAt = MAX(GREATEST(started_at, completed_at))` over
   * live milestones, falling back to `activated_at` / `created_at` when there is no
   * milestone activity. Ordered by `lastActivityAt` desc.
   *
   * `opts.statuses` (optional) narrows to those statuses (`inArray`) — kept for the
   * v2 stalled-nudge derivation; the oversight loader passes none (all statuses).
   * Excludes soft-deleted engagements and soft-deleted milestones. One batched
   * aggregate (no N+1). The parties projection is PII-safe — see
   * `queryEngagementsWithParties`.
   */
  async listAllWithProgress(opts?: {
    statuses?: readonly EngagementStatus[];
  }): Promise<AdminEngagementListItem[]> {
    const rows = await queryEngagementsWithParties(opts?.statuses);
    if (rows.length === 0) {
      return [];
    }

    const progressById = await aggregateMilestoneProgress(rows.map((r) => r.id));

    const items = rows.map((row) => {
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
   * The D7 auto-accept sweep source: live engagements `status = 'pending_acceptance'`
   * whose `completion_requested_at <= cutoff`, oldest request first. The CALLER
   * computes `cutoff = now - AUTO_ACCEPT_DAYS` (the repo stays policy-free). Rides
   * `engagement_status_completion_requested_idx`.
   */
  async listPendingAutoAccept(cutoff: Date): Promise<Engagement[]> {
    return db
      .select()
      .from(engagements)
      .where(
        and(
          eq(engagements.status, 'pending_acceptance'),
          lte(engagements.completionRequestedAt, cutoff),
          isNull(engagements.deletedAt)
        )
      )
      .orderBy(asc(engagements.completionRequestedAt));
  },
};

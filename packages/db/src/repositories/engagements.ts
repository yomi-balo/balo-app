import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from '../client';
import { engagements, projectRequests, type Engagement, type ProjectRequest } from '../schema';
import type { PricingMethod, ProposalCadence } from './proposal-types';
import { isAllowedTransition, InvalidStatusTransitionError } from './project-requests';

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
    currency?: string;
    depositCents?: number;
    rateCents?: number;
    cadence?: ProposalCadence;
    billingModel?: string;
    approvalModel?: string;
    activatedAt?: Date;
  }): Promise<Engagement> {
    const [row] = await db
      .insert(engagements)
      .values({
        companyId: input.companyId,
        expertProfileId: input.expertProfileId,
        pricingMethod: input.pricingMethod,
        priceCents: input.priceCents,
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
    pricingMethod: PricingMethod;
    priceCents: number;
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

      return { engagement, request };
    });
  },

  /** Live engagement by id. */
  async findById(id: string): Promise<Engagement | undefined> {
    return db.query.engagements.findFirst({
      where: and(eq(engagements.id, id), isNull(engagements.deletedAt)),
    });
  },

  /** Live engagements for a company, newest first. */
  async listByCompany(companyId: string): Promise<Engagement[]> {
    return db
      .select()
      .from(engagements)
      .where(and(eq(engagements.companyId, companyId), isNull(engagements.deletedAt)))
      .orderBy(desc(engagements.createdAt));
  },
};

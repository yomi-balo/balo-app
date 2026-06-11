import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from '../client';
import { engagements, type Engagement } from '../schema';
import type { PricingMethod, ProposalCadence } from './proposal-types';

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
        ...(input.sourceProposalId !== undefined
          ? { sourceProposalId: input.sourceProposalId }
          : {}),
        ...(input.relationshipId !== undefined ? { relationshipId: input.relationshipId } : {}),
        ...(input.projectRequestId !== undefined
          ? { projectRequestId: input.projectRequestId }
          : {}),
        ...(input.currency !== undefined ? { currency: input.currency } : {}),
        ...(input.depositCents !== undefined ? { depositCents: input.depositCents } : {}),
        ...(input.rateCents !== undefined ? { rateCents: input.rateCents } : {}),
        ...(input.cadence !== undefined ? { cadence: input.cadence } : {}),
        ...(input.billingModel !== undefined ? { billingModel: input.billingModel } : {}),
        ...(input.approvalModel !== undefined ? { approvalModel: input.approvalModel } : {}),
      })
      .returning();
    if (row === undefined) {
      throw new Error('Failed to create engagement');
    }
    return row;
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

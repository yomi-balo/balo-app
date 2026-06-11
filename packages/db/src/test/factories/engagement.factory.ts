import { db } from '../../client';
import { companies, engagements } from '../../schema';
import type { Engagement, NewEngagement } from '../../schema';
import { expertDraftFactory } from './expert-draft.factory';
import { proposalFactory, type ProposalFactoryResult } from './proposal.factory';

interface EngagementFactoryOverrides {
  /** Reuse an existing company instead of seeding a personal one. */
  companyId?: string;
  /** The delivering expert. Defaults to a fresh expert draft. */
  expertProfileId?: string;
  /**
   * Seed a source proposal and wire ALL provenance ids
   * (`sourceProposalId`/`relationshipId`/`projectRequestId`) from it — the A6.5
   * "engagement from accepted proposal" path. When false/omitted, the engagement
   * is born WITHOUT any origination row (the retainer seam). The proposal's
   * relationship/request carry their OWN company/expert; supply `companyId` /
   * `expertProfileId` here to deliberately diverge.
   */
  withSourceProposal?: boolean;
  /** Row-level overrides (status, pricingMethod, billingModel, deletedAt, …). */
  values?: Partial<NewEngagement>;
}

export interface EngagementFactoryResult {
  engagement: Engagement;
  companyId: string;
  expertProfileId: string;
  /** Present only when `withSourceProposal` was set. */
  sourceProposal?: ProposalFactoryResult;
}

async function seedPersonalCompanyId(): Promise<string> {
  const [company] = await db
    .insert(companies)
    .values({ name: 'Acme Co', isPersonal: true })
    .returning();
  if (company === undefined) {
    throw new Error('company insert failed');
  }
  return company.id;
}

/**
 * Seeds an `engagements` row. Two modes:
 *
 *  - default (the retainer seam): a fresh company + expert + commercial terms,
 *    NO origination provenance — proving an engagement is expressible without a
 *    proposal.
 *  - `withSourceProposal: true` (the A6.5 path): also seeds a proposal and wires
 *    `sourceProposalId`/`relationshipId`/`projectRequestId` from it.
 *
 * Overrides flow through `.values(...)`.
 */
export async function engagementFactory(
  overrides: EngagementFactoryOverrides = {}
): Promise<EngagementFactoryResult> {
  let sourceProposal: ProposalFactoryResult | undefined;
  const provenance: Partial<NewEngagement> = {};

  if (overrides.withSourceProposal === true) {
    sourceProposal = await proposalFactory();
    provenance.sourceProposalId = sourceProposal.proposal.id;
    provenance.relationshipId = sourceProposal.relationshipId;
    provenance.projectRequestId = sourceProposal.projectRequestId;
  }

  const companyId = overrides.companyId ?? (await seedPersonalCompanyId());
  const expertProfileId = overrides.expertProfileId ?? (await expertDraftFactory()).id;

  const [engagement] = await db
    .insert(engagements)
    .values({
      companyId,
      expertProfileId,
      pricingMethod: 'fixed',
      priceCents: 500_000,
      activatedAt: new Date(),
      ...provenance,
      ...overrides.values,
    })
    .returning();
  if (engagement === undefined) {
    throw new Error('engagement insert failed');
  }

  return { engagement, companyId, expertProfileId, sourceProposal };
}

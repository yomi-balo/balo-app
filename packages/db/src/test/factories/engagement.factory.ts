import { db } from '../../client';
import { companies, engagements, projectEngagements } from '../../schema';
import type { NewEngagement, NewProjectEngagement } from '../../schema';
import { projectDeliveryToEngagementStatus } from '../../repositories/_shared/engagement-supertype';
import type { ProjectEngagementRow } from '../../repositories/project-engagements';
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
  /**
   * SUPERTYPE row overrides (currency, activatedAt, deletedAt, …).
   *
   * ⚠ `status` is DELIBERATELY EXCLUDED (`Omit<…, 'status'>`). The parent status is
   * DERIVED from the child's delivery status via
   * `projectDeliveryToEngagementStatus(projectValues?.deliveryStatus ?? 'active')`, so
   * a fixture can never seed the impossible state the projection invariant forbids
   * (e.g. child `completed` over parent `active`, which would let
   * `lockActiveEngagement` admit milestone writes on a completed project and make
   * every downstream suite test a state production cannot produce).
   * To seed a non-active engagement, set `projectValues.deliveryStatus`.
   *
   * `engagementType` is likewise excluded — this factory seeds PROJECTS. Use
   * `caseEngagementFactory` for a case.
   */
  values?: Omit<Partial<NewEngagement>, 'status' | 'engagementType'>;
  /** PROJECT CHILD overrides (deliveryStatus, pricingMethod, priceCents, cancelledAt, …). */
  projectValues?: Omit<Partial<NewProjectEngagement>, 'engagementId' | 'engagementType'>;
}

export interface EngagementFactoryResult {
  /** FLAT project row — `.status` is the 4-value delivery status, `.pricingMethod` etc. still read. */
  engagement: ProjectEngagementRow;
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
 * Seeds a PROJECT engagement — the `engagements` supertype row PLUS its
 * `project_engagements` child, in ONE transaction (BAL-417). Two modes:
 *
 *  - default (the retainer seam): a fresh company + expert + commercial terms,
 *    NO origination provenance — proving an engagement is expressible without a
 *    proposal.
 *  - `withSourceProposal: true` (the A6.5 path): also seeds a proposal and wires
 *    `sourceProposalId`/`relationshipId`/`projectRequestId` from it.
 *
 * NB: in `withSourceProposal` mode the engagement's parties (`companyId` /
 * `expertProfileId`) are FRESH and are NOT reconciled with the source proposal's
 * relationship — a fixture shortcut. A6.5's real accept→engagement writer MUST
 * derive `company_id` / `expert_profile_id` from the LOCKED relationship row (not
 * trust the caller), the same denormalised-id discipline as `submit`/`accept`.
 *
 * The PARENT status is DERIVED, never accepted — see `EngagementFactoryOverrides.values`.
 * Returns the FLAT `ProjectEngagementRow`, so `.status` / `.pricingMethod` /
 * `.completionRequestedAt` all read exactly as they did pre-split.
 */
export async function engagementFactory(
  overrides: EngagementFactoryOverrides = {}
): Promise<EngagementFactoryResult> {
  let sourceProposal: ProposalFactoryResult | undefined;
  const provenance: Partial<NewProjectEngagement> = {};

  if (overrides.withSourceProposal === true) {
    sourceProposal = await proposalFactory();
    provenance.sourceProposalId = sourceProposal.proposal.id;
    provenance.relationshipId = sourceProposal.relationshipId;
    provenance.projectRequestId = sourceProposal.projectRequestId;
  }

  const companyId = overrides.companyId ?? (await seedPersonalCompanyId());
  const expertProfileId = overrides.expertProfileId ?? (await expertDraftFactory()).id;

  const deliveryStatus = overrides.projectValues?.deliveryStatus ?? 'active';

  const engagement = await db.transaction(async (tx) => {
    const [parent] = await tx
      .insert(engagements)
      .values({
        engagementType: 'project',
        companyId,
        expertProfileId,
        status: projectDeliveryToEngagementStatus(deliveryStatus),
        activatedAt: new Date(),
        ...overrides.values,
      })
      .returning();
    if (parent === undefined) {
      throw new Error('engagement insert failed');
    }

    const [child] = await tx
      .insert(projectEngagements)
      .values({
        engagementId: parent.id,
        pricingMethod: 'fixed',
        priceCents: 500_000,
        ...provenance,
        ...overrides.projectValues,
        deliveryStatus,
        // The child mirrors the parent's soft-delete flag — a fixture that passes
        // `values.deletedAt` must not leave the child live (that is exactly the
        // `project_engagement_request_unique_idx` re-create trap).
        ...(overrides.values?.deletedAt === undefined
          ? {}
          : { deletedAt: overrides.values.deletedAt }),
      })
      .returning();
    if (child === undefined) {
      throw new Error('project engagement insert failed');
    }

    const {
      engagementId: _engagementId,
      engagementType: _engagementType,
      deliveryStatus: childDeliveryStatus,
      createdAt: _createdAt,
      updatedAt: _updatedAt,
      deletedAt: _deletedAt,
      ...childRest
    } = child;
    // `status` LAST — it must come from the CHILD, never the coarse parent projection.
    return { ...parent, ...childRest, status: childDeliveryStatus };
  });

  return { engagement, companyId, expertProfileId, sourceProposal };
}

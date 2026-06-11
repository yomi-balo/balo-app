import { db } from '../../client';
import { proposals } from '../../schema';
import type { Proposal, NewProposal } from '../../schema';
import {
  requestExpertRelationshipFactory,
  type RequestExpertRelationshipFactoryResult,
} from './request-expert-relationship.factory';

interface ProposalFactoryOverrides {
  /** Reuse an existing relationship (and its request/expert ids) instead of
   *  seeding a fresh one advanced to `proposal_submitted`. */
  relationship?: RequestExpertRelationshipFactoryResult;
  /** Row-level overrides (status, version, isCurrent, pricingMethod, …). */
  values?: Partial<NewProposal>;
}

export interface ProposalFactoryResult {
  proposal: Proposal;
  relationshipId: string;
  projectRequestId: string;
  expertProfileId: string;
}

/**
 * Seeds a `proposals` row. By default seeds a fresh relationship advanced to
 * `proposal_submitted` (the state from which a proposal exists), then inserts a
 * `submitted` / `version=1` / `is_current=true` proposal whose denormalised
 * request/expert ids are pinned to the relationship's own ids (so the composite
 * backstop FKs are satisfied). Overrides flow through `.values(...)`.
 *
 * Inserts directly via `db` (not `proposalsRepository.submit`) so tests can seed
 * any status/version/isCurrent combination — including superseded
 * (`is_current=false`) versions — without driving the full submit transition.
 */
export async function proposalFactory(
  overrides: ProposalFactoryOverrides = {}
): Promise<ProposalFactoryResult> {
  const relationship =
    overrides.relationship ??
    (await requestExpertRelationshipFactory({ values: { status: 'proposal_submitted' } }));

  const [proposal] = await db
    .insert(proposals)
    .values({
      relationshipId: relationship.relationship.id,
      projectRequestId: relationship.projectRequestId,
      expertProfileId: relationship.expertProfileId,
      status: 'submitted',
      pricingMethod: 'fixed',
      version: 1,
      isCurrent: true,
      overview: '<p>Rebuild lead routing in Flow with proper assignment rules.</p>',
      priceCents: 500_000,
      ...overrides.values,
    })
    .returning();
  if (proposal === undefined) {
    throw new Error('proposal insert failed');
  }

  return {
    proposal,
    relationshipId: relationship.relationship.id,
    projectRequestId: relationship.projectRequestId,
    expertProfileId: relationship.expertProfileId,
  };
}

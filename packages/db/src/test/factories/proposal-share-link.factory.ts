import { randomBytes } from 'node:crypto';
import { db } from '../../client';
import { proposalShareLinks } from '../../schema';
import type { ProposalShareLink, NewProposalShareLink } from '../../schema';
import { userFactory } from './user.factory';
import {
  requestExpertRelationshipFactory,
  type RequestExpertRelationshipFactoryResult,
} from './request-expert-relationship.factory';

interface ProposalShareLinkFactoryOverrides {
  /** Reuse an existing relationship instead of seeding a fresh one. */
  relationship?: RequestExpertRelationshipFactoryResult;
  /** Sharer. Defaults to a fresh user. */
  createdByUserId?: string;
  /** Row-level overrides (recipientEmail, tokenHash, revokedAt, expiresAt, …). */
  values?: Partial<NewProposalShareLink>;
}

export interface ProposalShareLinkFactoryResult {
  link: ProposalShareLink;
  relationshipId: string;
  createdByUserId: string;
}

/**
 * Seeds a `proposal_share_links` row. By default seeds a fresh relationship (via
 * `requestExpertRelationshipFactory`) advanced to `proposal_submitted` and a fresh
 * sharer user, then inserts a live link with a random 64-char hex token hash.
 *
 * Inserts directly via `db` (not `proposalShareLinksRepository.create`) so tests can
 * seed any state — revoked, expired, soft-deleted — without driving the create tx.
 */
export async function proposalShareLinkFactory(
  overrides: ProposalShareLinkFactoryOverrides = {}
): Promise<ProposalShareLinkFactoryResult> {
  const relationship =
    overrides.relationship ??
    (await requestExpertRelationshipFactory({ values: { status: 'proposal_submitted' } }));

  const createdByUserId = overrides.createdByUserId ?? (await userFactory()).id;

  const [link] = await db
    .insert(proposalShareLinks)
    .values({
      relationshipId: relationship.relationship.id,
      recipientEmail: 'colleague@example.com',
      tokenHash: randomBytes(32).toString('hex'),
      note: null,
      createdByUserId,
      ...overrides.values,
    })
    .returning();
  if (link === undefined) {
    throw new Error('proposal share link insert failed');
  }

  return {
    link,
    relationshipId: relationship.relationship.id,
    createdByUserId,
  };
}

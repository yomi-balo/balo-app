import { and, asc, eq, isNull } from 'drizzle-orm';
import { db } from '../client';
import {
  engagementClauses,
  projectEngagements,
  proposals,
  users,
  type EngagementClause,
  type ProposalClause,
} from '../schema';
import type { DbTx } from './_shared/engagement-lock';

/**
 * What the delivery workspace's "Agreed in the proposal" card reads: the engagement's clause
 * snapshot, plus when the source proposal was accepted and by whom.
 *
 * `proposalAcceptedBy` is null for a proposal accepted before acceptance was attributed
 * (`proposals.accepted_by_user_id` NULL), and `proposalAcceptedAt` is null when the engagement
 * has no source proposal. Only the two name columns are read, never a full `users` row.
 */
export interface AgreedTermsSource {
  clauses: EngagementClause[];
  proposalAcceptedAt: Date | null;
  proposalAcceptedBy: { firstName: string | null; lastName: string | null } | null;
}

/**
 * Copy the accepted proposal's live clauses onto a new engagement within an EXISTING
 * transaction: the clause counterpart of `snapshotFromProposalTx` for milestones. A pure insert
 * with NO audit; the caller, `materializeFromKickoff`, records the one
 * `engagement.clauses_snapshotted` row (ADR-1030).
 *
 * Copies kind, per-kind sort order, body and provenance (`source_proposal_clause_id`), and
 * sets `created_by_user_id` to the approving admin. Empty sources give `[]`: a proposal with no
 * clauses is legal.
 *
 * ⚠ THE ONLY WRITER OF `engagement_clauses` in `repositories/`. The rows are read-only after
 * kickoff, and `invariants/engagement-clauses-have-one-writer.test.ts` fails on a second
 * writer.
 */
export async function snapshotClausesFromProposalTx(
  tx: DbTx,
  input: { engagementId: string; approvingAdminUserId: string; sources: ProposalClause[] }
): Promise<EngagementClause[]> {
  if (input.sources.length === 0) {
    return [];
  }
  return tx
    .insert(engagementClauses)
    .values(
      input.sources.map((clause) => ({
        engagementId: input.engagementId,
        sourceProposalClauseId: clause.id,
        kind: clause.kind,
        sortOrder: clause.sortOrder,
        body: clause.body,
        createdByUserId: input.approvingAdminUserId,
      }))
    )
    .returning();
}

export const engagementClausesRepository = {
  /**
   * The engagement's agreed clauses, ordered by kind (the pgEnum order: assumptions,
   * exclusions, additional terms), then `sortOrder`, ties by `id`, together with the source
   * proposal's acceptance. Two reads: the live clauses, then the project child joined to its
   * source proposal and, by a LEFT join, the accepting user's names.
   *
   * An unknown engagement, or one with no source proposal, gives no clauses and nulls. The
   * accepting user is attributed even after they leave (no `users.deleted_at` filter), as
   * retrospective attribution is.
   */
  async findAgreedTerms(engagementId: string): Promise<AgreedTermsSource> {
    const clauses = await db
      .select()
      .from(engagementClauses)
      .where(
        and(eq(engagementClauses.engagementId, engagementId), isNull(engagementClauses.deletedAt))
      )
      .orderBy(
        asc(engagementClauses.kind),
        asc(engagementClauses.sortOrder),
        asc(engagementClauses.id)
      );

    const [acceptance] = await db
      .select({
        acceptedAt: proposals.acceptedAt,
        acceptedByUserId: proposals.acceptedByUserId,
        firstName: users.firstName,
        lastName: users.lastName,
      })
      .from(projectEngagements)
      .innerJoin(
        proposals,
        and(eq(proposals.id, projectEngagements.sourceProposalId), isNull(proposals.deletedAt))
      )
      .leftJoin(users, eq(users.id, proposals.acceptedByUserId))
      .where(
        and(eq(projectEngagements.engagementId, engagementId), isNull(projectEngagements.deletedAt))
      )
      .limit(1);

    if (acceptance === undefined) {
      return { clauses, proposalAcceptedAt: null, proposalAcceptedBy: null };
    }
    return {
      clauses,
      proposalAcceptedAt: acceptance.acceptedAt,
      proposalAcceptedBy:
        acceptance.acceptedByUserId === null
          ? null
          : { firstName: acceptance.firstName, lastName: acceptance.lastName },
    };
  },
};

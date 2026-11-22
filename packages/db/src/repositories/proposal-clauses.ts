import { and, asc, eq, isNull } from 'drizzle-orm';
import { db } from '../client';
import { proposalClauses, type ProposalClause } from '../schema';
import { lockDraftProposalTx } from './_shared/proposal-draft-lock';

/** Active transaction handle (matches `advanceProposalStatus` in proposals.ts). */
type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * One clause in a replace-all set. The kind union is the `proposal_clause_kind` pgEnum, which
 * `PROPOSAL_CLAUSE_KINDS` in `@balo/shared/project-requests` mirrors exactly
 * (`proposal-clause-kinds-match-the-pgenum.test.ts`). `sortOrder` is assigned by the repo, so a
 * caller orders clauses by array position only.
 */
export interface ProposalClauseInput {
  kind: ProposalClause['kind'];
  /** Plain text. Normalised and length-checked by the web caller; inserted as given here. */
  body: string;
}

/**
 * Insert a clause set for a proposal within an EXISTING transaction. `sortOrder` is a running
 * index PER KIND (0..n for each kind, in array order), so the kinds may arrive interleaved.
 * Empty input is a no-op (returns `[]`). Exported so `proposalsRepository.resubmit` writes a
 * new version's clauses in the transaction that creates its header row; `setForProposal`
 * reuses it so the INSERT lives in one place.
 */
export async function insertClausesTx(
  tx: DbTx,
  proposalId: string,
  clauses: ProposalClauseInput[]
): Promise<ProposalClause[]> {
  if (clauses.length === 0) {
    return [];
  }
  const nextIndex = new Map<ProposalClauseInput['kind'], number>();
  const values = clauses.map((clause) => {
    const sortOrder = nextIndex.get(clause.kind) ?? 0;
    nextIndex.set(clause.kind, sortOrder + 1);
    return { proposalId, kind: clause.kind, sortOrder, body: clause.body };
  });
  return tx.insert(proposalClauses).values(values).returning();
}

/**
 * Live clauses for a proposal within an EXISTING transaction, ordered by kind (the pgEnum
 * order: assumptions, exclusions, additional terms), then `sortOrder`, ties by `id`. The
 * `Tx` variant of `proposalClausesRepository.listByProposal`, read by the kickoff snapshot
 * under its own locks. Named apart from the milestone repo's `listByProposalTx`, which
 * `project-engagements.ts` already imports.
 */
export async function listClausesByProposalTx(
  tx: DbTx,
  proposalId: string
): Promise<ProposalClause[]> {
  return tx
    .select()
    .from(proposalClauses)
    .where(and(eq(proposalClauses.proposalId, proposalId), isNull(proposalClauses.deletedAt)))
    .orderBy(asc(proposalClauses.kind), asc(proposalClauses.sortOrder), asc(proposalClauses.id));
}

export const proposalClausesRepository = {
  /**
   * Replace-all the clause set for a DRAFT proposal in ONE transaction: lock the proposal
   * header `FOR UPDATE` and require a live `draft` (`lockDraftProposalTx`, which throws
   * `ProposalNotDraftError` otherwise), soft-delete the live rows, then insert the new set.
   * The caller always sends every kind's complete list, never a patch. An empty input clears
   * the set. Returns the new live rows in insert order.
   *
   * The header lock is the one the milestone and installment writers take, so an autosave
   * either commits before a submit's locked re-read or is refused once the proposal is
   * `submitted`. A non-draft version's clauses are written only inside its own transition
   * (`resubmit`, via `insertClausesTx`).
   *
   * A blank body fails the `proposal_clause_body_not_blank` CHECK (23514) and rolls the whole
   * replace back, so the previous set survives.
   */
  async setForProposal(input: {
    proposalId: string;
    clauses: ProposalClauseInput[];
  }): Promise<ProposalClause[]> {
    return db.transaction(async (tx) => {
      await lockDraftProposalTx(tx, input.proposalId);

      await tx
        .update(proposalClauses)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(
          and(eq(proposalClauses.proposalId, input.proposalId), isNull(proposalClauses.deletedAt))
        );

      return insertClausesTx(tx, input.proposalId, input.clauses);
    });
  },

  /** Live clauses for a proposal, ordered by kind, then `sortOrder`, ties by `id`. */
  async listByProposal(proposalId: string): Promise<ProposalClause[]> {
    return db
      .select()
      .from(proposalClauses)
      .where(and(eq(proposalClauses.proposalId, proposalId), isNull(proposalClauses.deletedAt)))
      .orderBy(asc(proposalClauses.kind), asc(proposalClauses.sortOrder), asc(proposalClauses.id));
  },
};

import { and, eq, isNull } from 'drizzle-orm';
import type { db } from '../../client';
import { proposals, type Proposal } from '../../schema';

/** Active transaction handle (matches `advanceProposalStatus` in proposals.ts). */
type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Thrown when a draft-only write targets a proposal that is not a live `draft`
 * (missing, soft-deleted, or already `submitted`/beyond): `updateDraft` (the header)
 * and both child `setForProposal` writers (milestones, installments). Guards a stale
 * autosave from silently overwriting a submitted proposal — the actions surface it as
 * their stale-draft copy. Modelled on the repo's existing `InvalidProposalTransitionError`
 * (a typed, named domain error the action `instanceof`-checks), not a bare `Error`.
 *
 * Defined here rather than in `proposals.ts` so the child repositories can throw it
 * without importing `proposals.ts` (which imports them). `proposals.ts` re-exports it.
 */
export class ProposalNotDraftError extends Error {
  constructor(public readonly status: Proposal['status'] | null) {
    super(
      status === null
        ? 'Proposal not found or soft-deleted: cannot update a draft.'
        : `Proposal is not a draft (status: ${status}): cannot update.`
    );
    this.name = 'ProposalNotDraftError';
  }
}

/**
 * Lock a proposal header row `FOR UPDATE` inside the caller's transaction and
 * require it to be a live `draft`; returns the locked row, or throws
 * {@link ProposalNotDraftError}.
 *
 * LOCK ORDER: proposal header → then its child rows. Every writer that touches a
 * proposal's milestones/installments takes the header first: `promoteToSubmit`
 * (relationship → header, then reads the children under it), `resubmit` (header,
 * then the new version's children), and the draft writers that use this helper. A
 * child write therefore either commits before a submit's locked re-read (which then
 * sees it) or waits for the submit and is refused here, because `FOR UPDATE` returns
 * the row's latest committed status once the lock is granted.
 */
export async function lockDraftProposalTx(tx: DbTx, proposalId: string): Promise<Proposal> {
  const [current] = await tx
    .select()
    .from(proposals)
    .where(and(eq(proposals.id, proposalId), isNull(proposals.deletedAt)))
    .for('update');

  if (current === undefined) {
    throw new ProposalNotDraftError(null);
  }
  if (current.status !== 'draft') {
    throw new ProposalNotDraftError(current.status);
  }
  return current;
}

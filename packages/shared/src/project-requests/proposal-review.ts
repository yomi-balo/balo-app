/**
 * A submitted proposal awaits the client's review unless the client already asked for changes —
 * then the move is the expert's. The one definition of "awaiting client review".
 *
 * The parameters are plain strings so this package stays free of `@balo/db`; callers pass the
 * relationship status and the current proposal status straight from their rows.
 */
export function proposalAwaitsClientReview(
  relationshipStatus: string,
  currentProposalStatus: string | null
): boolean {
  return (
    relationshipStatus === 'proposal_submitted' && currentProposalStatus !== 'changes_requested'
  );
}

export interface ProposalReviewWaitCandidate {
  relationshipStatus: string;
  proposalStatus: string | null;
  submittedAt: Date | null;
}

export interface ProposalReviewWait {
  /** The earliest submit time among the proposals still awaiting review. */
  anchor: Date;
  /** How many relationships still await the client's review. */
  awaitingCount: number;
}

/**
 * The one definition of a request's current proposal-review wait. It keeps the candidates the
 * client still has to review (`proposalAwaitsClientReview`); the anchor is the earliest of their
 * submit times. A request with nothing awaiting, or whose awaiting rows carry no submit time, is
 * not waiting: `null`.
 */
export function proposalReviewWait(
  candidates: readonly ProposalReviewWaitCandidate[]
): ProposalReviewWait | null {
  let awaitingCount = 0;
  let anchor: Date | null = null;
  for (const candidate of candidates) {
    if (!proposalAwaitsClientReview(candidate.relationshipStatus, candidate.proposalStatus)) {
      continue;
    }
    awaitingCount += 1;
    if (candidate.submittedAt !== null && (anchor === null || candidate.submittedAt < anchor)) {
      anchor = candidate.submittedAt;
    }
  }
  return anchor === null ? null : { anchor, awaitingCount };
}

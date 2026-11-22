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

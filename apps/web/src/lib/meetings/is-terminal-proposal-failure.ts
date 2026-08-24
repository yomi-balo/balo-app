import type { RescheduleProposalFailureCode } from '@/app/(dashboard)/cases/[engagementId]/_actions/_types/case-action-types';

/**
 * BAL-411 fix round 1 (item 3) — BAL-409 (`reschedule-dialog.tsx`'s `copyForFailure`
 * `closeOnAcknowledge`) already established the rule this file carries over: a failure code
 * that means "the state this UI was rendered from is gone" must never be re-offered as if a
 * retry could ever succeed. Shared by `reschedule-proposal-card.tsx` (accept/decline/withdraw)
 * and `propose-times-dialog.tsx` (propose) so both surfaces refresh instead of leaving a dead
 * action mounted.
 *
 * `slot_unavailable` is deliberately excluded — it means "pick again", not "this is gone", and
 * both callers already handle it with their own local remount/reset logic.
 */
export function isTerminalProposalFailure(code: RescheduleProposalFailureCode): boolean {
  switch (code) {
    case 'proposal_not_answerable':
    case 'proposal_stale':
    case 'meeting_not_reschedulable':
    case 'meeting_not_found':
    case 'case_closed':
      return true;
    default:
      return false;
  }
}

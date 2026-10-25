import 'server-only';

import { UPCOMING_CALL_CAP } from './conversation-view-types';
import { listUpcomingCallsByThread } from './upcoming-calls';

/**
 * BAL-616 — THE WEB-SIDE "at most 3 upcoming calls per thread" PRE-CHECK.
 *
 * It replaces BAL-283's one-call-per-thread guard. The cap is enforced in BOTH apps:
 * `apps/api`'s booking gate refuses a 4th call with `call_cap_reached` (409), and this check
 * runs first so the client gets the friendly copy without a round trip. The page's
 * `upcomingCalls` and both servers count through the SAME shared rule
 * (`isUpcomingContextMeeting` in `@balo/shared/meetings`), so an ENDED call never blocks a new
 * booking and a live one always does.
 *
 * It counts the thread across both contexts it can hold calls on: the relationship's
 * `request_interaction` and, once kickoff has materialized an engagement, its `project_call`. A
 * carried-over meeting holds both and counts once (`mergeUpcomingCalls`).
 *
 * ⚠ IT IS NOT A UNIQUENESS CONSTRAINT AND DOES NOT PRETEND TO BE. Both caps are check-then-act,
 * so two requests racing inside the same instant can both pass at 2. There is no partial unique
 * index to lean on (`meeting_contexts.context_id` is polymorphic and FK-less). The cap is a
 * product limit that closes the deliberate, repeatable abuse; it is not a safety property.
 *
 * ⚠ READ-ONLY AND AUTHORIZATION-FREE. The caller must already have established the actor's right
 * to this relationship (`resolveConversationAccess`) and resolved `engagementId` from the
 * request's own `project_engagements` row, never from client input.
 *
 * Returns `true` when the thread is UNDER the cap, i.e. one more call may be booked.
 */
export async function assertUnderUpcomingCallCap(
  relationshipId: string,
  engagementId: string | null
): Promise<boolean> {
  const byThread = await listUpcomingCallsByThread({
    relationshipIds: [relationshipId],
    projectCall: engagementId === null ? null : { relationshipId, engagementId },
    nowMs: Date.now(),
  });
  return (byThread.get(relationshipId) ?? []).length < UPCOMING_CALL_CAP;
}

import 'server-only';

import { meetingsRepository, type ContextMeetingSummary } from '@balo/db';
import {
  mergeUpcomingCalls,
  type UpcomingCallContextType,
  type UpcomingCallView,
} from './conversation-view-types';

/**
 * BAL-616 — the upcoming calls of a set of conversation threads, soonest first per thread.
 *
 * A thread reads up to two contexts: its `request_interaction` (the relationship, before and
 * after the decision) and, for the won thread after kickoff, its `project_call` (the
 * engagement, which carried-over calls also hold). Both reads run concurrently, and a meeting
 * present in both is reported once, as `project_call` (`mergeUpcomingCalls`).
 *
 * Every requested relationship id gets an entry, `[]` when it has no upcoming call.
 *
 * ⚠ READ-ONLY AND AUTHORIZATION-FREE. `listActiveMeetingsForContexts` resolves NO tenancy, so
 * the caller must already have authorized every id it passes (the repository docblock's
 * obligation): the relationship ids through the request's lens, and `projectCall.engagementId`
 * through the request's own `project_engagements` row.
 *
 * ⚠ The rows come from `listActiveMeetingsForContexts`, which already excludes `cancelled`;
 * the shared upcoming rule does not.
 */
export async function listUpcomingCallsByThread(input: {
  relationshipIds: readonly string[];
  projectCall: { relationshipId: string; engagementId: string } | null;
  nowMs: number;
}): Promise<Map<string, UpcomingCallView[]>> {
  const { relationshipIds, projectCall, nowMs } = input;

  const [byRelationship, byEngagement] = await Promise.all([
    meetingsRepository.listActiveMeetingsForContexts({
      contextType: 'request_interaction',
      contextIds: [...relationshipIds],
    }),
    projectCall === null
      ? Promise.resolve(null)
      : meetingsRepository.listActiveMeetingsForContexts({
          contextType: 'project_call',
          contextIds: [projectCall.engagementId],
        }),
  ]);

  const result = new Map<string, UpcomingCallView[]>();
  for (const relationshipId of relationshipIds) {
    const sources: Array<{
      contextType: UpcomingCallContextType;
      meetings: readonly ContextMeetingSummary[];
    }> = [
      { contextType: 'request_interaction', meetings: byRelationship.get(relationshipId) ?? [] },
    ];
    if (projectCall !== null && projectCall.relationshipId === relationshipId) {
      sources.push({
        contextType: 'project_call',
        meetings: byEngagement?.get(projectCall.engagementId) ?? [],
      });
    }
    result.set(relationshipId, mergeUpcomingCalls(sources, nowMs));
  }
  return result;
}

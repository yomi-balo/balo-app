'use server';

import 'server-only';

import { z } from 'zod';
import { engagementTimeEntriesRepository } from '@balo/db';
import {
  INVALID_REQUEST,
  requireSignedInUser,
  runEngagementLifecycleAction,
  type EngagementActionResult,
} from './engagement-lifecycle-shared';
import { timeEntryAuthorScope } from '@/lib/engagement/resolve-engagement-viewer';
import { afterTimeWrite, gateTimeEntryExpert } from './time-entry-action-shared';

const removeTimeEntrySchema = z.object({ engagementId: z.uuid(), entryId: z.uuid() }).strict();

/**
 * The author, or an owner or admin of the delivering expert's agency, deletes a time entry
 * while the project is active. Gated on `manage_engagement`; the author scope comes from
 * `timeEntryAuthorScope` (an agency owner or admin reaches any entry, a delivering expert with
 * agency role `expert` and an independent expert only their own), and the repository refuses
 * any other with the same answer as a missing one. Removing someone else's entry notifies its
 * author.
 */
export async function removeTimeEntryAction(input: {
  engagementId: string;
  entryId: string;
}): Promise<EngagementActionResult> {
  const auth = await requireSignedInUser();
  if (!auth.ok) {
    return { success: false, error: auth.error };
  }
  const parsed = removeTimeEntrySchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: INVALID_REQUEST };
  }
  const { engagementId, entryId } = parsed.data;
  const { user } = auth;

  return runEngagementLifecycleAction(
    engagementId,
    { userId: user.id, timeEntryId: entryId },
    'Failed to remove time entry',
    () => gateTimeEntryExpert(user, engagementId),
    async (engagement, authorized) => {
      const entry = await engagementTimeEntriesRepository.remove({
        engagementId,
        entryId,
        userId: user.id,
        authorScope: await timeEntryAuthorScope(user, engagement),
      });
      await afterTimeWrite({
        kind: 'removed',
        actor: user,
        actingAs: authorized.actor.actingAs,
        engagement,
        result: { entry },
      });
      return { success: true };
    }
  );
}

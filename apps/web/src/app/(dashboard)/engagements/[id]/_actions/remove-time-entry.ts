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
import { gateChangeOrderExpert } from './change-order-action-shared';
import { afterTimeWrite } from './time-entry-action-shared';

const removeTimeEntrySchema = z.object({ engagementId: z.uuid(), entryId: z.uuid() }).strict();

/**
 * The author deletes their own time entry while the project is active. Gated on
 * `manage_engagement`; the repository refuses an entry the actor did not write with the same
 * answer as a missing one.
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
    () => gateChangeOrderExpert(user, engagementId),
    async (engagement) => {
      const entry = await engagementTimeEntriesRepository.remove({
        engagementId,
        entryId,
        userId: user.id,
      });
      await afterTimeWrite({ kind: 'removed', userId: user.id, engagement, result: { entry } });
      return { success: true };
    }
  );
}

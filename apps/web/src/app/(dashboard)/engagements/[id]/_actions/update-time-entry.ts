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
import { gateChangeOrderExpert } from './change-order-action-shared';
import { afterTimeWrite, minutesSchema, noteSchema } from './time-entry-action-shared';

const updateTimeEntrySchema = z
  .object({
    engagementId: z.uuid(),
    entryId: z.uuid(),
    minutes: minutesSchema,
    note: noteSchema,
  })
  .strict();

/**
 * The author, or an owner or admin of the delivering expert's agency, edits the hours and note
 * of a time entry on an in-progress milestone. Gated on `manage_engagement`; the delivering
 * expert reaches only their own entries, and the repository refuses any other with the same
 * answer as a missing one. An edit that takes the milestone past its estimate for
 * the first time notifies like a new entry.
 */
export async function updateTimeEntryAction(input: {
  engagementId: string;
  entryId: string;
  minutes: number;
  note: string;
}): Promise<EngagementActionResult> {
  const auth = await requireSignedInUser();
  if (!auth.ok) {
    return { success: false, error: auth.error };
  }
  const parsed = updateTimeEntrySchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: INVALID_REQUEST };
  }
  const { engagementId, entryId, minutes, note } = parsed.data;
  const { user } = auth;

  return runEngagementLifecycleAction(
    engagementId,
    { userId: user.id, timeEntryId: entryId },
    'Failed to update time entry',
    () => gateChangeOrderExpert(user, engagementId),
    async (engagement, authorized) => {
      const result = await engagementTimeEntriesRepository.update({
        engagementId,
        entryId,
        userId: user.id,
        authorScope: timeEntryAuthorScope(authorized.actor.isDeliveringExpert),
        minutes,
        note,
      });
      await afterTimeWrite({ kind: 'updated', actor: user, engagement, result });
      return { success: true };
    }
  );
}

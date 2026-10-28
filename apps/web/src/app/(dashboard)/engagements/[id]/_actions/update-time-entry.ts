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
import {
  afterTimeWrite,
  gateTimeEntryExpert,
  minutesSchema,
  noteSchema,
} from './time-entry-action-shared';

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
 * of a time entry on an in-progress milestone. Gated on `manage_engagement`; the author scope
 * comes from `timeEntryAuthorScope` (an agency owner or admin reaches any entry, a delivering
 * expert with agency role `expert` and an independent expert only their own), and the
 * repository refuses any other with the same answer as a missing one. Editing someone else's
 * entry notifies its author. An edit that takes the milestone past its estimate for
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
    () => gateTimeEntryExpert(user, engagementId),
    async (engagement, authorized) => {
      const result = await engagementTimeEntriesRepository.update({
        engagementId,
        entryId,
        userId: user.id,
        authorScope: await timeEntryAuthorScope(user, engagement),
        minutes,
        note,
      });
      await afterTimeWrite({
        kind: 'updated',
        actor: user,
        actingAs: authorized.actor.actingAs,
        engagement,
        result,
      });
      return { success: true };
    }
  );
}

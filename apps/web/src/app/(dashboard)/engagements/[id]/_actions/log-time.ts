'use server';

import 'server-only';

import { z } from 'zod';
import { engagementTimeEntriesRepository, usersRepository } from '@balo/db';
import { localIsoDate } from '@balo/shared/timezone';
import {
  INVALID_REQUEST,
  NOT_TIME_AND_MATERIALS,
  requireSignedInUser,
  runEngagementLifecycleAction,
  type EngagementActionResult,
} from './engagement-lifecycle-shared';
import { gateChangeOrderExpert } from './change-order-action-shared';
import { MILESTONE_GONE } from './milestone-action-shared';
import { afterTimeWrite, minutesSchema, noteSchema } from './time-entry-action-shared';

const logTimeSchema = z
  .object({
    engagementId: z.uuid(),
    milestoneId: z.uuid(),
    minutes: minutesSchema,
    note: noteSchema,
  })
  .strict();

/**
 * The delivering expert (or an agency owner or admin) logs time against an in-progress
 * milestone of an active time-and-materials project. Gated on the engagement capability
 * `manage_engagement`; the entry is dated today in the author's own time zone
 * (`users.timezone`, UTC when unset). The repository records the first
 * crossing of the milestone's estimate in the same transaction, and the client and admins
 * are told once.
 */
export async function logTimeAction(input: {
  engagementId: string;
  milestoneId: string;
  minutes: number;
  note: string;
}): Promise<EngagementActionResult> {
  const auth = await requireSignedInUser();
  if (!auth.ok) {
    return { success: false, error: auth.error };
  }
  const parsed = logTimeSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: INVALID_REQUEST };
  }
  const { engagementId, milestoneId, minutes, note } = parsed.data;
  const { user } = auth;

  return runEngagementLifecycleAction(
    engagementId,
    { userId: user.id, milestoneId },
    'Failed to log time',
    () => gateChangeOrderExpert(user, engagementId),
    async (engagement) => {
      if (!engagement.milestones.some((m) => m.id === milestoneId)) {
        return { success: false, error: MILESTONE_GONE };
      }
      if (engagement.pricingMethod !== 'tm') {
        return { success: false, error: NOT_TIME_AND_MATERIALS };
      }
      const author = await usersRepository.findById(user.id);
      const result = await engagementTimeEntriesRepository.log({
        engagementId,
        milestoneId,
        userId: user.id,
        minutes,
        note,
        workedOn: localIsoDate(new Date(), author?.timezone),
      });
      await afterTimeWrite({ kind: 'logged', userId: user.id, engagement, result });
      return { success: true };
    }
  );
}

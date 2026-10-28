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
import { MILESTONE_GONE } from './milestone-action-shared';
import {
  afterTimeWrite,
  gateTimeLogger,
  minutesSchema,
  noteSchema,
} from './time-entry-action-shared';

const logTimeSchema = z
  .object({
    engagementId: z.uuid(),
    milestoneId: z.uuid(),
    minutes: minutesSchema,
    note: noteSchema,
  })
  .strict();

/**
 * The delivering expert logs time against an in-progress milestone of an active
 * time-and-materials project. Gated on the engagement capability `manage_engagement` and then
 * on `log_time`, which only the delivering expert holds: an agency owner or admin can edit and
 * remove entries but not log them, and is refused with `ONLY_EXPERT`. The entry is dated today in the author's own time zone
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
    () => gateTimeLogger(user, engagementId),
    async (engagement, authorized) => {
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
      await afterTimeWrite({
        kind: 'logged',
        actor: user,
        actingAs: authorized.actor.actingAs,
        engagement,
        result,
      });
      return { success: true };
    }
  );
}

import 'server-only';

import { z } from 'zod';
import type { ProjectEngagementWithMilestones, TimeEntryWriteResult } from '@balo/db';
import {
  TIME_ENTRY_MAX_MINUTES,
  TIME_ENTRY_MINUTES_STEP,
  TIME_ENTRY_NOTE_MAX,
  hoursLabel,
  percentOfEstimate,
} from '@balo/shared/engagements';
import type { SessionUser } from '@/lib/auth/session';
import { deriveEngagementParties, expertSideActorLabel } from '@/lib/engagement/engagement-parties';
import { trackServerAndFlush, ENGAGEMENT_SERVER_EVENTS } from '@/lib/analytics/server';
import { publishNotificationEvent } from '@/lib/notifications/publish';
import { log } from '@/lib/logging';
import { deriveEngagementTitle, resolveClientRecipientId } from './engagement-lifecycle-shared';

/** Whole minutes in quarter-hour steps, at least one step and at most a day. */
export const minutesSchema = z
  .number()
  .int()
  .min(TIME_ENTRY_MINUTES_STEP)
  .max(TIME_ENTRY_MAX_MINUTES)
  .refine((minutes) => minutes % TIME_ENTRY_MINUTES_STEP === 0);

/** A trimmed, non-blank note. */
export const noteSchema = z.string().trim().min(1).max(TIME_ENTRY_NOTE_MAX);

export type TimeWriteKind = 'logged' | 'updated' | 'removed';

/**
 * Tell the client (email + in-app) and admins (in-app) that a milestone went over its
 * estimate, and track it. Called once the over-estimate audit is recorded: by a time write
 * that crosses the estimate, or by an approved change order whose raised estimate the time
 * logged since the send had already passed.
 */
export async function notifyEstimateExceeded(input: {
  engagement: ProjectEngagementWithMilestones;
  milestone: { id: string; title: string; estimatedMinutes: number };
  loggedMinutes: number;
  milestonesOverCount: number;
  userId: string;
  /** The expert-side person whose write crossed the estimate; `null` when a client approval did. */
  expertActor: { id: string; firstName: string | null; lastName: string | null } | null;
}): Promise<void> {
  const { engagement, milestone, loggedMinutes, milestonesOverCount, userId, expertActor } = input;
  const parties = deriveEngagementParties(engagement);
  const recipientId = await resolveClientRecipientId(engagement.company.id);
  publishNotificationEvent('engagement.milestone_estimate_exceeded', {
    correlationId: `${milestone.id}:estimate_exceeded:${milestone.estimatedMinutes}`,
    engagementId: engagement.id,
    milestoneId: milestone.id,
    recipientId,
    expertPartyLabel: parties.expertParty,
    actorExpertLabel: expertSideActorLabel(engagement, parties, expertActor),
    projectTitle: deriveEngagementTitle(engagement, parties),
    milestoneTitle: milestone.title,
    loggedHoursLabel: hoursLabel(loggedMinutes),
    estimatedHoursLabel: hoursLabel(milestone.estimatedMinutes),
  }).catch(() => {
    // publishNotificationEvent logs internally.
  });
  trackServerAndFlush(ENGAGEMENT_SERVER_EVENTS.MILESTONE_ESTIMATE_EXCEEDED, {
    engagement_id: engagement.id,
    milestone_id: milestone.id,
    milestones_over_count: milestonesOverCount,
    distinct_id: userId,
  });
}

/**
 * What follows a committed time write: the `TIME_LOGGED` event (log only), the first-crossing
 * notice to the client owner and admins plus its event, and one structured log line. The log
 * carries ids and minutes only, never the note. Notifying is fire-and-forget.
 */
export async function afterTimeWrite(input: {
  kind: TimeWriteKind;
  actor: SessionUser;
  engagement: ProjectEngagementWithMilestones;
  result: Pick<TimeEntryWriteResult, 'entry'> & Partial<Omit<TimeEntryWriteResult, 'entry'>>;
}): Promise<void> {
  const { kind, actor, engagement, result } = input;
  const { entry, milestone, loggedAfterMinutes, estimateExceeded, milestonesOverCount } = result;

  if (kind === 'logged' && milestone !== undefined && loggedAfterMinutes !== undefined) {
    trackServerAndFlush(ENGAGEMENT_SERVER_EVENTS.TIME_LOGGED, {
      engagement_id: engagement.id,
      milestone_id: milestone.id,
      minutes: entry.minutes,
      crossed_estimate: estimateExceeded === true,
      milestone_pct_of_estimate: percentOfEstimate(loggedAfterMinutes, milestone.estimatedMinutes),
      distinct_id: actor.id,
    });
  }

  if (
    estimateExceeded === true &&
    milestone !== undefined &&
    milestone.estimatedMinutes !== null &&
    loggedAfterMinutes !== undefined
  ) {
    await notifyEstimateExceeded({
      engagement,
      milestone: { ...milestone, estimatedMinutes: milestone.estimatedMinutes },
      loggedMinutes: loggedAfterMinutes,
      milestonesOverCount: milestonesOverCount ?? 0,
      userId: actor.id,
      expertActor: actor,
    });
  }

  log.info(`Time entry ${kind}`, {
    engagementId: engagement.id,
    timeEntryId: entry.id,
    milestoneId: entry.engagementMilestoneId,
    userId: actor.id,
    minutes: entry.minutes,
    estimateExceeded: estimateExceeded === true,
  });
}

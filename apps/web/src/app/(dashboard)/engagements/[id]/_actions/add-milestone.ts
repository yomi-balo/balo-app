'use server';

import 'server-only';

import { z } from 'zod';
import { engagementMilestonesRepository } from '@balo/db';
import { trackServerAndFlush, ENGAGEMENT_SERVER_EVENTS } from '@/lib/analytics/server';
import { log } from '@/lib/logging';
import {
  INVALID_REQUEST,
  descriptionTextToSafeHtml,
  publishScopeChange,
  requireExpertUser,
  runExpertEngagementAction,
  runMilestoneTransition,
  type MilestoneActionResult,
} from './milestone-action-shared';

/**
 * `.strict()` so ANY unknown key (notably `valueCents` / any commercial field) makes
 * the parse fail → `INVALID_REQUEST`. The money axis is UNREPRESENTABLE here — belt
 * (this schema) AND braces (the repo `add` signature omits `valueCents`).
 */
const addInputSchema = z
  .object({
    engagementId: z.uuid(),
    title: z.string().trim().min(1).max(200),
    descriptionText: z.string().trim().max(10_000).optional(),
    acceptanceCriteria: z.string().trim().max(2_000).optional(),
    estimatedMinutes: z.number().int().nonnegative().max(1_000_000).optional(),
  })
  .strict();

export interface AddMilestoneInput {
  engagementId: string;
  title: string;
  descriptionText?: string;
  acceptanceCriteria?: string;
  estimatedMinutes?: number;
}

/**
 * Expert adds a NEW milestone to a live, active engagement (D3). Descriptive fields
 * only — `value_cents` stays null (unrepresentable in the schema + absent from the
 * repo signature). Auth / active-guard via the shared engagement runner, then
 * `engagementMilestonesRepository.add` under its lock. Fires `MILESTONE_ADDED` and
 * publishes `engagement.scope_changed` (`changeKind:'added'`) — fire-and-forget.
 */
export async function addMilestoneAction(input: AddMilestoneInput): Promise<MilestoneActionResult> {
  const auth = await requireExpertUser();
  if (!auth.ok) {
    return { success: false, error: auth.error };
  }
  const parsed = addInputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: INVALID_REQUEST };
  }
  const { engagementId, title, descriptionText, acceptanceCriteria, estimatedMinutes } =
    parsed.data;

  return runExpertEngagementAction(
    auth.user,
    engagementId,
    {},
    'Failed to add milestone',
    async ({ user, engagement }) => {
      const outcome = await runMilestoneTransition(() =>
        engagementMilestonesRepository.add({
          engagementId,
          userId: user.id,
          title,
          descriptionHtml: descriptionTextToSafeHtml(descriptionText),
          acceptanceCriteria: acceptanceCriteria ?? null,
          estimatedMinutes: estimatedMinutes ?? null,
        })
      );
      if (!outcome.ok) {
        return { success: false, error: outcome.error };
      }
      const created = outcome.value;

      trackServerAndFlush(ENGAGEMENT_SERVER_EVENTS.MILESTONE_ADDED, {
        engagement_id: engagement.id,
        milestones_total: engagement.milestones.length + 1,
        distinct_id: user.id,
      });

      await publishScopeChange(engagement, {
        changeKind: 'added',
        milestoneId: created.id,
        milestoneTitle: created.title,
        correlationId: `${created.id}:added`,
      });

      log.info('Milestone added', {
        engagementId: engagement.id,
        milestoneId: created.id,
        userId: user.id,
      });
      return { success: true, milestoneId: created.id, status: created.status };
    }
  );
}

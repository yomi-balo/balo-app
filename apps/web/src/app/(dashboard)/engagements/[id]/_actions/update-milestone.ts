'use server';

import 'server-only';

import { z } from 'zod';
import { engagementMilestonesRepository } from '@balo/db';
import { trackServerAndFlush, ENGAGEMENT_SERVER_EVENTS } from '@/lib/analytics/server';
import { htmlToPlainText } from '@/components/balo/rich-text/plain-text';
import { log } from '@/lib/logging';
import {
  EDIT_COSMETIC_DEBOUNCE_MS,
  INVALID_REQUEST,
  MILESTONE_GONE,
  descriptionTextToSafeHtml,
  publishScopeChange,
  requireExpertUser,
  runExpertEngagementAction,
  runMilestoneTransition,
  type MilestoneActionResult,
} from './milestone-action-shared';

/**
 * `.strict()` so `valueCents` / any commercial field is unrepresentable (parse fails →
 * `INVALID_REQUEST`). Descriptive fields only. `title` is `.optional()` (present ⇒ a
 * new non-empty value); the other three are `.nullish()` so an explicit `null` CLEARS
 * the field while `undefined` leaves it untouched.
 */
const updateInputSchema = z
  .object({
    engagementId: z.uuid(),
    milestoneId: z.uuid(),
    title: z.string().trim().min(1).max(200).optional(),
    descriptionText: z.string().trim().max(10_000).nullish(),
    acceptanceCriteria: z.string().trim().max(2_000).nullish(),
    estimatedMinutes: z.number().int().nonnegative().max(1_000_000).nullish(),
  })
  .strict();

export interface UpdateMilestoneInput {
  engagementId: string;
  milestoneId: string;
  title?: string;
  descriptionText?: string | null;
  acceptanceCriteria?: string | null;
  estimatedMinutes?: number | null;
}

/** The descriptive-edit args forwarded to the repo (never any commercial field). */
type EditArgs = {
  title?: string;
  descriptionHtml?: string | null;
  acceptanceCriteria?: string | null;
  estimatedMinutes?: number | null;
};

/**
 * Expert edits a milestone's DESCRIPTIVE fields on a live, active engagement (D3).
 * `value_cents` is unrepresentable (schema `.strict()` + the repo `editDescriptive`
 * signature omits it). Diffs the provided values against the pre-loaded node to build
 * `fields_changed`; a title-only edit is "cosmetic" (debounced correlationId), any
 * other change is "material" (always re-notifies — Decision D). Fires `MILESTONE_EDITED`
 * and publishes `engagement.scope_changed` (`changeKind:'edited'`) — fire-and-forget.
 */
export async function updateMilestoneAction(
  input: UpdateMilestoneInput
): Promise<MilestoneActionResult> {
  const auth = await requireExpertUser();
  if (!auth.ok) {
    return { success: false, error: auth.error };
  }
  const parsed = updateInputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: INVALID_REQUEST };
  }
  const data = parsed.data;

  return runExpertEngagementAction(
    auth.user,
    data.engagementId,
    { milestoneId: data.milestoneId },
    'Failed to update milestone',
    async ({ user, engagement, milestone }) => {
      if (milestone === undefined) {
        // Unreachable — the `{ milestoneId }` IDOR check guarantees the node.
        return { success: false, error: MILESTONE_GONE };
      }

      // Only genuinely-CHANGED descriptive fields are written + audited: the edit form
      // may re-send every field on each save, so gating `editArgs` on the SAME diff that
      // drives `fieldsChanged` keeps the repo write, the D0 audit `metadata.fields`, and
      // the `MILESTONE_EDITED` analytics perfectly consistent — and avoids redundant
      // writes. (`undefined` = field omitted; an explicit `null` that differs = a clear.)
      const editArgs: EditArgs = {};
      const fieldsChanged: string[] = [];

      if (data.title !== undefined && data.title !== milestone.title) {
        editArgs.title = data.title;
        fieldsChanged.push('title');
      }
      if (data.descriptionText !== undefined) {
        // Diff on PLAIN TEXT (the editable surface), NOT on re-derived HTML. A milestone
        // snapshotted from a proposal holds RICH `description_html` (lists/bold/links), and
        // the edit form prefills its plain-text projection (`htmlToPlainText`). Re-deriving
        // flat HTML from that prefill and comparing it to the original rich HTML would ALWAYS
        // differ on an UNTOUCHED save — silently flattening the description AND misclassifying
        // a title-only edit as "material" (bypassing the cosmetic debounce → over-notifying).
        // Only when the plain text genuinely changed do we write + flag `description_html`.
        const currentPlain = htmlToPlainText(milestone.descriptionHtml ?? '');
        const nextPlain = (data.descriptionText ?? '').trim();
        if (currentPlain !== nextPlain) {
          editArgs.descriptionHtml = descriptionTextToSafeHtml(data.descriptionText);
          fieldsChanged.push('description_html');
        }
      }
      if (
        data.acceptanceCriteria !== undefined &&
        data.acceptanceCriteria !== milestone.acceptanceCriteria
      ) {
        editArgs.acceptanceCriteria = data.acceptanceCriteria;
        fieldsChanged.push('acceptance_criteria');
      }
      if (
        data.estimatedMinutes !== undefined &&
        data.estimatedMinutes !== milestone.estimatedMinutes
      ) {
        editArgs.estimatedMinutes = data.estimatedMinutes;
        fieldsChanged.push('estimated_minutes');
      }

      // No-op edit (the UI won't normally submit unchanged) — succeed without a write,
      // an analytics event, or a notification.
      if (fieldsChanged.length === 0) {
        return { success: true, milestoneId: milestone.id, status: milestone.status };
      }

      const outcome = await runMilestoneTransition(() =>
        engagementMilestonesRepository.editDescriptive({
          milestoneId: milestone.id,
          userId: user.id,
          ...editArgs,
        })
      );
      if (!outcome.ok) {
        return { success: false, error: outcome.error };
      }
      const updated = outcome.value;

      trackServerAndFlush(ENGAGEMENT_SERVER_EVENTS.MILESTONE_EDITED, {
        engagement_id: engagement.id,
        milestone_id: updated.id,
        fields_changed: fieldsChanged,
        distinct_id: user.id,
      });

      // Decision D: material edits get a fresh key (always re-notify); cosmetic
      // (title-only) edits get a time-bucketed key so a burst collapses to one.
      const isMaterial = fieldsChanged.some((f) => f !== 'title');
      const correlationId = isMaterial
        ? `${updated.id}:edited:${updated.updatedAt.getTime()}`
        : `${updated.id}:edited:${Math.floor(Date.now() / EDIT_COSMETIC_DEBOUNCE_MS)}`;

      await publishScopeChange(engagement, {
        changeKind: 'edited',
        milestoneId: updated.id,
        milestoneTitle: updated.title,
        correlationId,
      });

      log.info('Milestone updated', {
        engagementId: engagement.id,
        milestoneId: updated.id,
        userId: user.id,
        fields_changed: fieldsChanged,
      });
      return { success: true, milestoneId: updated.id, status: updated.status };
    }
  );
}

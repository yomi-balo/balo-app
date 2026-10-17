import { HELP_FEEDBACK_COMMENT_MAX } from '@balo/analytics/events';
import type { HelpEventMap } from '@/lib/analytics'; // TYPE-ONLY — erased

export type HelpFeedbackPayload = HelpEventMap['help_feedback_submitted'];

/**
 * Builds the `help_feedback_submitted` payload. The free-text `comment` is sent only for an
 * unhelpful verdict with a non-empty trimmed note, capped at {@link HELP_FEEDBACK_COMMENT_MAX};
 * `has_comment` mirrors exactly whether it is present.
 */
export function toFeedbackPayload(
  slug: string,
  helpful: boolean,
  raw?: string
): HelpFeedbackPayload {
  const comment = helpful ? '' : (raw ?? '').trim().slice(0, HELP_FEEDBACK_COMMENT_MAX);
  if (comment === '') return { slug, helpful, has_comment: false };
  return { slug, helpful, has_comment: true, comment };
}

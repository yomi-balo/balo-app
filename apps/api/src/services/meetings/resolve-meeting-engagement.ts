/**
 * BAL-483 (§5.1) — meeting → ENGAGEMENT, for the transcription producer.
 *
 * ⚠⚠ IT IS A READ, NOT A GATE (ADR-1029). It reports which engagement (if any) a meeting is
 * anchored to and says NOTHING about who may see it. Both callers are SYSTEM jobs with no
 * human actor, so no capability applies — but nobody may later mistake this for authorization.
 *
 * ⚠ IT REUSES THE SHARED COMBINING RULE, and must not grow a second one.
 * `selectPrimaryMeetingContext` (`@balo/shared/meetings`, BAL-408) is the ONE definition of
 * "which of a meeting's contexts governs it", complete with its precedence tiers and its
 * fail-closed `ambiguous` answer. `open-session.ts`'s resolver is a DIFFERENT shape (case-only,
 * IDOR-gated for its own money caller) — a pattern to learn from, never a function to reuse.
 *
 * ⚠ ENGAGEMENT STATUS IS DELIBERATELY **NOT** CHECKED — the opposite of `open-session.ts`,
 * and for a stated reason. There, a non-`active` engagement must not be a BILLING handle.
 * Here, a case closed minutes after the consultation is the NORMAL ending, and refusing it
 * would silently lose the recap for the most common shape. BAL-387's stage 6 already
 * degrades gracefully for a non-active engagement (`transcriptsRepository.recordStageSkip`,
 * which leaves `status` alone). Existence is checked only because
 * `transcripts.engagement_id` is a real FK.
 */
import { meetingsRepository, engagementsRepository } from '@balo/db';
import {
  selectPrimaryMeetingContext,
  type MeetingContextTypeWithHolder,
} from '@balo/shared/meetings';

/**
 * The four labels whose `context_id` names an `engagements.id`.
 *
 * ⚠ `Extract`, NOT A BARE UNION — the `context-owner.ts` discipline. A label RENAMED in the
 * database silently drops out of this type instead of leaving a stale name behind, which is
 * what makes the switch below stop compiling rather than stop matching.
 */
export type EngagementGrainContextType = Extract<
  MeetingContextTypeWithHolder,
  'case' | 'project_kickoff' | 'package_session' | 'retainer_checkin'
>;

const ENGAGEMENT_GRAIN_CONTEXT_TYPES = [
  'case',
  'project_kickoff',
  'package_session',
  'retainer_checkin',
] as const satisfies readonly EngagementGrainContextType[];

/** Type predicate over the const tuple above — never a cast. */
function isEngagementGrainContextType(
  contextType: MeetingContextTypeWithHolder
): contextType is EngagementGrainContextType {
  return (ENGAGEMENT_GRAIN_CONTEXT_TYPES as readonly string[]).includes(contextType);
}

/**
 * Five outcomes, deliberately DISTINCT rather than collapsed into `string | undefined` — each
 * maps to its own closed analytics `reason`, and only some are worth a `log.warn`.
 */
export type MeetingEngagementResolution =
  | {
      readonly outcome: 'resolved';
      readonly engagementId: string;
      readonly contextType: EngagementGrainContextType;
    }
  /** The primary context is request-grain (`project_discovery` / `request_interaction`), or the
   *  meeting is `admin`-only / context-less. A CLEAN no-op, never a failure. */
  | {
      readonly outcome: 'no_engagement_context';
      readonly contextType: MeetingContextTypeWithHolder | null;
    }
  /** Two distinct subjects tie at the top precedence tier. Fail-closed, per BAL-408. */
  | { readonly outcome: 'ambiguous_context' }
  /** The context names an engagement id with no live row — a corrupt/raced anchor. */
  | { readonly outcome: 'engagement_missing'; readonly engagementId: string }
  | { readonly outcome: 'meeting_not_found' };

/**
 * Resolve a meeting's governing engagement, if it has one.
 *
 * 1. `meetingsRepository.findWithContexts` — filters soft-deleted contexts, `undefined` for a
 *    missing meeting.
 * 2. `selectPrimaryMeetingContext` over the live contexts.
 * 3. Narrow the winning context type to the four engagement-grain labels.
 * 4. `engagementsRepository.findById` — filters `deleted_at`.
 */
export async function resolveMeetingEngagement(
  meetingId: string
): Promise<MeetingEngagementResolution> {
  const found = await meetingsRepository.findWithContexts(meetingId);
  if (found === undefined) {
    return { outcome: 'meeting_not_found' };
  }

  const primary = selectPrimaryMeetingContext(found.contexts);
  if (!primary.ok) {
    if (primary.reason === 'ambiguous') {
      return { outcome: 'ambiguous_context' };
    }
    return { outcome: 'no_engagement_context', contextType: null };
  }

  if (!isEngagementGrainContextType(primary.context.contextType)) {
    return { outcome: 'no_engagement_context', contextType: primary.context.contextType };
  }

  const engagementId = primary.context.contextId;
  const engagement = await engagementsRepository.findById(engagementId);
  if (engagement === undefined) {
    return { outcome: 'engagement_missing', engagementId };
  }

  return {
    outcome: 'resolved',
    engagementId: engagement.id,
    contextType: primary.context.contextType,
  };
}

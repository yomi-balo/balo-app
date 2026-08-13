/**
 * BAL-435 (ruling R6 / Q1) — a HUMAN LABEL for the context a meeting belongs to.
 *
 * ⚠⚠ IT RUNS **AFTER** AUTHORIZATION, ON THE MEMBER ARM ONLY, AND IT ADDS NO NEW ACCESS.
 * `joinMeetingAsMember` calls it once it has already granted the call, so the caller learns
 * nothing they were not already entitled to. It must never be called from the guest or lobby
 * arms — those callers are anonymous or token-bearing and Decision 9's no-oracle rule applies
 * to them.
 *
 * ── ⚠⚠ WHY THREE OF THE SIX SHAPES ANSWER `null`, STATED RATHER THAN HIDDEN ────────────────
 *
 * Balo has no `meetings.title` column and no single "engagement title" concept. Titles live per
 * SUBTYPE:
 *
 *   · `case`                                    → `case_engagements.title`   (ONE read)
 *   · `project_discovery` / `request_interaction` → `project_requests.title` (ONE read)
 *   · `project_kickoff` / `package_session` / `retainer_checkin`
 *        → NO title column exists on `engagements` or on any of its delivery subtypes. A label
 *          for those would have to be SYNTHESISED from a proposal or a source request, which is
 *          a title CONCEPT this ticket has no mandate to design — and a confidently wrong title
 *          on a live call is worse than no title.
 *
 * So those three answer `null`, the web surface renders its neutral heading ("In the call"), and
 * "Back to {context}" still resolves correctly for all six because it needs only `type` + `id`.
 *
 * ⚠ IT NEVER THROWS AND IT NEVER FAILS THE JOIN. A label is decoration on a surface whose job is
 * to connect a call; a repository wobble degrades to `null`, never to a refused join.
 */
import { caseEngagementsRepository, projectRequestsRepository } from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import type { MemberJoinContext, PrimaryMeetingContext } from '@balo/shared/meetings';

const log = createLogger('meeting-context-label');

/** Trim and normalise an empty title to `null` — an empty heading reads as a bug. */
function normalise(title: string | null | undefined): string | null {
  const trimmed = title?.trim() ?? '';
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * ⚠ TOTAL OVER THE SIX HOLDER-BEARING SHAPES, WITH NO `default:` ARM. A seventh label added to
 * the enum fails `tsc` here rather than silently answering `null` forever.
 */
async function readTitle(context: PrimaryMeetingContext): Promise<string | null> {
  switch (context.contextType) {
    case 'case': {
      const row = await caseEngagementsRepository.findByEngagementId(context.contextId);
      return normalise(row?.title);
    }
    case 'project_discovery':
    case 'request_interaction': {
      const row = await projectRequestsRepository.findById(context.contextId);
      return normalise(row?.title);
    }
    // ⚠ NO TITLE COLUMN EXISTS FOR THESE THREE. See the module docblock — this is a stated
    // absence, not an omission.
    case 'project_kickoff':
    case 'package_session':
    case 'retainer_checkin':
      return null;
  }
}

/**
 * The context envelope for a member's join response, or `null` when nothing useful resolved.
 *
 * ⚠ `type` AND `id` ARE ALWAYS PRESENT ON SUCCESS — they are what "Back to {context}" needs, and
 * they are already in hand (they are what `MEETING_JOIN_GRANTED.context_type` is emitted from).
 * Only `title` is best-effort.
 */
export async function resolveMeetingContextLabel(
  context: PrimaryMeetingContext
): Promise<MemberJoinContext> {
  let title: string | null = null;
  try {
    title = await readTitle(context);
  } catch (error) {
    // ⚠ HANDLED, NOT RE-THROWN — so CLAUDE.md's rule applies and the original reason is kept.
    // ⚠ NO TITLE VALUE AND NO TOKEN IN THIS LOG; the ids already identify the row.
    log.error(
      {
        contextType: context.contextType,
        contextId: context.contextId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      'Meeting context label lookup failed — falling back to no title'
    );
  }
  return { type: context.contextType, id: context.contextId, title };
}

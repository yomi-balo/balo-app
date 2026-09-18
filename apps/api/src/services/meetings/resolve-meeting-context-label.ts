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
 *   · `case`                → `case_engagements.title`                        (ONE read)
 *   · `project_discovery`   → `project_requests.title`, keyed by `context_id` (ONE read)
 *   · `request_interaction` → `request_expert_relationships` → `project_requests.title`
 *                                                                              (TWO reads —
 *          BAL-567 / D1. `context_id` on this arm is a RELATIONSHIP id, not a request id; it
 *          used to be passed straight to `projectRequestsRepository.findById`, which matched
 *          nothing and silently nulled the heading for every such meeting.)
 *   · `project_kickoff` / `package_session` / `retainer_checkin`
 *        → NO title column exists on `engagements` or on any of its delivery subtypes. A label
 *          for those would have to be SYNTHESISED from a proposal or a source request, which is
 *          a title CONCEPT this ticket has no mandate to design — and a confidently wrong title
 *          on a live call is worse than no title.
 *
 * So those three answer `null` and the web surface renders its neutral heading ("In the call").
 *
 * ⚠ BAL-567 — THIS RESOLVER ALSO SUPPLIES THE "Back to {context}" LINK TARGET. It used to need
 * only `type` + `id`; as of BAL-567 the web side routes through the ONE shared `hrefForMeeting`
 * table, which resolves the two request-grain arms through `projectRequestId` rather than the
 * polymorphic `context_id`. That column is produced here, by the same hop that fixes the title.
 *
 * ⚠ IT NEVER THROWS AND IT NEVER FAILS THE JOIN. A label is decoration on a surface whose job is
 * to connect a call; a repository wobble degrades to `null`, never to a refused join.
 */
import {
  caseEngagementsRepository,
  projectRequestsRepository,
  requestExpertRelationshipsRepository,
} from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import type { MemberJoinContext, PrimaryMeetingContext } from '@balo/shared/meetings';

const log = createLogger('meeting-context-label');

/** Trim and normalise an empty title to `null` — an empty heading reads as a bug. */
function normalise(title: string | null | undefined): string | null {
  const trimmed = title?.trim() ?? '';
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * The two facts a context envelope carries beyond `type`/`id`: the heading, and the RESOLVED
 * `project_requests.id` the "Back to …" link needs.
 */
interface ContextFacts {
  readonly title: string | null;
  readonly projectRequestId: string | null;
}

const NO_FACTS: ContextFacts = { title: null, projectRequestId: null };

/**
 * Read a request's title once its id is known. Shared by both request-grain arms, so the two can
 * never answer differently about the same row.
 *
 * ⚠ THE ID IS REPORTED ONLY WHEN THE ROW RESOLVED. A request that is gone must yield no link
 * target, not a confident one — the same fail-closed rule `hrefForMeeting`'s `owningRowFound`
 * gate applies to every other arm.
 */
async function readRequestFacts(projectRequestId: string): Promise<ContextFacts> {
  const row = await projectRequestsRepository.findById(projectRequestId);
  return row === undefined ? NO_FACTS : { title: normalise(row.title), projectRequestId };
}

/**
 * ⚠ TOTAL OVER THE SIX HOLDER-BEARING SHAPES, WITH NO `default:` ARM. A seventh label added to
 * the enum fails `tsc` here rather than silently answering `null` forever.
 *
 * ⚠⚠ THE TWO REQUEST-GRAIN ARMS ARE **SPLIT**, AND BAL-567 (D1) SPLIT THEM TO FIX A LIVE BUG.
 * They used to share one arm that passed `context.contextId` straight to
 * `projectRequestsRepository.findById`. That is right for `project_discovery`, whose `context_id`
 * IS the request id — and WRONG for `request_interaction`, whose `context_id` is a
 * `request_expert_relationships.id`. `findById` therefore matched nothing, and the in-call
 * heading was silently `null` for EVERY `request_interaction` meeting: no error, no log, just a
 * neutral heading that read as "this kind has no title". `request_interaction` now makes the
 * relationship → request hop first, exactly as `upcoming-meetings.ts` and `meetings.ts` already
 * do, which fixes the title AND supplies the link target in the same pass.
 *
 * ⚠ THIS IS THE SAME DEFECT `back-to-context.ts` CARRIED, in a second place — it built
 * `/projects/{contextId}` from the same relationship id. Both were fixed in BAL-567; if you are
 * here because one of them regressed, check the other.
 */
async function readContextFacts(context: PrimaryMeetingContext): Promise<ContextFacts> {
  switch (context.contextType) {
    case 'case': {
      const row = await caseEngagementsRepository.findByEngagementId(context.contextId);
      return { title: normalise(row?.title), projectRequestId: null };
    }
    case 'project_discovery':
      // `context_id` IS the `project_requests.id` on this arm — one read, no hop.
      return readRequestFacts(context.contextId);
    case 'request_interaction': {
      // `context_id` is a `request_expert_relationships.id`. Resolve the request id first.
      const relationship = await requestExpertRelationshipsRepository.findById(context.contextId);
      return relationship === undefined
        ? NO_FACTS
        : readRequestFacts(relationship.projectRequestId);
    }
    // ⚠ NO TITLE COLUMN EXISTS FOR THESE THREE. See the module docblock — this is a stated
    // absence, not an omission. They carry no request either.
    case 'project_kickoff':
    case 'package_session':
    case 'retainer_checkin':
      return NO_FACTS;
  }
}

/**
 * The context envelope for a member's join response, or `null` when nothing useful resolved.
 *
 * ⚠ `type` AND `id` ARE ALWAYS PRESENT ON SUCCESS — they are already in hand (they are what
 * `MEETING_JOIN_GRANTED.context_type` is emitted from). `title` AND `projectRequestId` are both
 * best-effort: a repository wobble degrades them TOGETHER, never one without the other, because
 * a link target inferred from a failed read is the wrong-id bug rather than a graceful fallback.
 */
export async function resolveMeetingContextLabel(
  context: PrimaryMeetingContext
): Promise<MemberJoinContext> {
  let facts: ContextFacts = NO_FACTS;
  try {
    facts = await readContextFacts(context);
  } catch (error) {
    // ⚠ HANDLED, NOT RE-THROWN — so CLAUDE.md's rule applies and the original reason is kept.
    // ⚠ NO TITLE VALUE AND NO TOKEN IN THIS LOG; the ids already identify the row.
    // ⚠ BOTH facts degrade together, deliberately: a read that failed tells us nothing about
    // the request id either, and a link target guessed from a failed read is the bug this
    // ticket removed, not a graceful degradation.
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
  return {
    type: context.contextType,
    id: context.contextId,
    title: facts.title,
    projectRequestId: facts.projectRequestId,
  };
}

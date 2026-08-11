/**
 * The conversation primitive's PURE surface (BAL-424 / ADR-1045 §2).
 *
 * PURE and dependency-free (no `@balo/db`, no I/O) — the `@balo/shared/engagements` /
 * `@balo/shared/meetings` precedent — so `apps/web`, `apps/api` and `@balo/db` can all
 * speak the same read-scope vocabulary without the client-bundle footgun (memory
 * `reference_balo_db_client_bundle_footgun`).
 *
 * It carries the read-scope vocabulary `@balo/db`'s read methods take as a REQUIRED
 * parameter, the label union those methods are pinned against, and the three pure RULES
 * that decide what a viewer may read and whether they may write.
 */

import type {
  GuestAccessScopeLabel,
  PrimaryMeetingContext,
  SelectPrimaryMeetingContextResult,
} from '../meetings';

/**
 * WHAT A VIEWER MAY READ OF ONE CONVERSATION. Consumed by `@balo/db`'s read methods as a
 * REQUIRED parameter — see `listMessagesPage`'s docblock for why it is not optional.
 *
 *   `full`    — every live message and file in the thread. Both parties, and an
 *               `engagement`-scoped guest whose engagement IS this conversation's.
 *   `meeting` — ONLY messages carrying `sent_during_meeting_id = meetingId`. A message sent
 *               OUTSIDE any call (`sent_during_meeting_id IS NULL`) is EXCLUDED — the guest
 *               sees their own call and nothing else. Files return `[]` (they are
 *               conversation-scoped and carry no meeting column; BAL-423's `meeting_files`
 *               is the guest's file surface).
 */
export type ConversationReadScope = { kind: 'full' } | { kind: 'meeting'; meetingId: string };

/**
 * The `conversation_context_type` labels, HAND-RESTATED — `packages/shared` cannot import a
 * pgEnum (that would make this subpath depend on `@balo/db` and drag `postgres` into every
 * client bundle that touches it).
 *
 * ⚠ PINNED AGAINST THE SCHEMA ENUM BY A TWO-WAY `AssertNever` DRIFT GUARD in
 * `packages/db/src/repositories/conversations.ts` — the one module that CAN see both. A
 * third label added to the pgEnum without adding it here fails `tsc` there, and vice versa.
 */
export type ConversationContextTypeLabel = 'relationship' | 'engagement';

/** A conversation's anchor, as this module's pure rules speak it. */
export interface ConversationSubject {
  readonly contextType: ConversationContextTypeLabel;
  readonly contextId: string;
}

/**
 * Map ONE resolved primary meeting context to the conversation subject it implies, or `null`
 * when it implies none. Pure — no I/O.
 *
 *   case | project_kickoff | package_session | retainer_checkin → engagements.id  ⇒ 'engagement'
 *   request_interaction                                        → relationship id ⇒ 'relationship'
 *   project_discovery                                          → a project_requests.id, which
 *     fans out to MANY relationships and therefore names NO single thread ⇒ null (fail closed).
 *
 * ⚠ TOTAL OVER `MeetingContextTypeWithHolder` WITH A `never` DEFAULT, so a seventh
 * holder-bearing meeting label stops typechecking here until an arm is consciously written.
 * (`admin` is absent from that union by construction — `selectPrimaryMeetingContext` drops
 * it — which is also why this seam has no `admin` conversation label to map onto.)
 */
export function conversationSubjectForMeetingContext(
  ctx: PrimaryMeetingContext
): ConversationSubject | null {
  switch (ctx.contextType) {
    case 'case':
    case 'project_kickoff':
    case 'package_session':
    case 'retainer_checkin':
      return { contextType: 'engagement', contextId: ctx.contextId };
    case 'request_interaction':
      return { contextType: 'relationship', contextId: ctx.contextId };
    case 'project_discovery':
      // A discovery meeting names the REQUEST, which fans out to every invited expert's
      // thread. No single conversation is implied, so the honest answer is "none".
      return null;
    default: {
      // Exhaustiveness: a seventh holder-bearing label fails to compile here.
      const unreachable: never = ctx.contextType;
      return unreachable;
    }
  }
}

export interface ResolveGuestConversationScopeInput {
  /** `meeting_guests.access_scope`, AS RECORDED at invite time — never re-derived. */
  readonly guestAccessScope: GuestAccessScopeLabel;
  /** The meeting the guest was invited to (`meeting_guests.meeting_id`). */
  readonly guestMeetingId: string;
  /** `selectPrimaryMeetingContext(contexts)` over the GUEST's OWN meeting. */
  readonly guestMeetingPrimaryContext: SelectPrimaryMeetingContextResult;
  /** The TARGET conversation's LIVE `conversation_contexts` rows. */
  readonly conversationContexts: readonly ConversationSubject[];
}

/**
 * THE MEETING-LEVEL GUEST FILTER, as a pure rule. Pure so it can be tested exhaustively with
 * no session, no meeting and no database — which matters, because there is NO
 * guest-authenticated read session on `main` (`/join/[token]` resolves an identity claim
 * only), so this rule has no live producer yet. BAL-132 / BAL-388 are the first callers.
 *
 * ⚠ THE TIER LABELS ARE `meeting` | `engagement`, NOT "case-level" — `guest_access_scope`
 * names the ADR-1045 SUPERTYPE deliberately, since `case` is one of four `engagement_type`
 * values. Render "case" in COPY; write `engagement` in code.
 *
 * ⚠ IT DELIBERATELY DOES **NOT** CALL `guestMayReadMeeting`, AND THAT IS A CORRECTION, NOT AN
 * OVERSIGHT. An earlier draft did — but a CONVERSATION is not a meeting, so there is no second
 * `targetMeetingId` to compare against, and the call could only be made by passing the guest's
 * OWN meeting id for both parameters. That makes the predicate's first branch
 * (`guestMeetingId === targetMeetingId`) unconditionally true: a dead conjunct dressed up as
 * reuse, which would leave a reader believing the shipped rule was doing work it was not.
 *
 * The rule implemented here is the CONVERSATION-grain analogue, stated once: an
 * `engagement`-scoped guest reads the whole thread IFF that thread is anchored to the
 * engagement their own meeting resolves to. `guestMayReadMeeting` remains the authority for
 * MEETING artefacts (BAL-388 enforces it); the two are siblings, neither wrapping the other.
 *
 * The envelope comes from the guest's own meeting's contexts via `selectPrimaryMeetingContext`,
 * which is FAIL-CLOSED and can answer `ambiguous`. `ambiguous` ⇒ `null` ⇒ deny, never a silent
 * fallback to `full`.
 *
 * ⚠ THE NARROW GRANT IS NEVER WIDENED BY DATA. A `meeting`-scoped guest returns the meeting
 * scope before any context is even looked at, so no shape of `conversationContexts` can
 * promote them.
 *
 * @returns the scope to pass to `@balo/db`'s read methods, or `null` to DENY outright.
 */
export function resolveGuestConversationScope(
  input: ResolveGuestConversationScopeInput
): ConversationReadScope | null {
  const meetingScope: ConversationReadScope = {
    kind: 'meeting',
    meetingId: input.guestMeetingId,
  };

  if (input.guestAccessScope === 'meeting') {
    return meetingScope;
  }

  // `engagement` scope: the envelope-wide grant only holds when the guest's OWN meeting
  // unambiguously names a subject AND the target conversation is anchored to that subject.
  if (!input.guestMeetingPrimaryContext.ok) {
    // `none` or `ambiguous` — fail closed. Never a silent fallback to `full`.
    return null;
  }

  const subject = conversationSubjectForMeetingContext(input.guestMeetingPrimaryContext.context);
  if (subject === null) {
    // A `project_discovery` guest: their meeting names no single thread, so they keep their
    // own call and get no envelope-wide grant.
    return meetingScope;
  }

  const anchored = input.conversationContexts.some(
    (ctx) => ctx.contextType === subject.contextType && ctx.contextId === subject.contextId
  );
  return anchored ? { kind: 'full' } : meetingScope;
}

/**
 * The `engagement_status` labels, HAND-RESTATED for the same reason as
 * {@link ConversationContextTypeLabel} — `packages/shared` cannot import a pgEnum.
 *
 * ⚠ PINNED AGAINST `@balo/db`'s `EngagementStatus` by a two-way `AssertNever` drift guard in
 * `apps/web/src/lib/conversations/authorize-conversation-context.ts`, the module that can see
 * both.
 */
export type EngagementStatusLabel = 'active' | 'completed' | 'cancelled';

/**
 * THE CLOSED-CASE READ-ONLY RULE, as a pure predicate. `engagement_status` is exactly
 * `active | completed | cancelled`; `caseEngagementsRepository.close()` writes `completed`
 * and nothing ever clears it, so a closed case is permanently read-only.
 *
 * ⚠ THE RELATIONSHIP ARM IS NOT ROUTED THROUGH HERE. Project threads keep their shipped
 * `THREAD_OPEN_RELATIONSHIP_STATUSES` gate in `conversation-view-types.ts`; the two rules
 * have different subjects (a relationship lifecycle vs an engagement lifecycle) and unifying
 * them is BAL-421's call once both surfaces exist.
 *
 * ⚠ READ-ONLY MEANS THE WRITE PATH REFUSES. It does not mean the thread disappears: history
 * stays fully readable, which is the entire point of anchoring it to the engagement.
 */
export function engagementConversationIsWritable(status: EngagementStatusLabel): boolean {
  return status === 'active';
}

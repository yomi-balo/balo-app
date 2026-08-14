import 'server-only';

import {
  engagementConversationIsWritable,
  type EngagementStatusLabel,
} from '@balo/shared/conversations';
import { authorizeEngagementConversation } from '@/lib/conversations/authorize-conversation-context';

/**
 * BAL-421 — THE CASE SURFACE'S READ GATE. A THIN LENS ADAPTER over the SHIPPED
 * `authorizeEngagementConversation`, not a second resolution chain.
 *
 * ⚠⚠ THE CHAIN IS NOT FORKED, AND THAT IS THE WHOLE POINT — the same ruling
 * `resolve-recap-access.ts` records over `authorizeMeetingFileAccess`. "Who may read this
 * engagement's thread" is defined ONCE, in `authorize-conversation-context.ts`: engagement
 * load → membership/visibility side resolution → only then the thread read. That module is
 * UNTOUCHED by this ticket, and so is its test. This file only RENAMES what it returns and
 * composes one already-shipped predicate. **BAL-421 is that gate's first production caller**
 * — it shipped inert, by the same BAL-408 / BAL-413 precedent of landing a gate ahead of its
 * surface.
 *
 * ⚠⚠ THIS IS THE TENANCY DISCHARGE FOR **TWO** POLYMORPHIC SEAMS, AND IT IS THE OBLIGATION
 * `packages/db/src/schema/meeting-contexts.ts` ASSIGNS TO BAL-421 BY NAME. Both
 * `meeting_contexts.context_id` and `conversation_contexts.context_id` have NO FK and NO
 * RLS, so an unchecked `engagementId` from the URL resolves to another tenant's rows and the
 * read path returns them verbatim. NOTHING may pass `engagementId` to
 * `listMeetingsForContext` — or to any conversation read — until this has returned non-null.
 *
 * ⚠ ORDERING (BAL-129). The gate runs the MEMBERSHIP check before it reports any state, so a
 * stranger cannot distinguish states of a guessed uuid by response alone. The case-TYPE
 * coherence check (`caseEngagementsRepository.findByEngagementId`, which filters
 * `engagement_type = 'case'`) therefore runs AFTER this, in the loader — which is what stops
 * it acting as an existence oracle: a project engagement id and a cross-tenant id produce the
 * SAME 404.
 *
 * ⚠ THE LENS IS THE GATE'S `side`, RENAMED — resolved server-side from party membership
 * against the engagement's own row. It is NEVER `users.activeMode` (a view toggle, never an
 * authorization input — ADR-1029), never a role comparison, and never anything from the URL.
 *
 * ⚠ THE EXPERT ARM **IS** `actorHasExpertSideVisibility`, CONSUMED THROUGH THE GATE. The case
 * surface deliberately does NOT call that predicate itself: a direct second call site is a
 * second consumption point that can drift. `access.lens === 'expert'` IS that rule's answer.
 * The set is deliberately WIDER than the act axis (delivering expert ∪ ANY live agency member,
 * INCLUDING role `expert`) — ADR-1046 §7: **do not narrow it.** An agency colleague reads the
 * whole surface; they just cannot ask the client to resolve it (that is the act axis, in
 * `lib/authz/engagement.ts`).
 *
 * ⚠ ONE `null` FOR EVERY DENIAL. Missing, soft-deleted, cross-tenant, no-capability,
 * no-expert-profile and no-thread all collapse into it, exactly as the underlying gate
 * collapses them into one `conversation_not_found` literal. The SHAPE goes to that gate's own
 * `log.warn` (with a distinct `reason`); the caller answers ONE `notFound()` with ONE copy.
 *
 * ── ⚠ ACCEPTED COUPLING, STATED SO IT IS NOT REDISCOVERED AS A MYSTERY 404 ────────────────
 * Because the gate returns one literal, a case whose CONVERSATION row is missing or
 * soft-deleted 404s the WHOLE surface (gate `reason: 'no_thread'`), not just its conversation
 * panel. This is accepted because `caseEngagementsRepository.create()` provisions the thread
 * in the SAME TRANSACTION as the case, making a thread-less live case structurally
 * unreachable through the product path. Two mitigations, both required and both in place:
 *   1. the denial is observable in Axiom as `reason: 'no_thread'` with `engagementId` +
 *      `companyId`;
 *   2. an INTEGRATION test pins the coupling — a case created via `create()` always yields a
 *      live `conversationsRepository.findByContext({contextType:'engagement', …})` — so a
 *      future change to `create()` fails loudly instead of 404-ing live cases.
 * If it ever does bite, the fix is a BAL-424 follow-up splitting the gate's thread read from
 * its side resolution — NOT a second side resolver here.
 */

export interface CaseAccess {
  /** A rename of the gate's `side`. NEVER `activeMode`. */
  lens: 'client' | 'expert';
  engagementId: string;
  companyId: string;
  /** NOT NULL on the supertype (BAL-417) — narrowed at the gate so no caller re-defends it. */
  expertProfileId: string;
  engagementStatus: EngagementStatusLabel;
  conversationId: string;
  /**
   * `engagementConversationIsWritable(status)`, resolved ONCE here so no call site re-derives
   * it. A CLOSED case stays fully READABLE by everyone who could read it while it was open —
   * read access and write access are separate questions, and the gate decides only the first.
   */
  conversationWritable: boolean;
}

/** Resolve a viewer onto one side of a case, or `null`. Never an existence oracle. */
export async function resolveCaseAccess(
  engagementId: string,
  userId: string
): Promise<CaseAccess | null> {
  const access = await authorizeEngagementConversation({ engagementId, userId });
  if (!access.ok) {
    return null;
  }
  return {
    lens: access.side,
    engagementId,
    companyId: access.companyId,
    expertProfileId: access.expertProfileId,
    engagementStatus: access.engagementStatus,
    conversationId: access.conversationId,
    conversationWritable: engagementConversationIsWritable(access.engagementStatus),
  };
}

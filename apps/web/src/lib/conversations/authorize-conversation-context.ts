import 'server-only';

import {
  conversationsRepository,
  engagementsRepository,
  expertsRepository,
  partyMembershipsRepository,
  type EngagementStatus,
} from '@balo/db';
import { actorHasExpertSideVisibility, CAPABILITIES, roleHasCapability } from '@balo/shared/authz';
import type { EngagementStatusLabel } from '@balo/shared/conversations';
import { log } from '@/lib/logging';

/**
 * BAL-424 — THE TENANCY GATE FOR AN ENGAGEMENT-ANCHORED CONVERSATION.
 *
 * ⚠ WHY IT EXISTS: `conversation_contexts.context_id` has NO FK and NO RLS. An unchecked
 * `engagementId` resolves to a live conversation belonging to another tenant, and the read
 * path then returns that company's private messages verbatim. This is the gate. The
 * obligation is assigned to BAL-424 by name on `packages/db/src/schema/meeting-contexts.ts`.
 *
 * ── ORDERING — COPIED FROM `authorize-meeting-booking.ts` (BAL-129) AND
 *    `authorize-meeting-participation.ts` (BAL-408) ────────────────────────────
 * 1. load the engagement (`engagementsRepository.findById` filters `deleted_at IS NULL`, so
 *    missing and soft-deleted are ONE outcome — which is what lets them share one literal);
 * 2. CLIENT SIDE — membership axis, COMPANY scope, `PARTICIPATE` via
 *    `partyMembershipsRepository.getMemberRole('company', …)` + `roleHasCapability`
 *    (ADR-1029 HARD CONSTRAINT B: never `role === 'owner'`);
 * 3. EXPERT SIDE — reached ONLY when the actor holds no company membership, so the two arms
 *    cannot both fire and the side is unambiguous;
 * 4. ONLY THEN is any STATE read reported — and even then this gate reports it rather than
 *    acting on it.
 *
 * Running a state check before authorization would let an actor with membership NOWHERE
 * distinguish states of a guessed uuid by response alone — an existence oracle over every
 * `engagements.id` on the platform, readable by any self-serve signup.
 *
 * ⚠ EVERY DENIAL COLLAPSES INTO ONE LITERAL. There is no `forbidden`, no `not_a_member`, no
 * `no_such_conversation`. WHICH SHAPE IT WAS GOES TO THE LOG (`log.warn`, distinct `reason`
 * per shape), NEVER TO THE WIRE. Precedents: `sessionActorErrorStatus`'s `not_found → 404`
 * "(also hides existence)", `openSession`'s `meeting_not_bookable` (six shapes, one literal),
 * `authorizeMeetingBooking`'s single `context_not_found`.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * ⚠⚠ (a) WHY THE ENGAGEMENT CAPABILITY AXIS IS **NOT** USED HERE — ACT vs READ.
 * ──────────────────────────────────────────────────────────────────────────────
 * The obvious-looking move is `hasEngagementCapability(actor, MANAGE_ENGAGEMENT, subject)`.
 * IT IS THE WRONG AXIS, and not for packaging reasons (that seam being `apps/api`-only today
 * is a consequence, not the argument). That axis has exactly two tokens — `host_meetings`
 * (live/in-meeting) and `manage_engagement` (administrative acts: reschedule
 * propose/withdraw, expert-side cancel, request case resolution) — and CLAUDE.md states
 * plainly that a `true` from that seam "authorizes the ACT, never the READ". READING A THREAD
 * IS NOT AN ACT. Gating a read on an act token would be a category error wherever the module
 * lived, and it would ALSO deny the wrong people: that holder set excludes agency role
 * `expert`, who are precisely the colleagues most likely to need to read a delivery thread.
 *
 * ⚠ COROLLARY, STATED SO IT IS NOT UNDONE: THIS MODULE DOES NOT OPEN — AND DOES NOT USE —
 * THE `apps/web` ENGAGEMENT-AXIS SEAM. That seam is now OPEN (`apps/web/src/lib/authz/
 * engagement.ts`, opened by BAL-421, whose expert-side "request case resolution" is a
 * `manage_engagement` act), so the packaging accident that used to make this impossible is
 * GONE — and the argument above is unaffected, because it never rested on packaging. Reading
 * a thread is still not an act. Nothing here imports `hasEngagementCapability`, and
 * `authorize-conversation-context.test.ts` asserts that statically; that assertion is now
 * load-bearing rather than incidental, and MUST NOT be relaxed.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * ⚠⚠ (b) THE EXPERT ARM CONSUMES THE SHIPPED **VISIBILITY** RULE — IT DOES NOT INVENT ONE.
 * ──────────────────────────────────────────────────────────────────────────────
 * The rule is `actorHasExpertSideVisibility` (`@balo/shared/authz`) — **consumed, not mirrored**
 * (BAL-419): THE DELIVERING EXPERT ∪ ANY LIVE MEMBER OF THAT EXPERT'S AGENCY (any agency role,
 * including `expert`). Rights sit on agency membership (ADR-1029); an independent expert
 * (`agencyId === null`) short-circuits on `profile.userId === userId` with NO agency lookup.
 * Membership EXISTING grants — never a role comparison, never `roleHasCapability` — because
 * the question is "is this person inside the agency", not "does their role carry a token".
 *
 * ⚠ THAT SET IS WIDER THAN THE ENGAGEMENT AXIS'S HOLDER SET, AND THE WIDTH IS THE POINT, NOT
 * DRIFT. CLAUDE.md (ADR-1046 §7, resolved 2026-08-03) records it as DELIBERATE AND PERMANENT:
 * "visibility (delivering expert ∪ any live agency member) and act rights (delivering expert
 * ∪ agency owner/admin) are different rules by design. Do not narrow it." A conversation read
 * is visibility. Reusing it is what satisfies BAL-424's Access section — consume what the
 * platform already settles, do not invent a fourth rule.
 *
 * ⚠ BAL-419 SETTLED IT: **CONFIRMED, NOT NARROWED**, and the rule now has exactly ONE
 * definition — `actorHasExpertSideVisibility` — which this module and the other two visibility
 * gates all CONSUME. There is no longer a local `agencyRole !== undefined` branch here to
 * change; the single line lives in `packages/shared/src/authz/expert-side-visibility.ts`, and
 * ADR-1046 §7 forbids narrowing it. Do not reintroduce a second definition anywhere.
 *
 * ⚠ WRITE RIGHTS ARE NOT DECIDED HERE. This returns a SIDE and the engagement's status; the
 * caller composes it with `engagementConversationIsWritable` (`@balo/shared/conversations`)
 * to decide whether the composer is enabled. Read access and write access are separate
 * questions, and a closed case stays readable by everyone who could read it while it was open.
 *
 * ⚠ IT SHIPS WITH NO PRODUCTION CALLER (BAL-421 is the first), fully unit-tested — the same
 * BAL-408 / BAL-413 precedent of landing a gate inert ahead of its surface.
 */

/**
 * Two-way drift guard between `@balo/db`'s `EngagementStatus` (derived from the pgEnum) and
 * the hand-restated `EngagementStatusLabel` in `@balo/shared/conversations` (which cannot
 * import a pgEnum). THIS module is one of the few that can see both. A fourth status added on
 * either side fails `tsc` here until it is added on the other.
 */
type MissingEngagementStatus = Exclude<EngagementStatus, EngagementStatusLabel>;
type StrayEngagementStatus = Exclude<EngagementStatusLabel, EngagementStatus>;
type AssertNever<T extends never> = T;
export type AssertEngagementStatusLabelsMatch = [
  AssertNever<MissingEngagementStatus>,
  AssertNever<StrayEngagementStatus>,
];

export type AuthorizeEngagementConversationResult =
  | {
      ok: true;
      side: 'client' | 'expert';
      companyId: string;
      expertProfileId: string;
      /** For `engagementConversationIsWritable` — the caller decides read-only, not this gate. */
      engagementStatus: EngagementStatusLabel;
      conversationId: string;
    }
  /** ONE literal. There is deliberately no `forbidden`. */
  | { ok: false; code: 'conversation_not_found' };

/** Every denial shape collapses here: distinct `reason` to the LOG, one literal to the wire. */
function deny(
  reason: 'no_engagement' | 'no_capability' | 'no_expert_profile' | 'cross_tenant' | 'no_thread',
  context: Record<string, unknown>
): AuthorizeEngagementConversationResult {
  log.warn('Engagement conversation access denied', { reason, ...context });
  return { ok: false, code: 'conversation_not_found' };
}

export async function authorizeEngagementConversation(input: {
  engagementId: string;
  userId: string;
}): Promise<AuthorizeEngagementConversationResult> {
  const { engagementId, userId } = input;

  const engagement = await engagementsRepository.findById(engagementId);
  if (engagement === undefined) {
    // Missing and soft-deleted are ONE outcome — which is what lets them share one literal.
    return deny('no_engagement', { engagementId, userId });
  }

  const side = await resolveSide(engagement.companyId, engagement.expertProfileId, userId);
  if (side.ok === false) {
    return side.denial;
  }

  // AUTHORIZATION IS COMPLETE ABOVE THIS LINE. Only now may we name the thread — and this is
  // a READ, never `ensureForContext`: a gate must not mint rows for an engagement whose
  // surface has not yet provisioned one.
  const conversation = await conversationsRepository.findByContext({
    contextType: 'engagement',
    contextId: engagementId,
  });
  if (conversation === undefined) {
    return deny('no_thread', { engagementId, userId, companyId: engagement.companyId });
  }

  return {
    ok: true,
    side: side.side,
    companyId: engagement.companyId,
    expertProfileId: engagement.expertProfileId,
    engagementStatus: engagement.status,
    conversationId: conversation.id,
  };
}

type SideResolution =
  | { ok: true; side: 'client' | 'expert' }
  | { ok: false; denial: AuthorizeEngagementConversationResult };

/**
 * CLIENT arm first (membership axis, company scope, `PARTICIPATE`), then the EXPERT arm — the
 * shipped visibility rule. The expert arm is reached ONLY when the actor holds no company
 * membership at all, so the two can never both fire and the reported side is unambiguous.
 */
async function resolveSide(
  companyId: string,
  expertProfileId: string,
  userId: string
): Promise<SideResolution> {
  const companyRole = await partyMembershipsRepository.getMemberRole('company', companyId, userId);
  if (companyRole !== undefined) {
    if (roleHasCapability(companyRole, CAPABILITIES.PARTICIPATE)) {
      return { ok: true, side: 'client' };
    }
    return { ok: false, denial: deny('no_capability', { companyId, userId }) };
  }

  const profile = await expertsRepository.findProfileById(expertProfileId);
  if (profile === undefined) {
    return { ok: false, denial: deny('no_expert_profile', { expertProfileId, userId }) };
  }

  // ⚠ THE SHARED VISIBILITY RULE — delegated to `actorHasExpertSideVisibility`; the
  // membership-existing branch now lives there and ONLY there. The delivering expert and an
  // INDEPENDENT expert both resolve with NO agency lookup at all (the callback is never
  // invoked) — asserted by call-count in this module's test, for BOTH profile shapes.
  //
  // ⚠ The lookup takes `actorId` as a PARAMETER rather than capturing `userId`, so a callback
  // can never answer for an actor other than the one being authorized (the confused-deputy
  // shape `HostContext.resolvedForActorId` closes on the act axis). Do not "simplify" it.
  const onExpertSide = await actorHasExpertSideVisibility(profile, userId, (agencyId, actorId) =>
    partyMembershipsRepository.getMemberRole('agency', agencyId, actorId)
  );
  if (onExpertSide) {
    return { ok: true, side: 'expert' };
  }

  return { ok: false, denial: deny('cross_tenant', { expertProfileId, userId }) };
}

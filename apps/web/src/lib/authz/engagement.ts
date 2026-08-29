import 'server-only';

import { engagementsRepository, expertsRepository, partyMembershipsRepository } from '@balo/db';
import {
  buildHostContextForExpertProfile,
  hostContextGrants,
  type EngagementCapability,
} from '@balo/shared/authz';
import { log } from '@/lib/logging';

/**
 * BAL-421 / ADR-1046 — the ENGAGEMENT-capability axis's async resolver for `apps/web`.
 *
 * ⚠⚠ THIS OPENS THE `apps/web` ENGAGEMENT-AXIS SEAM, AND BAL-421 IS ITS FIRST CONSUMER —
 * NOT BAL-410 / BAL-411. Four places on `main` recorded the seam as landing with those
 * tickets (CLAUDE.md, `lib/conversations/authorize-conversation-context.ts`,
 * `invariants/engagement-capability-not-membership.test.ts`, and `apps/api`'s
 * `authorize-engagement-host.ts`); ALL FOUR ARE CORRECTED IN THE SAME PR AS THIS FILE.
 * The deferral was recorded in good faith, but ADR-1046 lists "request case resolution" BY
 * NAME as a `manage_engagement` act, and that act is the case surface's expert-side
 * affordance — so the seam had to land here. This is a DOCUMENTATION CORRECTION, not a rule
 * change: the rule itself is unchanged and now has one definition for both apps.
 *
 * ⚠ IT IS A THIN FETCH-AND-CALL WRAPPER, NOT A SECOND DEFINITION OF THE HOLDER RULE. The
 * assembly lives in `@balo/shared/authz`'s `buildHostContextForExpertProfile` (extracted by
 * this ticket precisely so a second app could not fork it), and the grant decision lives in
 * `hostContextGrants`. Everything below is two repository reads and a log line. If you find
 * yourself writing `role === 'owner'`, `agencyId`, or a second short-circuit here, stop — the
 * rule is not in this file and must not become so.
 *
 * ── ⚠⚠ NOTHING IN THIS FILE AUTHORIZES A READ ────────────────────────────────────────────
 * A `true` authorizes the ACT, never the READ (CLAUDE.md). `meeting_contexts.context_id` has
 * NO FK and NO RLS, so resolving the context's owning party and checking membership is still
 * the CALLER'S obligation. On the case surface that obligation is discharged by
 * `resolveCaseAccess` BEFORE this is ever called — never after, and never instead.
 *
 * ⚠ AND IT SAYS NOTHING ABOUT ENGAGEMENT LIFECYCLE. `findById` filters `deleted_at` only;
 * `engagements.status` is never consulted. The delivering expert of a COMPLETED case still
 * holds both tokens here. A caller that needs liveness (the case surface's resolution
 * request needs an OPEN case) must check it itself — and it does, in the repository's own
 * `closed_at IS NULL` WHERE clause.
 *
 * ⚠ THE VISIBILITY AXIS IS A DIFFERENT, WIDER RULE, AND MUST NOT BE COLLAPSED INTO THIS ONE.
 * `actorHasExpertSideVisibility` grants to the delivering expert ∪ ANY live agency member
 * INCLUDING role `expert`; THIS resolver excludes role `expert`. ADR-1046 §7 records the
 * width as deliberate and permanent. An agency colleague reads the whole case surface and
 * cannot ask the client to resolve it. Do not "align" them.
 */

/**
 * ⚠⚠ NARROWED ON PURPOSE — THE FOUR ENGAGEMENT-GRAIN LABELS ONLY.
 *
 * `apps/api`'s `EngagementHostSubject` spans all seven `meeting_context_type` labels because
 * it implements all seven arms. This seam implements ONE: `contextId` IS an `engagements.id`.
 * The request-grain arms (`project_discovery`, `request_interaction`) and `admin` are
 * UNREPRESENTABLE BY TYPE here, so this module CANNOT silently answer a question it has not
 * implemented — a caller that tried would fail `tsc`, not get a wrong `false` at runtime.
 *
 * ⚠ CORRECTED TRIGGER. This used to read "BAL-410 / BAL-411 widen it when they need those
 * grains". NEITHER DID, and both have now shipped: BAL-411 landed without widening, and BAL-410
 * DECLINED explicitly (orchestrator D7). BAL-410's web cancel action is structurally
 * `contextType: 'case'` — it is mounted only from the case surface, its input is
 * `{ engagementId, meetingId }`, and `resolveBoundMeeting` REQUIRES a live `case` context whose
 * `contextId === engagementId` — so the narrow type is never a constraint for it. Its API
 * counterpart (`apps/api/src/services/meetings/authorize-engagement-host.ts`) implements ALL
 * SEVEN labels, including both request-grain arms, so a `request_interaction` cancel IS gated
 * correctly today; only the web AFFORDANCE is case-scoped, which matches where it lives.
 *
 * THE REAL TRIGGER, stated so the next reader does not re-derive a settled decision: **the
 * first `apps/web` surface that ACTS on a request-grain meeting.** Widening means porting the
 * two request-grain arms plus the `relationshipDeniesHosting` predicate — and CLAUDE.md is
 * explicit that predicate must have exactly ONE definition, so PORT it, never restate it.
 */
export type EngagementGrainHostSubject = {
  readonly contextType: 'case' | 'project_kickoff' | 'package_session' | 'retainer_checkin';
  readonly contextId: string;
};

/**
 * Does `actor` hold `capability` over this engagement-grain context?
 *
 * Fails closed at every branch — a missing/soft-deleted engagement, a missing expert profile,
 * and an actor who is simply not a holder all return `false`. Contains no `throw`: a caller
 * must never have to catch to stay safe. (A repository REJECTION — the database being
 * unreachable — still propagates, exactly as it does in `apps/api`'s resolver; swallowing
 * that would turn an outage into a silent uniform deny, which is a worse failure than a 500.)
 *
 * ⚠ NO BRANCH ON `capability`. The token is handed straight to the pure core, so both tokens
 * traverse the identical repository sequence. If the holder sets ever diverge they diverge in
 * `ENGAGEMENT_ROLE_CAPABILITIES`, never by a second resolver (ADR-1046).
 */
export async function hasEngagementCapability(
  actor: { id: string },
  capability: EngagementCapability,
  subject: EngagementGrainHostSubject
): Promise<boolean> {
  const engagement = await engagementsRepository.findById(subject.contextId);
  if (engagement === undefined) {
    // An integrity signal, not a control-flow value — the ordinary "not a holder" answer is
    // NOT logged (it is a normal answer to a normal question, and would be pure noise).
    // ⚠ IDS ONLY — never a join_url, a room name, a name or an email.
    log.warn('Engagement host context denied — no live engagement for this context_id', {
      contextType: subject.contextType,
      contextId: subject.contextId,
      actorId: actor.id,
    });
    return false;
  }

  return hasExpertDeliveryCapability(
    actor,
    capability,
    // `engagements.expert_profile_id` is NOT NULL on the supertype for ALL engagement types
    // (BAL-417), so the four labels share one path and there is nothing to defend here.
    engagement.expertProfileId,
    { contextType: subject.contextType, contextId: subject.contextId }
  );
}

/**
 * BAL-283 — the SAME rule, asked of an ALREADY-RESOLVED delivering `expert_profiles.id`.
 *
 * ⚠⚠ THIS IS NOT A SECOND RESOLVER, AND IT MUST NOT BECOME ONE. It is the exact tail
 * `hasEngagementCapability` used to inline, hoisted so a caller whose subject is NOT an
 * `engagements.id` can ask the identical question through the identical core
 * (`buildHostContextForExpertProfile` → `hostContextGrants`). `hasEngagementCapability` now
 * calls it, so there is one code path and one holder set for `apps/web`, exactly as ADR-1046
 * requires. If a holder set ever changes it changes in `ENGAGEMENT_ROLE_CAPABILITIES` — never
 * here, and never in a caller.
 *
 * ⚠ WHY IT EXISTS AT ALL. `shareAvailabilityAction` gates a PRE-ENGAGEMENT act on a
 * `request_expert_relationships` row: there is no engagement, so `EngagementGrainHostSubject`
 * (deliberately narrowed to the four engagement-grain labels) cannot represent it, and
 * widening that type belongs to the first web surface that ACTS on a request-grain meeting —
 * ⚠ NOT BAL-410 / BAL-411, both of which have shipped without widening (see the narrowing
 * note above). Before this, that action
 * compared `access.ctx.lens !== 'expert'` — a `lens ===` gate, which CLAUDE.md forbids
 * categorically: `lens` gates the VIEW, a capability gates the MUTATION.
 *
 * ⚠ IT ANSWERS "IS THIS ACTOR ON THE DELIVERY SIDE OF THIS EXPERT PROFILE", AND NOTHING ELSE.
 * It resolves NO tenancy, NO relationship lifecycle and NO liveness — the caller must have
 * already established that the actor may reach this row (`resolveConversationAccess`) and that
 * the relationship is not declined/withdrawn (`assertRelationshipBookable`, which consults the
 * ONE shared `relationshipDeniesHosting` predicate). A `true` authorizes the ACT, never the
 * READ.
 */
export async function hasExpertDeliveryCapability(
  actor: { id: string },
  capability: EngagementCapability,
  expertProfileId: string,
  logContext: { contextType: string; contextId: string }
): Promise<boolean> {
  const resolution = await buildHostContextForExpertProfile(expertProfileId, actor.id, {
    findExpertProfile: (id) => expertsRepository.findProfileById(id),
    // ⚠ `actorId` is the callback's PARAMETER, never captured — the confused-deputy
    // defence documented on `HostContextReads`. Do not collapse it to one argument.
    findAgencyRole: (agencyId, actorId) =>
      partyMembershipsRepository.getMemberRole('agency', agencyId, actorId),
  });

  if (!resolution.ok) {
    log.warn('Engagement host context denied — the delivering expert profile is missing', {
      contextType: logContext.contextType,
      contextId: logContext.contextId,
      actorId: actor.id,
      expertProfileId,
    });
    return false;
  }

  return hostContextGrants(resolution.hostContext, actor, capability);
}

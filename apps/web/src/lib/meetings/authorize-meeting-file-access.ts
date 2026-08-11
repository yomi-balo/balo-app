import 'server-only';

import {
  expertsRepository,
  meetingContextsRepository,
  meetingsRepository,
  partyMembershipsRepository,
  requestExpertRelationshipsRepository,
  resolveMeetingContextOwner,
  type Meeting,
} from '@balo/db';
import {
  actorHasExpertSideVisibility,
  CAPABILITIES,
  relationshipDeniesHosting,
  roleHasCapability,
} from '@balo/shared/authz';
import {
  selectPrimaryMeetingContext,
  type MeetingGuestSide,
  type PrimaryMeetingContext,
} from '@balo/shared/meetings';
import { log } from '@/lib/logging';

/**
 * BAL-423 — THE PARTICIPATION GATE FOR MEETING FILES. Resolve a `meetingId` to its PRIMARY
 * context, resolve that context to its OWNING PARTY, then decide which SIDE the acting user is
 * on — before any coherence or state check is touched.
 *
 * ⚠⚠ ONE GATE, THREE CALLERS. Upload (request + confirm) and download/list all run THIS
 * function. They differ only in the session helper they compose it with:
 * `requireOnboardedUser()` for the two writers, bare `requireUser()` + a `READ_ONLY_ALLOWLIST`
 * entry for the two readers. That is the shipped `conversation_files` shape exactly.
 *
 * ⚠⚠ THE ACTOR'S RESOLVED SIDE IS THE LOAD-BEARING ANTI-CROSS-PARTY CONTROL. `party` is NEVER
 * a request field on any meeting-file action; it is whatever this gate RETURNS. The confirm
 * action writes `party: access.side` and its Zod input schema has NO `party` key, so there is
 * no path at all from a request body to that column. That single decision is what makes it
 * structurally impossible for a client-side member to mint an expert-side file. If you ever
 * find yourself reading `party` off a request body, this gate has been bypassed.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * ⚠⚠ (a) WHY THE ENGAGEMENT-CAPABILITY AXIS IS **NOT** USED HERE — ACT vs READ.
 * ──────────────────────────────────────────────────────────────────────────────
 * The obvious-looking move is to gate the expert arm on the engagement axis, as
 * `apps/api`'s `authorizeMeetingParticipation` does. IT IS THE WRONG AXIS FOR FILES, and not
 * for packaging reasons (that seam being `apps/api`-only today is a consequence, not the
 * argument). That axis has exactly TWO tokens — one for live/in-meeting rights (Daily owner
 * token, admit/deny, end call) and one for administrative acts (reschedule propose/withdraw,
 * expert-side cancel, request case resolution) — and CLAUDE.md states plainly that a `true`
 * from that seam "authorizes the ACT, never the READ".
 *
 *   · DOWNLOADING A FILE IS A READ. Fetching a deck shared in a call is materially identical
 *     to reading the thread, and `authorize-conversation-context.ts` already settled that
 *     gating a read on an act token is a category error "wherever the module lived".
 *   · UPLOADING IS NOT ON THAT AXIS EITHER. Neither token covers "share a file". Sharing a
 *     deck is not a Daily owner token and it is not a reschedule. Gating it on the
 *     administrative token would repeat verbatim the error
 *     `authorize-meeting-participation.ts` names when it refuses the money token for invites:
 *     gating a non-money action on a money token is a category error.
 *   · THE HOLDER SET IS WRONG IN BOTH DIRECTIONS. It excludes agency role `expert` —
 *     precisely the colleague on the call holding the file — and it excludes EVERY
 *     client-side actor structurally (the resolver reads only the delivering expert's profile
 *     and their agency owners/admins), so it could never be the whole gate for a TWO-SIDED
 *     file surface anyway.
 *
 * ⚠ COROLLARY, STATED SO IT IS NOT UNDONE: THIS MODULE DOES NOT OPEN THE `apps/web`
 * ENGAGEMENT-AXIS SEAM. CLAUDE.md records that seam as landing "with its first consumer
 * (BAL-410/BAL-411)". It still does. `authorize-meeting-file-access.test.ts` asserts that
 * STATICALLY, by reading this file's own source.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * ⚠⚠ (b) THE EXPERT ARM CONSUMES THE SHIPPED **VISIBILITY** RULE — IT DOES NOT INVENT ONE,
 *        AND IT IS DELIBERATELY WIDER THAN THE ENGAGEMENT AXIS'S HOLDER SET.
 * ──────────────────────────────────────────────────────────────────────────────
 * The rule is `actorHasExpertSideVisibility` (`@balo/shared/authz`) — **consumed, not mirrored**
 * (BAL-419) — the same one `authorizeEngagementConversation` and
 * `authorizeSessionExpertVisibility` use: THE DELIVERING EXPERT ∪ ANY LIVE
 * MEMBER OF THAT EXPERT'S AGENCY (any agency role, INCLUDING `expert`). Membership EXISTING
 * grants — never a role comparison, never `roleHasCapability` — because the question is "is
 * this person inside the agency", not "does their role carry a token" (ADR-1029). An
 * independent expert (`agencyId === null`) short-circuits on `profile.userId === userId` with
 * NO agency lookup at all.
 *
 * ⚠ THE WIDTH IS THE POINT, NOT DRIFT. CLAUDE.md (ADR-1046 §7, resolved 2026-08-03) records
 * it as DELIBERATE AND PERMANENT: "visibility (delivering expert ∪ any live agency member)
 * and act rights (delivering expert ∪ agency owner/admin) are different rules by design. Do
 * not narrow it." Sharing and reading a file is visibility. THIS IS THE READ-vs-ACT
 * CORRECTION applied to `apps/api`'s otherwise identically-shaped gate — two gates, two axes,
 * same shape, exactly the split ADR-1046 §7 mandates. Do not "align" them.
 *
 * ⚠ BAL-419 SETTLED IT: **CONFIRMED, NOT NARROWED**, and the rule now has exactly ONE
 * definition — `actorHasExpertSideVisibility` — consumed by all three visibility gates. There
 * is no longer a local `agencyRole !== undefined` branch here; the single line lives in
 * `packages/shared/src/authz/expert-side-visibility.ts`, and ADR-1046 §7 forbids narrowing it.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * ⚠⚠ (c) THE EXPERT ARM IS GATED ON **DECLINE STATE**, ON THE TWO REQUEST-GRAIN ARMS ONLY.
 * ──────────────────────────────────────────────────────────────────────────────
 * (b)'s width says WHICH PEOPLE stand on the expert side. It does NOT say the side still
 * exists. On the two REQUEST-GRAIN context types — `project_discovery` and
 * `request_interaction` — an expert who DECLINED the request would otherwise keep both READ
 * and UPLOAD on that meeting's files FOREVER, and so would their entire agency, because
 * `project_requests.expert_profile_id` SURVIVES A DECLINE by CHECK (the column cannot be
 * nulled while `send_to='direct'`). `apps/api`'s `resolveHostContext` denies exactly those
 * people on exactly the same meeting; leaving this gate ungated would be a second, laxer
 * answer to the same question.
 *
 * ⚠ ONE PREDICATE, NEVER A SECOND DEFINITION OF "DECLINED". The check is
 * `relationshipDeniesHosting` from `@balo/shared/authz` — the SINGLE definition on this
 * platform, which reads BOTH representations (the enum label AND `declined_at`) so it fails
 * closed if they ever disagree. Do not re-derive it, do not compare `status === 'declined'`
 * here, and do not add a second timestamp check.
 *
 * ⚠ EVIDENCE, NOT ABSENCE — PRESERVED EXACTLY. The predicate answers a question about a row
 * that EXISTS. NO relationship row leaves the DISCOVERY arm UNGATED, because on a `direct`
 * request the exploratory call legitimately PRECEDES any formal invite; "no relationship yet"
 * is the normal early state and must never deny. Do not "tighten" this into deny-on-absence.
 *
 * ⚠ ENGAGEMENT-GRAIN CONTEXTS ARE UNAFFECTED, and that is not an omission. `case`,
 * `project_kickoff`, `package_session` and `retainer_checkin` name their expert on
 * `engagements.expert_profile_id`; there is no request relationship to decline. A completed
 * or cancelled engagement is a LIFECYCLE question, which this gate deliberately does not
 * discharge (see below).
 *
 * ⚠ IT INHERITS THE RESOLVER'S SOFT-DELETE LIMITATION VERBATIM. Every read of
 * `request_expert_relationships` that projects `status` / `declined_at` filters
 * `deleted_at IS NULL`, so a soft-deleted relationship is INDISTINGUISHABLE FROM ABSENT here
 * — i.e. ungated. That is a documented limitation, not coverage.
 *
 * ── THE ORDER OF THE CHECKS IS PART OF THE CONTRACT ────────────────────────────
 *
 * Copied from `authorize-meeting-booking.ts` → `authorize-meeting-participation.ts`:
 * resolve the meeting → resolve the primary context → resolve the owning party →
 * **AUTHORIZATION BEFORE ANY COHERENCE OR STATE CHECK** → collapse every denial into ONE
 * literal. Running a state check first would let an actor with membership NOWHERE distinguish
 * states of a guessed `meetingId` by response alone — an existence oracle over every
 * `meetings.id` on the platform, readable by any self-serve signup.
 *
 * ⚠ EVERY DENIAL COLLAPSES INTO ONE `meeting_not_found` LITERAL. There is no `forbidden`, no
 * `not_a_participant`, no `ambiguous`. WHICH SHAPE IT WAS GOES TO THE LOG (`log.warn`,
 * distinct `reason` per shape), NEVER TO THE WIRE.
 *
 * ⚠ CROSS-TENANCY IS DISCHARGED HERE, FOR A FOURTH CALLER. `meeting_contexts.context_id` has
 * NO FK and NO RLS, so the owning party is resolved from the context's OWN row BEFORE any
 * authorization — never inferred from caller-supplied input.
 *
 * ⚠ LIFECYCLE IS **NOT** DISCHARGED HERE, DELIBERATELY.
 * `authorize-meeting-participation.ts` sets the precedent: a gate reports, callers check
 * `meetings.status` if they need liveness. This PR adds NO status gate on upload — an
 * `ended`/`cancelled` meeting still accepts one. "Can I still upload after the call ended" is
 * a product rule owned by BAL-132/BAL-134, and D3 says explicitly that files OUTLIVE the
 * call. Documented, not omitted: the `meeting` row is threaded back so a caller that needs
 * liveness has it without a second read.
 *
 * ⚠ IT SHIPS WITH NO PRODUCTION CALLER OUTSIDE THIS TICKET'S FOUR ACTIONS (D4) — the same
 * BAL-408 / BAL-413 / BAL-424 precedent of landing a gate ahead of its surface.
 */

/** Which side of the meeting the actor was resolved onto. NEVER taken from request input. */
export type MeetingFileAccessSide = MeetingGuestSide;

export type AuthorizeMeetingFileAccessResult =
  | {
      ok: true;
      /** ⚠ THE `party` EVERY FILE THIS ACTOR SHARES WILL CARRY. Returned, never accepted. */
      side: MeetingFileAccessSide;
      /** Threaded back so a caller needing liveness never re-reads it (nor can disagree). */
      meeting: Meeting;
      /** The PRIMARY context that governs this meeting. */
      subject: PrimaryMeetingContext;
      /** The company that owns the primary context. Always resolved on both sides. */
      companyId: string;
      /** `null` for a `match`-routed `project_discovery`, which names nobody. */
      expertProfileId: string | null;
    }
  /** ⚠ ONE literal. There is deliberately no `forbidden`. */
  | { ok: false; code: 'meeting_not_found' };

export interface AuthorizeMeetingFileAccessInput {
  meetingId: string;
  userId: string;
}

/**
 * Which read came back empty, or which axis refused — a LOG field, NEVER a wire value.
 *
 * ⚠ EVERY MEMBER IS REACHABLE, AND THAT IS A RULE RATHER THAN A COINCIDENCE. A reserved
 * label no code path can emit is a dead union member: it reads as coverage that does not
 * exist, and nothing fails when the branch it was meant to describe never arrives. There is
 * deliberately NO `guest_unsupported` here — a guest reaches no arm and falls out as
 * `cross_tenant`, DELIBERATELY INDISTINGUISHABLE FROM A STRANGER (the fail-closed
 * direction), and the test suite pins that literal so BAL-132 gets a RED test the moment it
 * fills the guest arm. Add the label in the same change that can emit it.
 */
type DenialReason =
  | 'no_meeting'
  | 'no_context'
  | 'ambiguous_context'
  | 'subject_unresolvable'
  | 'no_capability'
  | 'declined_relationship'
  | 'cross_tenant';

/** The single fail-closed exit. The SHAPE goes to the log; the wire gets one literal. */
function deny(
  reason: DenialReason,
  fields: Record<string, unknown>
): { ok: false; code: 'meeting_not_found' } {
  log.warn('Meeting file access denied', { ...fields, reason });
  return { ok: false, code: 'meeting_not_found' };
}

/**
 * Is this actor on the EXPERT side of the meeting? The shipped VISIBILITY rule of (b),
 * extracted so `authorizeMeetingFileAccess` stays under the cognitive-complexity ceiling.
 *
 * THE DELIVERING EXPERT ∪ ANY LIVE MEMBER OF THAT EXPERT'S AGENCY (any agency role,
 * INCLUDING `expert`). Membership EXISTING grants — never a role comparison.
 *
 * ⚠ AN INDEPENDENT EXPERT (`agencyId === null`) RESOLVES WITH NO AGENCY LOOKUP AT ALL, and
 * so does the delivering expert of an agency profile: both return before `getMemberRole` is
 * reached. That is asserted by call-count, not by inspection.
 *
 * ⚠ IT ANSWERS "WHICH SIDE", NOT "MAY THEY". The decline gate of (c) runs at the CALL SITE,
 * after this returns true — so a declined expert is still recognised as expert-side and then
 * DENIED with its own log reason, rather than silently degrading into `cross_tenant` and
 * losing the shape in the log.
 */
async function actorIsOnExpertSide(expertProfileId: string, userId: string): Promise<boolean> {
  const profile = await expertsRepository.findProfileById(expertProfileId);
  if (profile === undefined) return false;

  // ⚠ THE SHARED VISIBILITY RULE, CONSUMED — never re-derived. `actorHasExpertSideVisibility`
  // is the single definition on the platform (BAL-419); the delivering expert and an
  // INDEPENDENT expert both return before the callback is ever invoked, preserving the
  // no-agency-lookup guarantee this docblock asserts by call-count.
  //
  // ⚠ The lookup takes `actorId` as a PARAMETER rather than capturing `userId`, so a callback
  // can never answer for an actor other than the one being authorized (the confused-deputy
  // shape `HostContext.resolvedForActorId` closes on the act axis). Do not "simplify" it.
  return actorHasExpertSideVisibility(profile, userId, (agencyId, actorId) =>
    partyMembershipsRepository.getMemberRole('agency', agencyId, actorId)
  );
}

/**
 * (c)'s DECLINE GATE — the two REQUEST-GRAIN arms only. `true` ⇒ deny.
 *
 * The two arms differ only in the LOOKUP GRAIN, exactly as `apps/api`'s arms 5 and 6 do:
 *
 *   · `request_interaction` — the `contextId` IS the relationship id (`findById`).
 *   · `project_discovery`   — the `contextId` is the REQUEST id, so the target expert's row
 *                             is found among that request's LIVE relationships by
 *                             `expertProfileId`. The partial unique index
 *                             `request_expert_relationship_unique_idx WHERE deleted_at IS
 *                             NULL` guarantees AT MOST ONE live row per (request, expert), so
 *                             this `find` is unambiguous rather than "first match wins", and
 *                             a COMPETING candidate's decline can never gate the target.
 *
 * Both arms then consult the ONE shipped predicate. See (c) for why absence must not deny.
 *
 * ⚠ `request_interaction`'s ABSENT ROW ALSO LEAVES THE ARM UNGATED, and it is unreachable in
 * practice rather than a second policy: `resolveMeetingContextOwner` already read that very
 * row to produce the owning party, so a gate that got this far has one. Routing absence
 * through the predicate as a `true` is what its docblock forbids, so it is not done here
 * either — the arms stay identical.
 */
async function requestGrainRelationshipDenies(
  subject: PrimaryMeetingContext,
  expertProfileId: string
): Promise<boolean> {
  if (subject.contextType === 'request_interaction') {
    const relationship = await requestExpertRelationshipsRepository.findById(subject.contextId);
    return relationship !== undefined && relationshipDeniesHosting(relationship);
  }

  if (subject.contextType === 'project_discovery') {
    const liveRelationships = await requestExpertRelationshipsRepository.listByRequest(
      subject.contextId
    );
    const target = liveRelationships.find(
      (candidate) => candidate.expertProfileId === expertProfileId
    );
    return target !== undefined && relationshipDeniesHosting(target);
  }

  // Engagement grain — no request relationship exists to decline. See (c).
  return false;
}

/**
 * Fail-closed participation authorization for a meeting's file surface.
 *
 * Returns the actor's SIDE plus the meeting, the primary context and the owning party, so the
 * caller threads all four onward and none is read twice.
 */
export async function authorizeMeetingFileAccess(
  input: AuthorizeMeetingFileAccessInput
): Promise<AuthorizeMeetingFileAccessResult> {
  const { meetingId, userId } = input;

  // 1. The meeting. `findById` filters `deleted_at IS NULL`, so missing and soft-deleted are
  //    ONE outcome — which is what lets them share one literal without extra work.
  const meeting = await meetingsRepository.findById(meetingId);
  if (meeting === undefined) {
    return deny('no_meeting', { userId, meetingId });
  }

  // 2. The PRIMARY context (BAL-408's precedence rule, pure). `listByMeeting` filters
  //    soft-deleted rows; `selectPrimaryMeetingContext` drops `admin` rows, so an admin-only
  //    meeting yields `none` — correct, because an admin call's files would resolve on the
  //    PLATFORM axis (ADR-1035), which is out of scope here.
  const contexts = await meetingContextsRepository.listByMeeting(meetingId);
  const primary = selectPrimaryMeetingContext(contexts);
  if (!primary.ok) {
    // Both `none` and `ambiguous` answer the SAME literal — a distinct code
    // pre-authorization is an existence oracle. Only the log distinguishes them.
    return deny(primary.reason === 'ambiguous' ? 'ambiguous_context' : 'no_context', {
      userId,
      meetingId,
      contextCount: contexts.length,
    });
  }
  const subject = primary.context;

  // 3. The owning party, from the primary context's OWN row. A judgement-free `@balo/db`
  //    read — it reports who owns the row and says nothing about who may see it.
  const owner = await resolveMeetingContextOwner(subject);
  if (owner === undefined) {
    return deny('subject_unresolvable', {
      userId,
      meetingId,
      contextType: subject.contextType,
      contextId: subject.contextId,
    });
  }
  const { companyId, expertProfileId } = owner;

  // ── 4. AUTHORIZATION. NOTHING BELOW THIS POINT RUNS BEFORE A SIDE IS PROVEN. ──

  // CLIENT ARM — membership axis, COMPANY scope, `PARTICIPATE`. Role interpretation goes
  // through `@balo/shared/authz` (ADR-1029 HARD CONSTRAINT B); never `role === 'owner'`.
  const companyRole = await partyMembershipsRepository.getMemberRole('company', companyId, userId);
  if (companyRole !== undefined) {
    if (!roleHasCapability(companyRole, CAPABILITIES.PARTICIPATE)) {
      // A live member whose role lacks the base bundle. Distinct in the log, identical on
      // the wire.
      return deny('no_capability', { userId, meetingId, companyId, side: 'client' });
    }
    return { ok: true, side: 'client', meeting, subject, companyId, expertProfileId };
  }

  // EXPERT ARM — the shipped VISIBILITY rule (see (b) above). Reached ONLY when the actor
  // holds no company membership, so the two arms cannot both fire and the side is
  // unambiguous.
  //
  // A `match`-routed `project_discovery` names nobody, so there is no profile to load and the
  // arm short-circuits (`&&`) rather than querying a null id.
  if (expertProfileId !== null && (await actorIsOnExpertSide(expertProfileId, userId))) {
    // ⚠ (c) — THE DECLINE GATE, on the two REQUEST-GRAIN arms only. It runs AFTER the side
    // is proven, so the log keeps the shape ("this expert declined") instead of collapsing
    // it into `cross_tenant`. It gates the WHOLE arm: the declined expert AND their agency.
    if (await requestGrainRelationshipDenies(subject, expertProfileId)) {
      return deny('declined_relationship', {
        userId,
        meetingId,
        companyId,
        expertProfileId,
        contextType: subject.contextType,
      });
    }
    return { ok: true, side: 'expert', meeting, subject, companyId, expertProfileId };
  }

  /**
   * ⚠ THE GUEST ARM IS A NAMED, FAIL-CLOSED HOLE — ASSIGNED TO BAL-132 (D2).
   *
   * There is NO guest-authenticated read session on `main`: `/join/[token]` resolves an
   * identity CLAIM only, and `guestMayReadMeeting` (`@balo/shared/meetings`) has ZERO
   * production callers by design — its own docblock says BAL-408 "RECORDS THE GRANT; IT DOES
   * NOT ENFORCE THE READ". This gate therefore takes an authenticated `userId` and nothing
   * else. A guest reaches no arm and is denied with the same single literal as a stranger.
   *
   * DO NOT call `guestMayReadMeeting` speculatively and DO NOT invent a guest session here:
   * BAL-132 mints the session, and BAL-132 fills this branch. Calling the predicate now would
   * mean authorizing a read against a grant with no authenticated subject to bind it to —
   * which is worse than denying.
   *
   * ⚠ THE ACCEPTANCE CRITERION "Guest access respects BAL-408's `access_scope`" IS NOT MET BY
   * THIS PR. It is restated as a contract BAL-132 / BAL-388 satisfy. This is a decision (D2),
   * not an oversight, and the test suite closes the hole by name.
   */

  // THE CROSS-TENANT ATTEMPT — the thing worth seeing in Axiom. The log distinguishes it from
  // a genuinely missing meeting; the wire deliberately does not.
  return deny('cross_tenant', { userId, meetingId, companyId, contextType: subject.contextType });
}

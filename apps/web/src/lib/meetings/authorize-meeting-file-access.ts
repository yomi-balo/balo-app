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
  guestIsAdmittedForRead,
  guestMayReadMeeting,
  selectPrimaryMeetingContext,
  type GuestAccessScopeLabel,
  type MeetingGuestSide,
  type PrimaryMeetingContext,
} from '@balo/shared/meetings';
import { conversationSubjectForMeetingContext } from '@balo/shared/conversations';
import { log } from '@/lib/logging';
import type { MeetingGuestSubject } from './resolve-meeting-guest';

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
 * ⚠ COROLLARY, STATED SO IT IS NOT UNDONE: THIS MODULE DOES NOT USE THE `apps/web`
 * ENGAGEMENT-AXIS SEAM. That seam is now OPEN — BAL-421 opened it
 * (`apps/web/src/lib/authz/engagement.ts`), not BAL-410/BAL-411 as originally deferred
 * (ADR-1046 amendment 2026-08-12) — so the packaging accident that used to make this
 * impossible is GONE. The argument above is unaffected, because it never rested on packaging:
 * downloading is a READ and uploading is on neither token. `authorize-meeting-file-access.test.ts`
 * asserts the non-import STATICALLY by reading this file's own source, and that assertion is
 * now load-bearing rather than incidental.
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
 * ⚠⚠ **THE GUEST ARM — BAL-445.** As of BAL-445, `authorizeMeetingFileAccess` has EIGHT
 * production callers (not four): `list-meeting-files.ts`, `get-meeting-file-download.ts`,
 * `request-meeting-file-upload.ts`, `confirm-meeting-file-upload.ts`,
 * `send-meeting-reaction.ts`, `get-case-file-download.ts`, `meeting-chat-anchor.ts`, and
 * `resolve-recap-access.ts`. The AC "Guest access respects BAL-408's `access_scope`" is now
 * MET for meeting files and in-call chat — see the guest arm below. The recap remains
 * BAL-439's; `resolve-recap-access.ts` gates guests out explicitly, on purpose (R4).
 */

/** Which side of the meeting the actor was resolved onto. NEVER taken from request input. */
export type MeetingFileAccessSide = MeetingGuestSide;

/**
 * WHO IS ASKING. ⚠ AN EXPLICIT DISCRIMINATED UNION RATHER THAN AN OPTIONAL `guest` BESIDE
 * `userId`: an optional field admits "both" and "neither", and this is the gate where an
 * implicit state is most expensive. Same reasoning as `presencePartyForGuest`'s input object.
 */
export type MeetingFileAccessActor =
  | { readonly kind: 'member'; readonly userId: string }
  | { readonly kind: 'guest'; readonly guest: MeetingGuestSubject };

export interface AuthorizeMeetingFileAccessInput {
  readonly meetingId: string;
  readonly actor: MeetingFileAccessActor;
}

export type AuthorizeMeetingFileAccessResult =
  | {
      ok: true;
      viewer: 'member';
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
  | {
      ok: true;
      viewer: 'guest';
      /** `meeting_guests.id` — the only stable handle a guest has. NEVER a `users.id`. */
      guestId: string;
      /** The grant AS RECORDED, threaded so callers never re-read it. */
      accessScope: GuestAccessScopeLabel;
      /** The TARGET meeting — whatever `meetingId` resolved to. NOT the guest's own meeting. */
      meeting: Meeting;
      /**
       * ⚠⚠ F2 (fix-round-1) — THE GUEST'S OWN meeting (`meeting_guests.meeting_id`'s row),
       * threaded as a DISTINCT field from `meeting` above. A caller computing the guest's
       * conversation-read scope (`meeting-chat-anchor.ts`) must derive it from THIS field, never
       * from `meeting` — `meeting` is the target and is equal to the guest's own meeting only by
       * coincidence (the id-equality shortcut, or envelope-equality for an `engagement`-scoped
       * guest). Reading `meeting` there binds the scope rule to caller-supplied input with no
       * independent tie to the recorded grant.
       */
      guestMeeting: Meeting;
      subject: PrimaryMeetingContext;
    }
  /** ⚠ ONE literal. There is deliberately still no `forbidden`. */
  | { ok: false; code: 'meeting_not_found' };

/**
 * Which read came back empty, or which axis refused — a LOG field, NEVER a wire value.
 *
 * ⚠ EVERY MEMBER IS REACHABLE, AND THAT IS A RULE RATHER THAN A COINCIDENCE. A reserved
 * label no code path can emit is a dead union member: it reads as coverage that does not
 * exist, and nothing fails when the branch it was meant to describe never arrives.
 *
 * `guest_out_of_scope` joins this union in the SAME change that emits it (BAL-445, §2.2
 * below): a token-bearing guest whose recorded `access_scope` does not cover the target
 * meeting. A signed-in stranger with no membership anywhere is still `cross_tenant` —
 * deliberately indistinguishable from a stranger, the fail-closed direction — but a guest
 * now resolves on its own arm, with its own log shape.
 */
type DenialReason =
  | 'no_meeting'
  | 'no_context'
  | 'ambiguous_context'
  | 'subject_unresolvable'
  | 'no_capability'
  | 'declined_relationship'
  | 'guest_not_admitted'
  | 'guest_out_of_scope'
  | 'guest_owner_unresolvable'
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

/** `{ userId }` for a member, `{ guestId }` for a guest — a LOG field, never a wire value. */
function actorLogFields(actor: MeetingFileAccessActor): Record<string, unknown> {
  return actor.kind === 'member' ? { userId: actor.userId } : { guestId: actor.guest.guest.id };
}

/**
 * Does the TARGET meeting sit inside the guest's own ENGAGEMENT ENVELOPE?
 *
 * ⚠⚠ THE IDENTITY OF AN ENVELOPE IS `conversationSubjectForMeetingContext`'s ANSWER, BORROWED
 * FROM THE CONVERSATION SEAM SO THE TWO GRAINS CANNOT DISAGREE ABOUT WHAT "THE SAME
 * ENGAGEMENT" MEANS. `resolveGuestConversationScope` already decides the conversation-grain
 * question with that mapping; deriving a second notion here — "both are engagement-grain and
 * the ids match" — would be a second definition that drifts the first time a seventh context
 * label lands. The mapping is total over `MeetingContextTypeWithHolder` with a `never`
 * default, so that seventh label fails to compile there rather than defaulting here.
 *
 * ⚠ FAIL-CLOSED THREE WAYS: a guest meeting whose primary context is `none`/`ambiguous`
 * returns false; a `project_discovery` on EITHER side maps to `null` (it names a request that
 * fans out to many threads, so it names no envelope) and returns false.
 */
async function targetSharesGuestEnvelope(
  guestMeetingId: string,
  targetSubject: PrimaryMeetingContext
): Promise<boolean> {
  const guestContexts = await meetingContextsRepository.listByMeeting(guestMeetingId);
  const guestPrimary = selectPrimaryMeetingContext(guestContexts);
  if (!guestPrimary.ok) return false;
  const guestEnvelope = conversationSubjectForMeetingContext(guestPrimary.context);
  const targetEnvelope = conversationSubjectForMeetingContext(targetSubject);
  if (guestEnvelope === null || targetEnvelope === null) return false;
  return (
    guestEnvelope.contextType === targetEnvelope.contextType &&
    guestEnvelope.contextId === targetEnvelope.contextId
  );
}

/**
 * ── THE GUEST ARM (BAL-445) — extracted so `authorizeMeetingFileAccess` stays under the
 * cognitive-complexity ceiling, exactly the same move already made for `actorIsOnExpertSide`
 * and `requestGrainRelationshipDenies` above. Called BEFORE owner resolution. A guest needs no
 * owning party, so `resolveMeetingContextOwner` is not called for them — one fewer read, and
 * "authorization before any coherence or state check" is preserved.
 *
 * ⚠⚠ THE GUEST ARM CARRIES NO `side`, AND THAT IS THE LOAD-BEARING DECISION. Three reasons:
 *   1. It would be a third derivation from a placeholder — on a `link`-channel row
 *      `meeting_guests.party` is NOT a resolved side (`presencePartyForGuest` and
 *      `projectGuestForViewer` both already refuse to derive from it).
 *   2. Nothing needs it — `meeting_files` reads are not party-filtered (BAL-423), and guest
 *      upload is closed, so there is no `party` column for a guest to write.
 *   3. It is the compiler brake R4 requires: `access.side` on a union whose guest arm lacks
 *      the property is a hard `tsc` error at every consumer of `side` — the exact set of
 *      call sites that must state, in code, what they do about a guest.
 */
async function authorizeGuestFileAccess(
  meeting: Meeting,
  meetingId: string,
  subject: PrimaryMeetingContext,
  guestSubject: MeetingGuestSubject
): Promise<AuthorizeMeetingFileAccessResult> {
  const { guest, meeting: guestMeeting, admission } = guestSubject;

  // ⚠⚠ F1 (fix-round-1) — THE ADMISSION GATE, CHECKED FIRST AND BEFORE ANY OTHER GUEST CHECK.
  // `resolveMeetingGuestSubject` deliberately still resolves a `pending` row — the `/join`
  // landing and `pollGuestAdmissionAction` both legitimately need to render the waiting card
  // for a not-yet-admitted guest — but a READ is a stricter question than "does a live row
  // exist". `guestIsAdmittedForRead` (@balo/shared/meetings) is the shared pure form of
  // `apps/api`'s `ADMITTED_STATES`: waiting is not holding, and being refused is not holding.
  // Without this, ANY visitor who claims a lobby place off a forwarded `/join/m/{meetingId}`
  // URL — never admitted by a host — could read every file and the whole in-call transcript.
  if (!guestIsAdmittedForRead(admission)) {
    return deny('guest_not_admitted', { guestId: guest.id, meetingId, admission });
  }

  // ⚠⚠ F3 (fix-round-1) — THE REQUEST-GRAIN DECLINE GATE ALSO GATES A GUEST. Without this, a
  // guest invited to a `request_interaction` / `project_discovery` meeting whose expert has
  // since DECLINED the request kept reading files after the declining expert and their whole
  // agency were denied below — precisely the defect BAL-423 shipped a fix for, reintroduced
  // one actor removed. Reuses `requestGrainRelationshipDenies` — the SAME predicate the
  // member-expert arm runs, which itself reuses `relationshipDeniesHosting` — so there is
  // exactly ONE definition of "declined" on this gate, never a second. Costs one extra read
  // (`resolveMeetingContextOwner`) only on the two request-grain context types; every other
  // primary context (case, project_kickoff, package_session, retainer_checkin) still resolves
  // no owner for a guest, unchanged.
  if (
    subject.contextType === 'request_interaction' ||
    subject.contextType === 'project_discovery'
  ) {
    const owner = await resolveMeetingContextOwner(subject);

    // ⚠⚠ S2 (fix-round-2) — `owner === undefined` now DENIES the guest, matching the member
    // arm's `subject_unresolvable` below, rather than falling through to `guestMayReadMeeting`
    // as fix-round-1 left it. `resolveContextOwner`'s finders filter `deleted_at IS NULL`, so
    // an owning row that is REMOVED (not merely declined) — e.g. the shipped "remove invited
    // expert" action soft-deletes `request_expert_relationships` — also resolves `undefined`.
    // Fix-round-1's fall-through meant that from that moment the delivering expert, their
    // agency and every client member were denied below, while a guest holding a live token
    // kept reading unchanged: the mirror image of the bypass F3 closed. Scoped to request
    // grain only, matching F3 — an engagement-grain guest still resolves no owner at all and
    // must not gain a lifecycle check this gate does not otherwise discharge for it.
    if (owner === undefined) {
      return deny('guest_owner_unresolvable', {
        guestId: guest.id,
        meetingId,
        contextType: subject.contextType,
      });
    }

    // `owner.expertProfileId` is `null` for a `match`-routed `project_discovery`, which names
    // no expert — nothing to decline, so EVIDENCE, NOT ABSENCE applies here too: ungated.
    if (
      owner.expertProfileId !== null &&
      (await requestGrainRelationshipDenies(subject, owner.expertProfileId))
    ) {
      return deny('declined_relationship', {
        guestId: guest.id,
        meetingId,
        contextType: subject.contextType,
      });
    }
  }

  // ⚠ THE SHIPPED PREDICATE, CALLED — NOT REIMPLEMENTED. `guestMayReadMeeting`
  // (@balo/shared/meetings) encodes the `meeting` vs `engagement` scope rule and is pure and
  // tested. This ticket supplies the SUBJECT; it does not re-derive the RULE. There is no
  // `accessScope === 'engagement'` comparison anywhere in this file, and there must never be
  // one.
  const targetSharesGuestEngagement =
    guestMeeting.id === meetingId
      ? // ⚠ NOT A SHORTCUT INTO THE PREDICATE'S FIRST BRANCH. A meeting trivially shares its
        // own envelope; computing it would be a second read for an answer we already hold.
        true
      : await targetSharesGuestEnvelope(guestMeeting.id, subject);

  if (
    !guestMayReadMeeting({
      guestAccessScope: guest.accessScope,
      guestMeetingId: guestMeeting.id,
      targetMeetingId: meetingId,
      targetSharesGuestEngagement,
    })
  ) {
    return deny('guest_out_of_scope', {
      guestId: guest.id,
      meetingId,
      accessScope: guest.accessScope,
      contextType: subject.contextType,
    });
  }

  return {
    ok: true,
    viewer: 'guest',
    guestId: guest.id,
    accessScope: guest.accessScope,
    meeting,
    guestMeeting,
    subject,
  };
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
  const { meetingId, actor } = input;

  // 1. The meeting. `findById` filters `deleted_at IS NULL`, so missing and soft-deleted are
  //    ONE outcome — which is what lets them share one literal without extra work.
  const meeting = await meetingsRepository.findById(meetingId);
  if (meeting === undefined) {
    return deny('no_meeting', { ...actorLogFields(actor), meetingId });
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
      ...actorLogFields(actor),
      meetingId,
      contextCount: contexts.length,
    });
  }
  const subject = primary.context;

  // ── THE GUEST ARM (BAL-445) — dispatched here, BEFORE owner resolution. A guest needs no
  // owning party, so `resolveMeetingContextOwner` is not called for them — one fewer read, and
  // "authorization before any coherence or state check" is preserved. See
  // `authorizeGuestFileAccess` (above) for the full arm and its `⚠⚠ NO side` rationale.
  if (actor.kind === 'guest') {
    return authorizeGuestFileAccess(meeting, meetingId, subject, actor.guest);
  }

  const { userId } = actor;

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
    return {
      ok: true,
      viewer: 'member',
      side: 'client',
      meeting,
      subject,
      companyId,
      expertProfileId,
    };
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
    return {
      ok: true,
      viewer: 'member',
      side: 'expert',
      meeting,
      subject,
      companyId,
      expertProfileId,
    };
  }

  // THE CROSS-TENANT ATTEMPT — the thing worth seeing in Axiom. The log distinguishes it from
  // a genuinely missing meeting; the wire deliberately does not. A signed-in stranger with no
  // membership anywhere, and now also a token-bearing guest whose OWN meeting resolved to no
  // subject at all (unreachable in practice — the guest arm above already returned), land here
  // identically.
  return deny('cross_tenant', { userId, meetingId, companyId, contextType: subject.contextType });
}

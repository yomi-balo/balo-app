/**
 * BAL-413 / ADR-1046 — the ENGAGEMENT-capability axis's async resolver for `apps/api`.
 *
 * The third authorization axis. Membership `hasCapability` gates by party membership
 * and is `apps/web`-only (`import 'server-only'`); `hasPlatformCapability` gates
 * Balo-staff mutations by `platformRole` (ADR-1035); THIS seam gates by **delivery
 * identity** on one already-resolved meeting context.
 *
 * Two tokens — `host_meetings` (live/in-meeting: Daily owner token, admit/deny, end
 * call) and `manage_engagement` (administrative: reschedule propose/withdraw,
 * expert-side cancel, request case resolution) — over ONE holder set and, crucially,
 * ONE resolver. `hasEngagementCapability` never branches on the token: it resolves the
 * host context, then hands both the context and the token to the pure core. A
 * per-token resolver is the thing ADR-1046 forbids, and `authorize-engagement-host.test.ts`
 * pins it by asserting both tokens produce identical repository call sequences.
 *
 * Structure mirrors `services/credit-session/authorize-session-*.ts` (service-local
 * async guard) — deliberately, per the ticket's scope fence. The `apps/web` seam is
 * DEFERRED to its first consumer (BAL-410 / BAL-411); because every non-I/O decision
 * lives in `@balo/shared/authz`'s pure core, that seam will be a thin fetch-and-call
 * wrapper rather than a re-derivation of the holder rule.
 *
 * ⚠ THIS SHIPS INERT. There is no production caller yet: BAL-132 mints the Daily owner
 * token, BAL-421 renders the case surface. Unit-tested regardless — the SonarCloud
 * new-code coverage gate applies to changed lines, and an authorization predicate that
 * arrives untested arrives untrustworthy.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠ NOTHING IN THIS FILE AUTHORIZES THE READ.
 * It answers exactly one question: "does THIS actor hold THIS engagement capability over
 * THIS already-identified context?" `hasEngagementCapability` returns a BOOLEAN and never
 * a row — but the exported `resolveHostContext` returns delivery IDENTITY
 * (`expertUserId`, `agencyId`) for ANY valid uuid, and it INHERITS exactly the same
 * tenancy obligation. Unguarded, it is an identity oracle: hand it a cross-tenant
 * `context_id` and it truthfully names another tenant's expert.
 * Neither entry point establishes that the caller was entitled to know this context
 * exists, to see the meeting it belongs to, or to hold its join credentials.
 * `meeting_contexts.context_id` has NO FK and NO RLS (see the TENANCY OBLIGATION block in
 * `packages/db/src/schema/meeting-contexts.ts`): a cross-tenant uuid SUCCEEDS SILENTLY.
 * Resolving the context's owning party and checking membership `hasCapability` against it
 * is the CALLER'S obligation, per that block's CARRIED BY list (BAL-129, BAL-409/410/411,
 * BAL-421, BAL-425/BAL-420) — BAL-413 is deliberately not on it.
 * A `true` here is NEVER sufficient authorization on its own.
 *
 * ⚠ THE OBLIGATION LIST IS NOT EXHAUSTED BY TENANCY. ENGAGEMENT LIFECYCLE IS ALSO YOURS.
 * `engagementsRepository.findById` filters `deleted_at` ONLY; `engagements.status` is
 * never consulted anywhere in this file. So the delivering expert of a COMPLETED or
 * CANCELLED engagement still holds BOTH tokens here. That is deliberate — this axis
 * answers "who delivers this?", and post-delivery surfaces (a transcript, a review
 * request, a late reschedule) legitimately still need a host identity — but it means a
 * `true` does NOT mean "this engagement is still live". A caller that requires liveness
 * (BAL-132 minting a Daily owner token, BAL-410/411 mutating a schedule) must check
 * `engagements.status` itself.
 *
 * ⚠ THIS IS A CALL-TIME ANSWER, NOT AN EVENT. It reads state and returns a boolean; it
 * writes nothing, sweeps nothing and cascades to nothing. So the relationship-status gate
 * on arm 5 does NOT void meetings already booked before a decline — a call booked while
 * the expert was a holder stays booked, and only the NEXT question about it answers
 * `false`. Revoking or cancelling already-booked calls on decline is booking-lane scope
 * (BAL-129 / BAL-410), deliberately not this resolver's.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠ OPEN QUESTION, DELIBERATELY NOT DECIDED HERE (BAL-413 flag F1). The entry point takes
 * ONE already-resolved context, not a `meetingId`. A meeting may carry MULTIPLE context
 * rows — `meeting_context_unique_idx` is unique on the triple
 * `(meeting_id, context_type, context_id)`, and the schema's own example is a discovery
 * call that gains a SECOND row for the engagement at kickoff. A `meetingId`-shaped
 * resolver would have to invent a combining rule (any-of / all-of / precedence) that
 * ADR-1046 §3 never states, and `any-of` in particular would let a LOSING discovery
 * candidate keep host rights over the kickoff meeting. So: a caller holding a `meetingId`
 * lists that meeting's contexts (`meetingContextsRepository.listByMeeting`), applies its
 * own tenancy check, and calls this per context with its OWN combining rule. That rule is
 * BAL-132's / BAL-421's decision and must be recorded as an ADR-1046 amendment when the
 * first one lands.
 */
import {
  engagementsRepository,
  expertsRepository,
  partyMembershipsRepository,
  projectRequestsRepository,
  requestExpertRelationshipsRepository,
  type MeetingContextType,
} from '@balo/db';
import {
  hostContextGrants,
  relationshipDeniesHosting,
  type EngagementCapability,
  type ResolvedHostContext,
} from '@balo/shared/authz';
import { createLogger } from '@balo/shared/logging';

const log = createLogger('engagement-authz');

/**
 * The subject of an engagement-capability question: ONE already-resolved meeting context.
 * The union mirrors the DB's biconditional CHECK `meeting_context_admin_no_id`
 * (`context_id IS NULL ⟺ context_type = 'admin'`) in the type system, so an `admin`
 * subject cannot carry an id and a non-admin subject cannot omit one.
 */
export type EngagementHostSubject =
  | { readonly contextType: Exclude<MeetingContextType, 'admin'>; readonly contextId: string }
  | { readonly contextType: 'admin'; readonly contextId: null };

/**
 * Which by-id read came back empty — a log field, not a control-flow value.
 * `invalid_context_id` is the one member that names a read never attempted: the id could
 * not be a `uuid` at all, so no repository was called. See `isUuid`.
 */
type MissingRow =
  | 'engagement'
  | 'project_request'
  | 'request_expert_relationship'
  | 'expert_profile'
  | 'invalid_context_id';

/**
 * Canonical `uuid` shape — the ONLY thing Postgres will accept into a `uuid` column
 * without raising `22P02 invalid input syntax for type uuid`.
 *
 * ⚠ WHY A GUARD AND NOT A CAST. `EngagementHostSubject.contextId` is a bare `string`
 * (it comes from `meeting_contexts.context_id`, a polymorphic column with no FK), so a
 * caller can hand this seam `''` or `'abc'`. Reaching `eq(table.id, contextId)` with one
 * of those makes postgres-js infer `$1::uuid` and REJECT the query — an exception, from a
 * function whose whole contract is that a caller never has to catch to stay safe, on an
 * ATTACKER-SHAPED input class. Validating here turns that into an ordinary fail-closed
 * deny with an integrity signal.
 *
 * DELIBERATELY LOOSER THAN `z.uuid()`, which enforces the RFC 9562 version/variant
 * nibbles: this must accept everything Postgres accepts, or a legitimate non-v4 id would
 * be denied. Non-canonical spellings Postgres also tolerates (brace-wrapped, unhyphenated)
 * are rejected — nothing in this codebase mints them, and rejecting them merely denies.
 *
 * ⚠ ReDoS-SAFE BY CONSTRUCTION (SonarCloud S5852): fully anchored, fixed repetition
 * counts, no nested quantifiers and no overlapping alternation — one linear pass.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/**
 * The single integrity-signal + fail-closed exit.
 *
 * A `context_id` that is malformed, or that resolves to no LIVE row, means either a
 * soft-deleted subject or a bad / cross-tenant / attacker-supplied id — worth a `warn` —
 * and it always denies. An ordinary `false` (the actor simply is not a holder) is NOT
 * logged: that is a normal answer to a normal question, and once BAL-132 wires this into a
 * per-join check it would be high-volume noise.
 *
 * IDS ONLY — never a `join_url`, never a `daily_room_name`, never an email or a name.
 *
 * The `capability` is deliberately absent from these fields even though it is available
 * one frame up: including it would imply the resolution depends on the token, and its
 * independence from the token is exactly the invariant this file is built to hold.
 */
function denyMissingRow(
  subject: EngagementHostSubject,
  actorId: string,
  missing: MissingRow,
  expertProfileId?: string
): null {
  log.warn(
    {
      contextType: subject.contextType,
      contextId: subject.contextId,
      actorId,
      missing,
      expertProfileId,
    },
    'Engagement host context denied — the context_id is unusable, or the subject row is missing or soft-deleted'
  );
  return null;
}

/**
 * Expert profile → host context. The ONLY place the holder set is assembled, and the
 * tail of all six expert-bearing arms. Both tokens funnel through here.
 *
 * Three facts this turns on:
 *   · `expert_profiles` has NO `deleted_at`, so there is no soft-delete predicate to add
 *     — `findProfileById`'s lack of one is correct, not an oversight.
 *   · `expert_profiles.userId` is NOT NULL; `agencyId` is NULLABLE. The null `agencyId`
 *     is the independent expert, and it SHORT-CIRCUITS: no `getMemberRole` call is made,
 *     because there is no agency for anyone to be an admin of (ADR-1046 §2).
 *   · `getMemberRole` already filters `deletedAt IS NULL`, so a removed agency admin
 *     resolves to `undefined` → `actorRole: null` → denied, with no extra predicate here.
 *
 * ⚠ Do NOT also short-circuit the agency lookup when `profile.userId === actorId`. It
 * would be cheaper, but it would return `agency: null` for an AGENCY-based expert — a
 * `HostContext` that lies about the world, and a trap for the first caller that reads the
 * context rather than the boolean. The null-`agencyId` short-circuit is the ADR's, and it
 * is the only one.
 */
async function hostContextForExpertProfile(
  expertProfileId: string,
  actorId: string,
  subject: EngagementHostSubject
): Promise<ResolvedHostContext> {
  const profile = await expertsRepository.findProfileById(expertProfileId);
  if (profile === undefined) {
    return denyMissingRow(subject, actorId, 'expert_profile', expertProfileId);
  }

  const { agencyId } = profile;
  if (agencyId === null) {
    // `resolvedForActorId` is stamped on BOTH return paths — see `HostContext`'s docblock.
    // It binds this context to the actor it was resolved for, so a caller cannot resolve
    // once as a privileged actor and then check many.
    return { resolvedForActorId: actorId, expertUserId: profile.userId, agency: null };
  }

  const actorRole = await partyMembershipsRepository.getMemberRole('agency', agencyId, actorId);
  return {
    resolvedForActorId: actorId,
    expertUserId: profile.userId,
    agency: { agencyId, actorRole: actorRole ?? null },
  };
}

/**
 * ARM 5 — `project_discovery`: the EXPLORATORY call, split by route, then GATED ON
 * RELATIONSHIP STATUS. Extracted from the switch so `resolveHostContext` stays under the
 * cognitive-complexity ceiling; it is one arm's body and has no other caller.
 *
 * `send_to='direct'` ⇒ the request names a target expert. `send_to='match'` ⇒ NO HOLDER,
 * and we stop before any expert lookup.
 *
 * Guarded on `!== 'direct'` rather than `=== 'match'` so a future third routing value also
 * fails closed. A match request has no target expert BY CONSTRUCTION (CHECK
 * `project_requests_direct_requires_expert` makes `expert_profile_id` a biconditional on
 * `send_to`), and the exploratory call is `requireAdmin()`-gated triage that happens
 * UPSTREAM of `experts_invited` — normally before any expert is on the request at all.
 * Candidate-set resolution was considered and REJECTED (ADR-1046 amendment 2026-08-07):
 * the set is empty at call time and would grant meeting powers to non-winners. The admin
 * running triage is authorized on the PLATFORM axis, exactly as an `admin` context is.
 *
 * ⚠ GATED ON RELATIONSHIP STATUS (BAL-413 / ADR-1046 §3, amended 2026-08-08). A bare read
 * of `project_requests.expert_profile_id` is NOT enough. That column SURVIVES A DECLINE
 * FOREVER — the CHECK forbids nulling it while `send_to='direct'` — so an expert who
 * declined the request would otherwise keep LIVE HOST RIGHTS over its discovery meetings
 * indefinitely. ADR-1046's "a declined relationship is never a holder for new grants" is
 * ARM-UNSCOPED, so it binds here exactly as it binds arm 6.
 *
 * ONE PREDICATE, TWO ARMS: `relationshipDeniesHosting` is the single definition of
 * "declined" on this axis (see its docblock in `@balo/shared/authz`). It is why the two
 * arms coincide on direct routes BY CONSTRUCTION rather than by agreement.
 *
 * ⚠ DENY ON EVIDENCE, NEVER ON ABSENCE. No relationship row for the target expert leaves
 * this arm UNGATED and the target still resolves as holder. That is deliberate, not an
 * oversight: on a `direct` request the exploratory call legitimately PRECEDES any formal
 * invite, so "no relationship yet" is the normal early state and must not deny. Only
 * positive evidence on an EXISTING row denies. Do not "tighten" this into a deny-on-absence
 * — the test `an ABSENT relationship row still resolves TRUE` pins it.
 *
 * ⚠ KNOWN LIMITATION — THE SOFT-DELETE SUB-CASE IS NOT OBSERVABLE HERE, AND THIS SAYS SO
 * RATHER THAN PRETENDING OTHERWISE. §3's evidence list names soft-deleted rows, but EVERY
 * existing read of `request_expert_relationships` that projects `status` / `declinedAt`
 * filters `deleted_at IS NULL` (`findById`, `listByRequest`,
 * `projectRequestsRepository.findByIdWithRelations`'s `relationships` child,
 * `projectsInboxRepository`). The one read that DOES reach soft-deleted rows —
 * `conversationsRepository`'s summary join — is keyed by relationship ID (which this arm
 * does not have; it has the request + the expert) and projects NONE of the columns needed.
 * So a soft-deleted relationship is INDISTINGUISHABLE FROM ABSENT here, and absent means
 * ungated. Closing that would need a NEW repository method, which BAL-413's scope forbids
 * adding on speculation.
 * The residual is narrow: soft-delete means "removed from the request's invite list", and
 * on a `direct` request the target is named by the REQUEST, not by the relationship —
 * removing the invite row does not un-name them as the direct target, and the partial
 * unique index on `deleted_at IS NULL` exists precisely so a removed expert can be
 * RE-INVITED. A removed-then-not-re-invited direct target is therefore closer to "no
 * invite yet" (ungated, by the rule above) than to "declined". A DECLINE — the case that
 * actually motivated this gate — is a status transition on a LIVE row and IS caught. The
 * test `a SOFT-DELETED relationship is INVISIBLE to this arm` pins the ACTUAL behaviour so
 * this limitation cannot be silently mistaken for coverage.
 */
async function hostContextForDiscoveryRequest(
  requestId: string,
  actorId: string,
  subject: EngagementHostSubject
): Promise<ResolvedHostContext> {
  const request = await projectRequestsRepository.findById(requestId);
  if (request === undefined) {
    return denyMissingRow(subject, actorId, 'project_request');
  }
  if (request.sendTo !== 'direct') return null;

  // Belt-and-braces: unreachable while the CHECK holds. It is what keeps this arm correct
  // — rather than crashing or widening — if the CHECK is ever relaxed.
  const { expertProfileId } = request;
  if (expertProfileId === null) return null;

  // The lookup grain differs from arm 6's on purpose: this arm holds the REQUEST id and
  // the TARGET expert, never a relationship id. `listByRequest` is an EXISTING read (no
  // new repository surface), and the partial unique index
  // `request_expert_relationship_unique_idx WHERE deleted_at IS NULL` guarantees AT MOST
  // ONE live row per (request, expert) — so this `find` is unambiguous, not a "first match
  // wins" heuristic. Siblings on the same request are excluded by `expertProfileId`: a
  // competing candidate's decline must never gate the target.
  const liveRelationships = await requestExpertRelationshipsRepository.listByRequest(requestId);
  const targetRelationship = liveRelationships.find(
    (candidate) => candidate.expertProfileId === expertProfileId
  );
  if (targetRelationship !== undefined && relationshipDeniesHosting(targetRelationship)) {
    return null;
  }

  return hostContextForExpertProfile(expertProfileId, actorId, subject);
}

/**
 * Assembles the host context for one meeting context, or `null` when the context has NO
 * HOLDER. Exported because BAL-132 needs the host IDENTITY (whose Daily owner token),
 * not just a boolean — making it re-derive the holder rule is the exact drift ADR-1029
 * forbids.
 *
 * ONE exhaustive `switch`, typed against `MeetingContextType` (derived from the pgEnum),
 * so an EIGHTH label cannot land without failing `pnpm --filter api typecheck` here. Its
 * runtime pair is `packages/db/src/invariants/meeting-context-type-labels.test.ts`.
 *
 * Fails closed at every branch: a MALFORMED `context_id`, a missing row, a `match`-routed
 * request, a declined relationship (on EITHER request-grain arm — 5 and 6 share one
 * predicate) and an `admin` context all yield `null`, and `null` denies every actor. This
 * function contains no `throw`: a caller must never have to catch to stay safe. (A repository REJECTION — the database being unreachable — still
 * propagates, exactly as it does in `authorize-session-expert.ts`; swallowing that would
 * turn an outage into a silent, uniform deny, which is a worse failure than a 500.)
 *
 * ⚠ THIS INHERITS THE TENANCY OBLIGATION IN THE HEADER BLOCK, AND IT IS SHARPER HERE.
 * `hasEngagementCapability` returns a boolean; THIS function returns delivery IDENTITY
 * (`expertUserId`, `agencyId`) for ANY valid uuid, with no tenancy check anywhere in it —
 * so an unauthorized caller passing a cross-tenant `context_id` gets a truthful answer
 * about another tenant's expert. That makes it an IDENTITY ORACLE unless the caller has
 * ALREADY established that the actor was entitled to see this context. Resolve the
 * context's owning party and check membership `hasCapability` BEFORE calling this.
 *
 * ⚠ IT ALSO SAYS NOTHING ABOUT ENGAGEMENT LIFECYCLE — see the header block's obligation
 * list. The returned identity is "who delivers this", not "this is still live".
 */
export async function resolveHostContext(
  subject: EngagementHostSubject,
  actorId: string
): Promise<ResolvedHostContext> {
  // Validated ONCE, at the seam entry, so `hasEngagementCapability` inherits it and no arm
  // can hand a non-uuid to a repository. `admin` carries `contextId: null` by construction
  // (the biconditional CHECK, mirrored in `EngagementHostSubject`) and is exempt.
  if (subject.contextId !== null && !isUuid(subject.contextId)) {
    return denyMissingRow(subject, actorId, 'invalid_context_id');
  }

  switch (subject.contextType) {
    // ── Arms 1–4: engagement grain. `engagements.expert_profile_id` is NOT NULL on the
    // supertype for ALL engagement types (BAL-417), so the four labels share one branch —
    // there is no per-type difference to express, and writing them out separately would
    // be four copies of the same three lines.
    //
    // ⚠ `findById` filters `deleted_at` ONLY — `engagements.status` is deliberately not
    // read here. See the ENGAGEMENT LIFECYCLE obligation in the header block.
    case 'case':
    case 'project_kickoff':
    case 'package_session':
    case 'retainer_checkin': {
      const engagement = await engagementsRepository.findById(subject.contextId);
      if (engagement === undefined) {
        return denyMissingRow(subject, actorId, 'engagement');
      }
      return hostContextForExpertProfile(engagement.expertProfileId, actorId, subject);
    }

    // ── Arm 5: request grain — the EXPLORATORY call, split by route. Extracted whole
    // into `hostContextForDiscoveryRequest` (see its docblock): it is the only arm with
    // two sequential reads and a gate, and inlining it pushed this switch past the
    // SonarCloud cognitive-complexity ceiling.
    case 'project_discovery':
      return hostContextForDiscoveryRequest(subject.contextId, actorId, subject);

    // ── Arm 6: relationship grain — CLIENT↔CANDIDATE calls (BAL-413's new label).
    //
    // Sibling exclusion is STRUCTURAL, not filtered: each candidate has their own
    // `request_expert_relationships` row and therefore their own `contextId`, so a
    // sibling's row is a different subject this call never touches. There is exactly one
    // holder per meeting however many candidates exist, and nothing needs excluding
    // because nothing else is ever read.
    //
    // ⚠ "STRUCTURAL" IS NARROWER THAN IT SOUNDS, AND ONLY ACROSS AGENCIES. Two candidates
    // on the same request who share ONE agency share its owner/admin bundle, so that
    // agency's admin resolves TRUE over their own candidate's competitor's meeting. This
    // is ADR-1046-consistent (the holder set is the delivering expert PLUS their agency
    // owners/admins, and the agency is genuinely the same party) — but it is not the
    // "one candidate can never reach another's call" the word structural suggests.
    //
    // A DECLINED relationship is never a holder for new grants (BAL-276 precedent), via
    // the SHARED `relationshipDeniesHosting` predicate — the single definition of
    // "declined" on this axis, which arm 5 also consults. Both representations (the enum
    // label and the timestamp) are checked inside it, so the resolver fails closed if the
    // two ever disagree. `findById` already guards `deleted_at IS NULL`, so a removed
    // candidate needs no predicate here — unlike arm 5, where the same soft-delete is
    // invisible for a different reason (see that arm's LIMITATION block).
    //
    // ⚠ GRAIN OVERLAP ON DIRECT ROUTES IS NOW TRUE BY CONSTRUCTION, NOT BY COINCIDENCE.
    // On a `send_to='direct'` request, arm 5 and this arm name the same expert and reach
    // the same verdict because they consult ONE predicate over the SAME row — arm 5 finds
    // it by `(projectRequestId, expertProfileId)`, this arm by its id. Before the
    // 2026-08-08 amendment arm 5 read the request column bare, so the two arms genuinely
    // could disagree: declined here, still a holder there. Do not reintroduce a
    // second decline test in either arm.
    case 'request_interaction': {
      const relationship = await requestExpertRelationshipsRepository.findById(subject.contextId);
      if (relationship === undefined) {
        return denyMissingRow(subject, actorId, 'request_expert_relationship');
      }
      if (relationshipDeniesHosting(relationship)) return null;
      return hostContextForExpertProfile(relationship.expertProfileId, actorId, subject);
    }

    // ── Arm 7: NOT THIS AXIS. An admin meeting has no engagement and no delivering
    // expert, so there is nothing to resolve — zero I/O, no holder. Balo staff are
    // authorized for these on the PLATFORM axis via `hasPlatformCapability`.
    case 'admin':
      return null;

    default: {
      // Compile-time exhaustiveness: an eighth `meeting_context_type` label stops
      // typechecking HERE until an arm is consciously written above.
      //
      // The house idiom (`_shared/engagement-supertype.ts`, `stripe/dispatch.ts`) throws
      // in this arm. This seam deliberately does not: it is an authorization predicate
      // whose contract is that a caller never has to catch to stay safe, and a label that
      // exists in the database but not in this switch must DENY, not 500. The `warn` is
      // how it stops being silent.
      const exhaustive: never = subject;
      log.warn(
        { actorId, subject: exhaustive },
        'Unhandled meeting_context_type in resolveHostContext — failing closed'
      );
      return null;
    }
  }
}

/**
 * The axis seam. Argument order deliberately mirrors membership
 * `hasCapability(actor, capability, scope)` and platform
 * `hasPlatformCapability(actor, capability)`.
 *
 * ⚠ Note what is NOT here: no branch on `capability`. The token is passed straight
 * through to the pure core, so both tokens traverse the identical repository sequence.
 * If the holder sets ever diverge they diverge in `ENGAGEMENT_ROLE_CAPABILITIES`, never
 * by a second resolver (ADR-1046).
 *
 * ⚠ A `true` here is not sufficient authorization — see the "NOTHING IN THIS FILE
 * AUTHORIZES THE READ" block at the top of this file, and the ENGAGEMENT LIFECYCLE
 * obligation beside it.
 */
export async function hasEngagementCapability(
  actor: { id: string },
  capability: EngagementCapability,
  subject: EngagementHostSubject
): Promise<boolean> {
  const hostContext = await resolveHostContext(subject, actor.id);
  return hostContextGrants(hostContext, actor, capability);
}

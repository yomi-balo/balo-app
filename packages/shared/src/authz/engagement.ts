/**
 * Engagement-capability axis (BAL-413 / ADR-1046) — the PURE CORE.
 *
 * The THIRD authorization axis, distinct from the two already here:
 *   - MEMBERSHIP (`./index.ts`)  — gates by party membership role in a company/agency.
 *   - PLATFORM   (`./platform.ts`) — gates Balo-staff mutations by `platformRole` (ADR-1035).
 *   - ENGAGEMENT (this file)     — gates by DELIVERY IDENTITY on ONE already-resolved
 *                                  meeting context (ADR-1046 §1).
 *
 * Two tokens, ONE shared holder set, ONE shared resolver per app:
 *   `host_meetings`     — live / in-meeting (Daily owner token, admit/deny, end call)
 *   `manage_engagement` — administrative (reschedule propose/withdraw, expert-side
 *                         cancel, request case resolution)
 *
 * ⚠ NO `EngagementCapability` token is a member of the membership `Capability` union.
 * That disjointness is enforced by the COMPILER, not by a lint rule — see the
 * type-level invariant in `apps/api/src/authz/engagement-capability-disjoint.ts`.
 * Consequence: `hasCapability(actor, 'host_meetings', { companyId })` does not compile.
 *
 * PURE and dependency-free — NO `@balo/db`, NO `postgres`, NO logging, NO `server-only`,
 * NO I/O of any kind. It must be importable from `apps/api` (where the Daily owner token
 * is minted and where membership `hasCapability` is unreachable, being `apps/web`-only),
 * from `apps/web`, and from a client bundle, without pulling a server dependency in.
 * Everything that does NOT require I/O lives here on purpose: the per-app async resolver
 * is then a thin fetch-and-call wrapper, so the deferred `apps/web` seam
 * (BAL-410 / BAL-411) stays a mechanical diff rather than a re-derivation of the rule.
 *
 * ⚠ THIS FILE DECIDES NOTHING ABOUT *WHICH* EXPERT DELIVERS. It consumes an
 * ALREADY-RESOLVED `HostContext`; assembling one from a meeting context is the async
 * resolver's job (`apps/api/src/services/meetings/authorize-engagement-host.ts`).
 *
 * ⚠ CIRCULAR IMPORT, DELIBERATE (BAL-413 flag F8). This module imports `CAPABILITIES` /
 * `roleHasCapability` from `./index`, and `./index` re-exports this module. The cycle is
 * value-safe: nothing here calls `roleHasCapability` at module-init time (only inside
 * `resolveHostRole`'s body), and `ENGAGEMENT_ROLE_CAPABILITIES` references only
 * module-local constants. The alternative — re-deriving "which agency role is an admin"
 * outside `./index.ts` — would break HARD CONSTRAINT B (a membership role string is
 * interpreted in exactly ONE place), which is a worse defect than a benign cycle.
 */
import { CAPABILITIES, roleHasCapability } from './index';

/**
 * The two tokens. NOT members of the membership `Capability` union (ADR-1046 §1).
 */
export const ENGAGEMENT_CAPABILITIES = {
  /** Live, in-meeting: Daily owner token, admit/deny, end call. */
  HOST_MEETINGS: 'host_meetings',
  /**
   * Administrative: propose/withdraw reschedule (BAL-411), expert-side cancel
   * (BAL-410), request case resolution (BAL-417). ⚠ NOT closing a case — that is
   * client-only on the MEMBERSHIP axis (`PARTICIPATE`); the expert may only request.
   */
  MANAGE_ENGAGEMENT: 'manage_engagement',
} as const;

export type EngagementCapability =
  (typeof ENGAGEMENT_CAPABILITIES)[keyof typeof ENGAGEMENT_CAPABILITIES];

/**
 * How an actor relates to the engagement — this axis's analogue of a "role".
 * ⚠ These are NOT membership roles and are never read from a `*_members.role`
 * column. They are derived, per call, from an already-resolved `HostContext`.
 */
export const HOST_ROLES = {
  /** `expert_profiles.userId === actor.id` — the expert DELIVERING this engagement. */
  DELIVERING_EXPERT: 'delivering_expert',
  /**
   * An `owner`/`admin` of the delivering expert's agency, where "admin" is
   * `rolesWithCapability(MANAGE_MEMBERS)` (ADR-1034) — resolved through
   * `roleHasCapability`, NEVER by `role === 'owner'`. NEVER agency role `expert`.
   */
  AGENCY_ADMIN: 'agency_admin',
} as const;

export type HostRole = (typeof HOST_ROLES)[keyof typeof HOST_ROLES];

/**
 * An ALREADY-RESOLVED host context (ADR-1046 §1). Assembled by the per-app async
 * resolver; consumed purely here.
 *
 * ⚠ A HostContext IS AN ANSWER ABOUT ONE ACTOR, NOT A FACT ABOUT THE MEETING. It is
 * BRANDED with `resolvedForActorId` for that reason — see that field's docblock.
 */
export type HostContext = {
  /**
   * CONFUSED-DEPUTY GUARD (BAL-413 security fix) — the `users.id` this context was
   * resolved FOR.
   *
   * WHY THIS FIELD EXISTS. `agency.actorRole` is the role of ONE SPECIFIC ACTOR in the
   * delivering expert's agency; it is meaningless for anybody else. But `resolveHostRole`
   * and `hostContextGrants` take `actor` as a SEPARATE parameter, so without this brand
   * the natural RESOLVE-ONCE / CHECK-MANY pattern silently escalates:
   *
   *   const ctx = await resolveHostContext(subject, agencyOwnerId);   // actorRole: 'owner'
   *   hostContextGrants(ctx, { id: attackerId }, 'host_meetings');    // would inherit 'owner'
   *
   * That shape is not contrived — "resolve the meeting's host context, then check each
   * participant" is exactly how the `host_meetings` admit/deny surface (BAL-132) wants to
   * use this, and `resolveHostContext` is EXPORTED to encourage reading the identity. The
   * brand makes the misuse fail closed instead of granting: a context resolved for A is a
   * DENIAL for every actor that is not A, on every path.
   *
   * A caller that legitimately needs to check several actors must RE-RESOLVE per actor —
   * which is correct, because the agency-role lookup is per actor anyway.
   */
  readonly resolvedForActorId: string;
  /** `users.id` of the delivering expert (`expert_profiles.userId`, NOT NULL). */
  readonly expertUserId: string;
  /**
   * `null` ⇒ INDEPENDENT expert: no agency exists, NO agency lookup was performed,
   * and none is needed (ADR-1046 §2 short-circuit). Modelling this as `null` rather
   * than `{ agencyId: null, … }` is what makes the "no agency lookup" guarantee
   * observable in a test.
   */
  readonly agency: {
    readonly agencyId: string;
    /** The ACTOR's LIVE membership role in THAT agency, or `null` for a non-member. */
    readonly actorRole: string | null;
  } | null;
};

/**
 * `null` ⇒ NO HOLDER: every actor resolves false on this axis. Never a guess, never
 * a set. Returned for a `match`-routed discovery context, an `admin` context, a
 * declined relationship, and every fail-closed "row not found" branch.
 */
export type ResolvedHostContext = HostContext | null;

/**
 * The two `request_expert_relationships` columns this axis reads. STRUCTURAL on
 * purpose — typing it against `@balo/db`'s `RequestExpertRelationship` would drag a
 * DB dependency into a module whose whole contract is that it has none. Any row with
 * these two fields satisfies it, and the real Drizzle row does.
 */
export type RelationshipHostingStatus = {
  readonly status: string;
  readonly declinedAt: Date | null;
};

/**
 * ⚠ THE SINGLE DEFINITION OF "this relationship denies hosting" (BAL-413 / ADR-1046 §3,
 * amended 2026-08-08). There must never be a second definition of "declined" on this axis.
 *
 * BOTH call sites live in `apps/api/src/services/meetings/authorize-engagement-host.ts`:
 *   · arm 5 `project_discovery` — the `send_to='direct'` target expert's relationship on
 *     that request, looked up by `(projectRequestId, expertProfileId)`;
 *   · arm 6 `request_interaction` — the subject relationship itself, looked up by id.
 * That shared consumption is what makes the two arms' claim to "coincide on direct
 * routes" true BY CONSTRUCTION rather than by two rules that happen to agree today.
 *
 * WHY BOTH REPRESENTATIONS. `advanceRelationshipStatus` writes the enum label and the
 * timestamp together, so they agree in practice. Checking both means the predicate fails
 * CLOSED if they ever disagree — a partial write, a manual backfill, a future status added
 * to the enum without a `declinedAt` stamp. Never trust the label alone.
 *
 * ⚠ "WITHDRAWN" IS NOT A SEPARATE STATE HERE. `request_expert_relationship_status` is
 * (`invited`, `eoi_submitted`, `proposal_requested`, `proposal_submitted`, `accepted`,
 * `declined`) — there is no `withdrawn` member on THIS table (proposals and
 * party_join_requests have one; they are different tables). The withdrawal of an expert
 * from a request is a SOFT DELETE, which this predicate cannot observe — see the
 * SOFT-DELETE LIMITATION block on arm 5 in the resolver.
 *
 * ⚠ EVIDENCE, NOT ABSENCE. This predicate answers a question about a row that EXISTS.
 * "There is no relationship row" is not this function's business and must never be routed
 * through it as a `true`: a caller with no row leaves its arm UNGATED (on a `direct`
 * request the exploratory call can legitimately precede any formal invite).
 */
export function relationshipDeniesHosting(relationship: RelationshipHostingStatus): boolean {
  return relationship.status === 'declined' || relationship.declinedAt !== null;
}

/**
 * Both tokens over the same holder set — the ADR-1046 2026-07-31 amendment, pinned
 * as data rather than prose.
 */
const HOST_BUNDLE: readonly EngagementCapability[] = [
  ENGAGEMENT_CAPABILITIES.HOST_MEETINGS,
  ENGAGEMENT_CAPABILITIES.MANAGE_ENGAGEMENT,
];

/**
 * Which host roles hold which token. BOTH tokens map to the SAME holder set today
 * (ADR-1046 amendment 2026-07-31).
 *
 * ⚠ IF THE HOLDER SETS EVER DIVERGE, THEY DIVERGE **HERE**, IN THIS MAP — never by
 * introducing a second resolver. One resolver per app is an ADR-1046 invariant, and
 * `engagement.test.ts` pins the current identity so a divergence must be conscious.
 */
export const ENGAGEMENT_ROLE_CAPABILITIES: Record<HostRole, readonly EngagementCapability[]> = {
  [HOST_ROLES.DELIVERING_EXPERT]: HOST_BUNDLE,
  [HOST_ROLES.AGENCY_ADMIN]: HOST_BUNDLE,
};

/**
 * True when `hostRole`'s bundle grants `capability`. An unrecognised role grants
 * nothing (fail closed) — mirrors `roleHasCapability` / `platformRoleHasCapability`.
 */
export function hostRoleHasCapability(
  hostRole: HostRole,
  capability: EngagementCapability
): boolean {
  return (ENGAGEMENT_ROLE_CAPABILITIES[hostRole] ?? []).includes(capability);
}

/**
 * PURE. Derives the actor's host role from an already-resolved context, or `null`
 * when the actor is not a holder.
 *
 * The agency-admin decision is DELEGATED to `roleHasCapability(role, MANAGE_MEMBERS)`
 * — the one sanctioned role→capability interpretation point (HARD CONSTRAINT B).
 * This function NEVER compares `role === 'owner'` / `role === 'admin'`.
 *
 * Why each deny branch matters:
 *   · a context resolved for a DIFFERENT actor is not an answer about this one — see
 *     `HostContext.resolvedForActorId`. This check is FIRST, before the delivering-expert
 *     comparison, so no later branch can bypass it: it defeats the resolve-once /
 *     check-many pattern, in which one privileged actor's context is reused to wave
 *     through every other participant;
 *   · a null context has no holder at all (match-routed discovery, admin meetings,
 *     declined relationships, missing rows);
 *   · a null `agency` means an independent expert — nobody but that expert qualifies,
 *     and NO agency lookup was ever performed;
 *   · a null `actorRole` is the single branch that excludes EVERY client-side actor,
 *     delegate and guest: their role was looked up in the DELIVERING expert's agency,
 *     where they have no live row. A company `owner` does hold `MANAGE_MEMBERS`, but
 *     never in that agency, so it is never consulted;
 *   · agency role `expert` maps to the base member bundle, which does not contain
 *     `MANAGE_MEMBERS` — so a delivering expert's agency colleague resolves false.
 *     ⚠ That colleague DOES hold expert-side **visibility** — see
 *     `actorHasExpertSideVisibility` in `./expert-side-visibility`. Two rules,
 *     deliberately (ADR-1046 §7): visibility is delivering expert ∪ ANY live agency
 *     member; act is delivering expert ∪ agency `owner`/`admin`. NOT drift, and not to
 *     be "aligned" — `expert-side-visibility.test.ts` pins both over ONE table.
 */
export function resolveHostRole(
  hostContext: ResolvedHostContext,
  actor: { id: string }
): HostRole | null {
  if (hostContext === null) return null;

  // FIRST, deliberately: a context is an answer about the actor it was resolved for and
  // about nobody else. Placing this above the delivering-expert comparison is what makes
  // it unbypassable — every grant path below is downstream of it.
  if (hostContext.resolvedForActorId !== actor.id) return null;

  if (hostContext.expertUserId === actor.id) return HOST_ROLES.DELIVERING_EXPERT;

  const { agency } = hostContext;
  if (agency === null) return null;

  const { actorRole } = agency;
  if (actorRole === null) return null;

  return roleHasCapability(actorRole, CAPABILITIES.MANAGE_MEMBERS) ? HOST_ROLES.AGENCY_ADMIN : null;
}

/**
 * PURE. The composition every per-app resolver ends in: derive the host role, then
 * ask the token map. A non-holder is `false` for BOTH tokens.
 */
export function hostContextGrants(
  hostContext: ResolvedHostContext,
  actor: { id: string },
  capability: EngagementCapability
): boolean {
  const hostRole = resolveHostRole(hostContext, actor);
  if (hostRole === null) return false;
  return hostRoleHasCapability(hostRole, capability);
}

// ─────────────────────────────────────────────────────────────────────────────
// THE HOST-CONTEXT ASSEMBLY — shared by BOTH per-app resolvers (BAL-421, ADR-1046
// amendment). Everything above this line is synchronous; everything below needs I/O, so
// the reads are INJECTED and this module still imports nothing.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The two `expert_profiles` columns the holder rule reads. STRUCTURAL — `@balo/db`'s row
 * satisfies it, and nothing here imports `@balo/db`. Deliberately the SAME shape
 * `ExpertSideVisibilityProfile` (`./expert-side-visibility`) declares, because both rules
 * turn on exactly these two facts; they are separate declarations because the two axes
 * are separate rules that must be free to diverge (ADR-1046 §7).
 */
export interface HostExpertProfile {
  /** `expert_profiles.userId` — the DELIVERING expert. NOT NULL in the database. */
  readonly userId: string;
  /** `expert_profiles.agencyId`. `null` ⇒ INDEPENDENT expert — no agency lookup is made. */
  readonly agencyId: string | null;
}

/**
 * The two reads the assembly needs, injected so this module stays dependency-free.
 *
 * ⚠ `findAgencyRole` TAKES `actorId` AS A PARAMETER rather than capturing it — the same
 * confused-deputy defence `AgencyRoleLookup` documents at length in
 * `./expert-side-visibility`. A one-argument lookup would let one built for a privileged
 * actor silently answer for another. Do not "simplify" it.
 */
export interface HostContextReads {
  readonly findExpertProfile: (expertProfileId: string) => Promise<HostExpertProfile | undefined>;
  readonly findAgencyRole: (agencyId: string, actorId: string) => Promise<string | undefined>;
}

/**
 * The assembly's outcome. A DISCRIMINATED UNION rather than a bare
 * `ResolvedHostContext`, so a caller can tell "no such expert profile" (an INTEGRITY
 * signal each app logs in its own voice, with its own fields) apart from an ordinary
 * non-holder. Collapsing them into one `null` here would have silently deleted
 * `apps/api`'s `denyMissingRow(… 'expert_profile' …)` warn, which is exactly the kind of
 * behaviour change an "obviously safe" extraction is prone to.
 */
export type HostContextResolution =
  | { readonly ok: true; readonly hostContext: HostContext }
  | { readonly ok: false; readonly reason: 'expert_profile_missing' };

/**
 * ⚠⚠ THE ONLY PLACE THE HOLDER SET IS ASSEMBLED, ON EITHER APP (BAL-421 / ADR-1046
 * amendment 2026-08-12). `apps/api`'s `authorize-engagement-host.ts` and `apps/web`'s
 * `lib/authz/engagement.ts` BOTH delegate here. A second assembly would be a second
 * definition of an authorization rule — the thing ADR-1029 forbids — and it is precisely
 * what this extraction exists to prevent as the `apps/web` seam opens.
 *
 * Three facts this turns on, carried verbatim from the `apps/api` original:
 *   · `expert_profiles` has NO `deleted_at`, so there is no soft-delete predicate to add.
 *   · `expert_profiles.userId` is NOT NULL; `agencyId` is NULLABLE. A null `agencyId` is
 *     the INDEPENDENT expert, and it SHORT-CIRCUITS: `findAgencyRole` is NEVER CALLED,
 *     because there is no agency for anyone to be an admin of (ADR-1046 §2). Modelling it
 *     as `agency: null` is what makes that guarantee observable by call-count in a test.
 *   · a live-membership read that comes back `undefined` (a removed agency admin) becomes
 *     `actorRole: null` → denied, with no extra predicate here.
 *
 * ⚠ Do NOT also short-circuit the agency lookup when `profile.userId === actorId`. It
 * would be cheaper, but it would return `agency: null` for an AGENCY-based expert — a
 * `HostContext` that LIES ABOUT THE WORLD, and a trap for any caller that reads the
 * context rather than the boolean (BAL-132 does exactly that). The null-`agencyId`
 * short-circuit is the ADR's, and it is the only one.
 *
 * ⚠ `resolvedForActorId` IS STAMPED ON BOTH RETURN PATHS — see `HostContext`'s docblock.
 * It binds the context to the actor it was resolved for, so a caller cannot resolve once
 * as a privileged actor and then check many.
 */
export async function buildHostContextForExpertProfile(
  expertProfileId: string,
  actorId: string,
  reads: HostContextReads
): Promise<HostContextResolution> {
  const profile = await reads.findExpertProfile(expertProfileId);
  if (profile === undefined) {
    return { ok: false, reason: 'expert_profile_missing' };
  }

  const { agencyId } = profile;
  if (agencyId === null) {
    return {
      ok: true,
      hostContext: { resolvedForActorId: actorId, expertUserId: profile.userId, agency: null },
    };
  }

  const actorRole = await reads.findAgencyRole(agencyId, actorId);
  return {
    ok: true,
    hostContext: {
      resolvedForActorId: actorId,
      expertUserId: profile.userId,
      agency: { agencyId, actorRole: actorRole ?? null },
    },
  };
}

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
 */
export type HostContext = {
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
 */
export function resolveHostRole(
  hostContext: ResolvedHostContext,
  actor: { id: string }
): HostRole | null {
  if (hostContext === null) return null;

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

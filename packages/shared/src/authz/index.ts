/**
 * Authorization capability map (BAL-345 / ADR-1029) — the SINGLE place in the
 * codebase where a membership `role` string is interpreted into capabilities.
 *
 * PURE and dependency-free: NO `@balo/db`, NO `postgres`, NO logging, NO I/O. It
 * lives behind the `@balo/shared/authz` subpath (mirroring `@balo/shared/domains`)
 * precisely so EVERY layer can reach it without a circular or bundle dependency:
 *   - `apps/web` client components (e.g. `billing-capture.ts`) — bundle-safe
 *   - `apps/web` server seam (`lib/authz`) — wraps this with a live role lookup
 *   - `@balo/db` repositories (e.g. `listAdminUserIds`) — derives the admin-role
 *     set from `rolesWithCapability` instead of hardcoding `role IN ('owner',...)`
 *   - `apps/api` notification resolver
 *
 * Keeping this the ONLY role→capability interpretation point means a role string
 * is never re-read anywhere else (HARD CONSTRAINT B — no drift).
 */

export const CAPABILITIES = {
  /** Take part in the party's work (baseline member capability). */
  PARTICIPATE: 'participate',
  /**
   * ⚠ Base-member capability — NOT the join-request approve gate. Every
   * domain-auto-joined member holds this. Do NOT wire the approve/decline
   * endpoints to this; use `MANAGE_MEMBERS`.
   */
  MANAGE_REQUESTS: 'manage_requests',
  /** Approve one's own proposals (member baseline). */
  APPROVE_OWN_PROPOSALS: 'approve_own_proposals',
  /**
   * The join-request approve/decline + membership-management gate — owner/admin
   * ONLY. This is the capability the BAL-345 approve/decline actions check.
   */
  MANAGE_MEMBERS: 'manage_members',
  /**
   * The billing-management gate — owner/admin ONLY today, but DISTINCT from
   * `MANAGE_MEMBERS` on purpose: ADR-1029's future `finance` role manages billing
   * WITHOUT managing members. Kept separate so the map stays the single point that
   * decides who can manage billing (no coupling to member management).
   */
  MANAGE_BILLING: 'manage_billing',
} as const;

export type Capability = (typeof CAPABILITIES)[keyof typeof CAPABILITIES];

// The base-member bundle: held by company `member` and agency `expert` roles, and
// (by inclusion) by owner/admin.
const MEMBER_BUNDLE: readonly Capability[] = [
  CAPABILITIES.PARTICIPATE,
  CAPABILITIES.MANAGE_REQUESTS,
  CAPABILITIES.APPROVE_OWN_PROPOSALS,
];

// The admin bundle = everything a member has PLUS member management + billing
// management. (`MANAGE_BILLING` is a distinct token so a future `finance` role can
// hold it without `MANAGE_MEMBERS`.)
const ADMIN_BUNDLE: readonly Capability[] = [
  ...MEMBER_BUNDLE,
  CAPABILITIES.MANAGE_MEMBERS,
  CAPABILITIES.MANAGE_BILLING,
];

/**
 * Static, membership-axis-only role→capability map. Company roles are
 * `owner|admin|member`; agency roles are `owner|admin|expert`. `member` (company
 * base) and `expert` (agency base) both map to the base member bundle. Any role
 * not present here (e.g. a platform role, or an unknown value) grants nothing.
 *
 * ⚠ FOOTGUN: `member`/`expert` hold `MANAGE_REQUESTS` but NOT `MANAGE_MEMBERS` —
 * the two capability names are one token apart. The approve/decline gate is
 * `MANAGE_MEMBERS`; wiring it to `MANAGE_REQUESTS` would be privilege escalation.
 */
export const ROLE_CAPABILITIES: Record<string, readonly Capability[]> = {
  owner: ADMIN_BUNDLE,
  admin: ADMIN_BUNDLE,
  member: MEMBER_BUNDLE, // company base
  expert: MEMBER_BUNDLE, // agency base
};

/** True when `role`'s bundle grants `capability`. Unknown role ⇒ false. */
export function roleHasCapability(role: string, capability: Capability): boolean {
  return (ROLE_CAPABILITIES[role] ?? []).includes(capability);
}

// The DISTINCT platform-capability axis (BAL-358) — gates Balo-staff mutations by
// `platformRole`, not membership role. Re-exported here so both axes are reachable
// via the single `@balo/shared/authz` subpath. See `./platform.ts`.
export {
  PLATFORM_CAPABILITIES,
  PLATFORM_ROLE_CAPABILITIES,
  platformRoleHasCapability,
} from './platform';
export type { PlatformCapability } from './platform';

/**
 * The set of roles whose bundle grants `capability` — the single source of truth
 * for admin-role fan-out queries (e.g. `listAdminUserIds`). Keeps "a role is only
 * interpreted in the map" true across `@balo/db`. Returns role keys in the map's
 * insertion order (e.g. `MANAGE_MEMBERS` ⇒ `['owner', 'admin']`).
 */
export function rolesWithCapability(capability: Capability): string[] {
  return Object.keys(ROLE_CAPABILITIES).filter((role) => roleHasCapability(role, capability));
}

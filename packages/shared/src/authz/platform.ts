/**
 * Platform-capability axis (BAL-358 / ADR-1035) — the SINGLE place in the codebase where a
 * platform-staff `platformRole` string is interpreted into platform-wide
 * capabilities. DISTINCT from the party-membership axis in `./index.ts`: that map
 * reads a company/agency membership role (`owner|admin|member|expert`); THIS map
 * reads the platform role (`user|admin|super_admin`) that gates Balo-staff
 * mutations (fees/pricing, and future platform config). Kept a separate file so
 * the membership map stays "the only place a MEMBERSHIP role is read" (HARD
 * CONSTRAINT B) — this is a different role dimension, not a widening of that one.
 *
 * PURE and dependency-free — NO `@balo/db`, NO `postgres`, NO I/O — so it is
 * reachable via the `@balo/shared/authz` subpath from every layer (the web
 * client-safe seam, Server Actions, `@balo/db`) without a bundle or circular
 * dependency.
 */

export const PLATFORM_CAPABILITIES = {
  /** Set a per-project Balo fee override (and future platform fee/pricing config). */
  MANAGE_PLATFORM_FEES: 'manage_platform_fees',
  /** Mint / deactivate / cap-edit promo codes on the credit system (BAL-384). */
  MANAGE_PROMO_CODES: 'manage_promo_codes',
  /**
   * BAL-410 — cancel ANY booked consultation, on any tenant: the support-mediated override the
   * ticket names ("Admin override path exists and is audited with the acting admin's ID").
   *
   * ⚠ A NEW TOKEN RATHER THAN A REUSED ONE, DELIBERATELY. Neither shipped token fits, and
   * authorizing "cancel somebody's call" with a FEE token would make this map lie about what it
   * grants — the one thing a capability map must never do. The PLATFORM axis (ADR-1035) is the
   * right axis because the admin arm holds no membership on either party by construction; the
   * client arm stays on membership `participate` and the expert arm on the engagement axis.
   */
  CANCEL_ANY_MEETING: 'cancel_any_meeting',
} as const;

export type PlatformCapability = (typeof PLATFORM_CAPABILITIES)[keyof typeof PLATFORM_CAPABILITIES];

// The platform-staff bundle: held by BOTH `admin` and `super_admin`. A plain
// `user` (or any unknown role) is NOT staff and holds nothing.
const PLATFORM_STAFF_BUNDLE: readonly PlatformCapability[] = [
  PLATFORM_CAPABILITIES.MANAGE_PLATFORM_FEES,
  PLATFORM_CAPABILITIES.MANAGE_PROMO_CODES,
  PLATFORM_CAPABILITIES.CANCEL_ANY_MEETING,
];

/**
 * Static, platform-axis-only role→capability map. Platform roles are
 * `user|admin|super_admin`; `admin` and `super_admin` are Balo staff and share
 * the staff bundle. Any role not present here (`user`, or an unknown value)
 * grants nothing.
 */
export const PLATFORM_ROLE_CAPABILITIES: Record<string, readonly PlatformCapability[]> = {
  admin: PLATFORM_STAFF_BUNDLE,
  super_admin: PLATFORM_STAFF_BUNDLE,
};

/** True when `role`'s platform bundle grants `capability`. Unknown role ⇒ false. */
export function platformRoleHasCapability(role: string, capability: PlatformCapability): boolean {
  return (PLATFORM_ROLE_CAPABILITIES[role] ?? []).includes(capability);
}

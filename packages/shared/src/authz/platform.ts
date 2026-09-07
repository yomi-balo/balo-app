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
  /**
   * BAL-431 / ADR-1048 §6 — read EVERY file on ANY project request, with its resolved
   * audience and its tombstones: the sole all-files read on the platform.
   *
   * ⚠ A NEW TOKEN RATHER THAN A REUSED ONE, DELIBERATELY. Neither shipped token fits —
   * authorizing "read both parties' confidential documents" with a FEE or PROMO token would
   * make this map lie about what it grants, the one thing a capability map must never do. The
   * PLATFORM axis is the right axis because the admin arm holds no membership on either party
   * by construction: the client arm stays on membership `participate`, and the expert arm is
   * the per-track audience rule in `@balo/shared/authz/request-files`.
   *
   * ⚠ IT GATES A READ, WHICH IS A DELIBERATE WIDENING OF THIS AXIS'S USUAL "capability gates
   * the MUTATION" framing (ADR-1035). The read crosses tenants, and `resolveConversationAccess`
   * DENIES admin observers (`resolve-conversation-access.ts:120`), so the shipped thread gate
   * cannot serve it and the lens alone is not an authorization boundary for party data.
   */
  VIEW_ANY_REQUEST_FILE: 'view_any_request_file',
  /**
   * BAL-540 / ADR-1025 Amendment 1 — close ANY project request, on any tenant, and read the
   * staff-only `close_note`.
   *
   * ⚠ A NEW TOKEN RATHER THAN A REUSED ONE, DELIBERATELY — the CANCEL_ANY_MEETING /
   * VIEW_ANY_REQUEST_FILE argument verbatim: authorizing "end somebody's sourcing process" with a
   * FEE or PROMO token would make this map lie about what it grants. The PLATFORM axis is right
   * because the Balo arm holds no membership on the client company by construction; the client arm
   * stays on membership `manage_requests`.
   */
  CLOSE_ANY_REQUEST: 'close_any_request',
  /**
   * BAL-534 / ADR-1053 Amendment 1 — see the Balo admin surfaces at all: the `/admin/*` route
   * group, and the "Balo admin" nav group inside the member shell.
   *
   * ⚠ A VIEW token on an axis whose usual framing is "capability gates the MUTATION"
   * (ADR-1035) — the same deliberate widening `VIEW_ANY_REQUEST_FILE` documents above. It gates
   * REACHABILITY of a cross-tenant staff surface, which no membership role can express.
   *
   * ⚠ IT IS NOT A PER-SURFACE GRANT. Every admin surface keeps its own token where one exists
   * (promo codes → MANAGE_PROMO_CODES). Per-item tokens for the surfaces that have none arrive
   * with the D5 bundle split; do NOT pre-empt that here.
   */
  VIEW_PLATFORM_ADMIN: 'view_platform_admin',
} as const;

export type PlatformCapability = (typeof PLATFORM_CAPABILITIES)[keyof typeof PLATFORM_CAPABILITIES];

// The platform-staff bundle: held by BOTH `admin` and `super_admin`. A plain
// `user` (or any unknown role) is NOT staff and holds nothing.
const PLATFORM_STAFF_BUNDLE: readonly PlatformCapability[] = [
  PLATFORM_CAPABILITIES.MANAGE_PLATFORM_FEES,
  PLATFORM_CAPABILITIES.MANAGE_PROMO_CODES,
  PLATFORM_CAPABILITIES.CANCEL_ANY_MEETING,
  PLATFORM_CAPABILITIES.VIEW_ANY_REQUEST_FILE,
  PLATFORM_CAPABILITIES.CLOSE_ANY_REQUEST,
  PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN,
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

/**
 * True when `role`'s platform bundle grants `capability`. Unknown role ⇒ false.
 *
 * ⚠ `Object.hasOwn`, NOT a bare index — `PLATFORM_ROLE_CAPABILITIES[role]` indexes a plain
 * object literal, which resolves INHERITED keys too: a `role` of `constructor` / `toString` /
 * `__proto__` would return a non-`undefined` function/object, so `?? []` never fires and
 * `.includes` throws `TypeError` instead of returning `false`. Not reachable today
 * (`platformRole` originates from a pgEnum via a sealed cookie), but this repo already treats
 * the bare-index class as a defect regardless of reachability — see the same guard at
 * `nav-registry.ts:483`.
 */
export function platformRoleHasCapability(role: string, capability: PlatformCapability): boolean {
  if (!Object.hasOwn(PLATFORM_ROLE_CAPABILITIES, role)) return false;
  const capabilities = PLATFORM_ROLE_CAPABILITIES[role];
  if (capabilities === undefined) return false;
  return capabilities.includes(capability);
}

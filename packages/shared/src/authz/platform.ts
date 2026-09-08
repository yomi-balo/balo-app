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
 *
 * ⚠ WIDENED BY BAL-541 in two ways a reader should know before editing:
 *   1. `PLATFORM_ROLE_CAPABILITIES` is NO LONGER one shared bundle for both staff roles —
 *      `super_admin` holds a token `admin` does not (`DELETE_ANY_INTERNAL_NOTE`). ADR-1035
 *      contemplated a flat staff bundle; per-role bundles are the amendment. The shared tokens
 *      still come from ONE constant so the roles cannot drift apart on them.
 *   2. This module now also answers "is this platform role Balo STAFF?" (`platformRoleIsStaff`)
 *      — a question about a SUBJECT's eligibility, not an actor's rights. It lives here because
 *      this file is the single place a platform role string may be interpreted at all.
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
  /**
   * BAL-541 — set or clear the Balo staff member who OWNS a project request
   * (`project_requests.balo_owner_user_id`), on any tenant.
   *
   * ⚠ A NEW TOKEN RATHER THAN A REUSED ONE, DELIBERATELY — the CANCEL_ANY_MEETING /
   * VIEW_ANY_REQUEST_FILE / CLOSE_ANY_REQUEST argument verbatim: authorizing "staff this request"
   * with a FEE, PROMO or CLOSE token would make this map lie about what it grants, the one thing
   * a capability map must never do. In particular it is NOT `CLOSE_ANY_REQUEST` — owning a
   * request and ending it are different acts with different consequences.
   *
   * The PLATFORM axis is right because the subject is BALO'S OWN STAFFING of a request: neither
   * party has, or could have, a membership-axis right to it — there is no client arm and no expert
   * arm to keep. The CANDIDATE's eligibility ("is this user Balo staff?") is a separate, data-side
   * question answered inside the assigning transaction by `platformRoleIsStaff` below.
   */
  ASSIGN_ANY_REQUEST_OWNER: 'assign_any_request_owner',
  /**
   * BAL-541 — read and write the staff-internal notes on an entity (`internal_notes`), and
   * soft-delete one's OWN note.
   *
   * ⚠ A NEW TOKEN RATHER THAN A REUSED ONE, DELIBERATELY — the same argument as its siblings.
   * Named for NOTES rather than for requests on purpose: `internal_note_entity_type` carries one
   * label today and is append-only, so a company/expert/engagement note later widens this token's
   * reach without making its NAME a lie.
   *
   * ⚠ IT GATES A READ AS WELL AS A MUTATION — the second deliberate widening of this axis's usual
   * "capability gates the MUTATION" framing (ADR-1035), after `VIEW_ANY_REQUEST_FILE`. Internal
   * notes are staff-only text with NO party-axis reader at all, so neither lens nor party gate can
   * be the boundary: this token is the boundary.
   *
   * ⚠ IT DOES NOT GRANT DELETING SOMEBODY ELSE'S NOTE. An author deleting their own passes an
   * OWNERSHIP comparison (`note.authorUserId === actor.id`) — data, not a role read, and so
   * permitted under ADR-1029. Deleting ANOTHER author's note needs `DELETE_ANY_INTERNAL_NOTE`.
   */
  MANAGE_INTERNAL_NOTES: 'manage_internal_notes',
  /**
   * BAL-541 — soft-delete an internal note written by SOMEBODY ELSE. `super_admin` ONLY.
   *
   * ⚠ THE AXIS'S FIRST ROLE-DIFFERENTIATED TOKEN, and the reason `PLATFORM_ROLE_CAPABILITIES`
   * below is no longer one shared array. It exists so the ticket's "author or super_admin" rule
   * can be expressed WITHOUT a role read: `platformRole === 'super_admin'` in feature code is
   * BANNED (ADR-1029) and trips the invariant scan. Callers resolve this token and hand the
   * repository a plain boolean — `@balo/db` never sees a platform role for an ACTOR.
   */
  DELETE_ANY_INTERNAL_NOTE: 'delete_any_internal_note',
  /**
   * BAL-553 — operate the product AS another user: start a Balo-local impersonated session.
   * `super_admin` ONLY.
   *
   * ⚠ A NEW TOKEN RATHER THAN A REUSED ONE, DELIBERATELY — the CANCEL_ANY_MEETING /
   * VIEW_ANY_REQUEST_FILE / CLOSE_ANY_REQUEST argument verbatim: authorizing "act as someone
   * else" with any other token would make this map lie about what it grants.
   *
   * ⚠ DELIBERATELY OUTSIDE `PLATFORM_STAFF_BUNDLE`, following the DELETE_ANY_INTERNAL_NOTE
   * precedent. Operating as another user is strictly more powerful than every capability in the
   * staff bundle combined: it reaches every surface that user can reach, on their tenant, with
   * their memberships. `admin` does not hold it.
   */
  IMPERSONATE_USER: 'impersonate_user',
} as const;

export type PlatformCapability = (typeof PLATFORM_CAPABILITIES)[keyof typeof PLATFORM_CAPABILITIES];

/**
 * The platform roles that ARE Balo staff — exactly the keys of `PLATFORM_ROLE_CAPABILITIES`
 * below (pinned by a test: a role that is "staff" but holds no bundle, or vice versa, is a
 * silent authorization hole).
 */
export const PLATFORM_STAFF_ROLES = ['admin', 'super_admin'] as const;

export type PlatformStaffRole = (typeof PLATFORM_STAFF_ROLES)[number];

/**
 * BAL-541 — the ONE "is this platform role Balo staff?" interpretation point.
 *
 * Callers needing the role SET (an eligibility check on some OTHER user — e.g. the candidate Balo
 * owner of a request, or the staff picker's roster) ask here, exactly as callers needing a
 * CAPABILITY ask `platformRoleHasCapability`. `@balo/db`'s `assignOwner` is the first consumer: it
 * reads the candidate's `platform_role` in-transaction and refuses a non-staff candidate, so the
 * role set is interpreted HERE and never inline in a repository.
 *
 * ⚠ NOT a capability check and no substitute for one. Never gate an ACTOR's rights on it — an
 * actor's rights come from `hasPlatformCapability`. This answers a question about a SUBJECT's
 * eligibility to be named, which no capability token expresses.
 */
export function platformRoleIsStaff(role: string): role is PlatformStaffRole {
  return (PLATFORM_STAFF_ROLES as readonly string[]).includes(role);
}

// The platform-staff bundle: held by EVERY staff role. ONE constant, so `admin` and
// `super_admin` can never drift on the tokens they share. A plain `user` (or any
// unknown role) is NOT staff and holds nothing.
const PLATFORM_STAFF_BUNDLE: readonly PlatformCapability[] = [
  PLATFORM_CAPABILITIES.MANAGE_PLATFORM_FEES,
  PLATFORM_CAPABILITIES.MANAGE_PROMO_CODES,
  PLATFORM_CAPABILITIES.CANCEL_ANY_MEETING,
  PLATFORM_CAPABILITIES.VIEW_ANY_REQUEST_FILE,
  PLATFORM_CAPABILITIES.CLOSE_ANY_REQUEST,
  PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN,
  PLATFORM_CAPABILITIES.ASSIGN_ANY_REQUEST_OWNER,
  PLATFORM_CAPABILITIES.MANAGE_INTERNAL_NOTES,
];

/**
 * Static, platform-axis-only role→capability map. Platform roles are
 * `user|admin|super_admin`; `admin` and `super_admin` are Balo staff. Any role not
 * present here (`user`, or an unknown value) grants nothing.
 *
 * ⚠ NO LONGER ONE SHARED ARRAY (BAL-541). `super_admin` holds the staff bundle PLUS
 * `DELETE_ANY_INTERNAL_NOTE`. The bundle above stays ONE constant so the two roles cannot drift
 * on the tokens they share, and the spread below is the ONLY permitted difference between them.
 * Keys MUST stay exactly `PLATFORM_STAFF_ROLES` — a staff role with no entry here would pass
 * `platformRoleIsStaff` while holding nothing.
 */
export const PLATFORM_ROLE_CAPABILITIES: Record<string, readonly PlatformCapability[]> = {
  admin: PLATFORM_STAFF_BUNDLE,
  super_admin: [
    ...PLATFORM_STAFF_BUNDLE,
    PLATFORM_CAPABILITIES.DELETE_ANY_INTERNAL_NOTE,
    PLATFORM_CAPABILITIES.IMPERSONATE_USER,
  ],
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

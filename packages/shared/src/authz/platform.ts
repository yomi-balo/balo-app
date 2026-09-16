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
  /**
   * BAL-548 / ADR-1055 — close an `admin_alerts` row that has NO finder, with a note.
   *
   * ⚠ A NEW TOKEN RATHER THAN A REUSED ONE, DELIBERATELY — the CANCEL_ANY_MEETING /
   * VIEW_ANY_REQUEST_FILE / CLOSE_ANY_REQUEST / ASSIGN_ANY_REQUEST_OWNER argument verbatim.
   * In particular it is NOT `VIEW_PLATFORM_ADMIN`: that token's own docblock says it gates
   * REACHABILITY and "IS NOT A PER-SURFACE GRANT", so gating a MUTATION on it would make this
   * map lie about what it grants — the one thing a capability map must never do. The design
   * prototype's own bundle model agrees (`CAP.RESOLVE_ALERTS` is distinct from `CAP.VIEW_ADMIN`).
   *
   * Granted to BOTH staff roles: it goes in `PLATFORM_STAFF_BUNDLE`, so `admin` (support) holds
   * it — working the queue IS the support role. It is not a `super_admin` privilege.
   */
  RESOLVE_ADMIN_ALERTS: 'resolve_admin_alerts',
  /**
   * BAL-549 — decide an expert APPLICATION (approve or decline) on any tenant, and read the
   * staff-only `decline_note`.
   *
   * ⚠ A NEW TOKEN RATHER THAN A REUSED ONE, DELIBERATELY — the CANCEL_ANY_MEETING /
   * VIEW_ANY_REQUEST_FILE / CLOSE_ANY_REQUEST / RESOLVE_ADMIN_ALERTS argument verbatim.
   * In particular it is NOT `VIEW_PLATFORM_ADMIN`: that token's own docblock says it gates
   * REACHABILITY and "IS NOT A PER-SURFACE GRANT", so gating a MUTATION on it would make this
   * map lie about what it grants. Admitting somebody to the marketplace — or refusing them —
   * is a consequential cross-tenant act with no membership-axis expression: the applicant holds
   * no membership Balo is a party to.
   *
   * Granted to BOTH staff roles: it goes in `PLATFORM_STAFF_BUNDLE`, so `admin` (support) holds
   * it — working the application queue IS the support role, exactly like RESOLVE_ADMIN_ALERTS.
   * It is not a `super_admin` privilege.
   *
   * ⚠ THE PAGE READ IS **NOT** GATED ON THIS. `/admin/applications` is reachable on
   * `VIEW_PLATFORM_ADMIN` (middleware + `admin/layout.tsx`); both ACTIONS additionally resolve
   * this token themselves and must never lean on the layout gate.
   */
  REVIEW_EXPERT_APPLICATIONS: 'review_expert_applications',
  /**
   * BAL-550 — re-drive a stuck capture-pipeline job (`recording-ingest` or
   * `transcript-pipeline`) from the `/admin/health/capture` lens. `super_admin` ONLY.
   *
   * ⚠ A NEW TOKEN RATHER THAN A REUSED ONE, DELIBERATELY — the CANCEL_ANY_MEETING /
   * VIEW_ANY_REQUEST_FILE / CLOSE_ANY_REQUEST / ASSIGN_ANY_REQUEST_OWNER argument verbatim.
   * In particular it is NOT `VIEW_PLATFORM_ADMIN`: that token's own docblock says it gates
   * REACHABILITY and "IS NOT A PER-SURFACE GRANT", so gating a MUTATION on it would make this
   * map lie about what it grants — the one thing a capability map must never do.
   *
   * ⚠ DELIBERATELY OUTSIDE `PLATFORM_STAFF_BUNDLE`, following the `DELETE_ANY_INTERNAL_NOTE` /
   * `IMPERSONATE_USER` precedent. A re-drive spends real vendor budget (a Mux ingest, an
   * Anthropic pass) and re-enters a pipeline that publishes to both parties on a row that has
   * already failed once; `admin` (support) sees the page and the disabled button with "Needs
   * an engineer" copy, and cannot enqueue.
   */
  REDRIVE_JOB: 'redrive_job',
  /**
   * BAL-404 / ADR-1035 — cancel ANY delivery engagement, on any tenant: the support-mediated
   * override that ends a live `active | pending_acceptance` engagement permanently and notifies
   * BOTH parties (`engagement.cancelled`).
   *
   * ⚠ A NEW TOKEN RATHER THAN A REUSED ONE, DELIBERATELY — the CANCEL_ANY_MEETING /
   * VIEW_ANY_REQUEST_FILE / CLOSE_ANY_REQUEST argument verbatim. In particular it is NOT
   * `CANCEL_ANY_MEETING` (that is BAL-410's booked CONSULTATION override — one call, not a
   * delivery relationship) and NOT `CLOSE_ANY_REQUEST` (that is BAL-540's SOURCING request,
   * explicitly not delivery). Authorizing "end somebody's paid delivery" with either would make
   * this map lie about what it grants — the one thing a capability map must never do.
   *
   * The PLATFORM axis is right because the Balo arm holds no membership on either party by
   * construction: the client arm has no cancel right at all today, and the expert arm is the
   * engagement axis (ADR-1046). It REPLACES a `lens !== 'admin'` read, not a role read — the
   * lens keeps gating VIEW (`resolve-engagement-lens.ts`), this token gates the MUTATION.
   *
   * Granted to BOTH staff roles: it goes in `PLATFORM_STAFF_BUNDLE`, so `admin` (support) holds
   * it — exactly the set that could cancel before this token existed. BAL-404 is a consistency
   * migration, NOT an escalation or a narrowing; moving it out of the bundle would silently
   * remove a right `admin` has today.
   */
  CANCEL_ANY_ENGAGEMENT: 'cancel_any_engagement',
  /**
   * BAL-404 / ADR-1035 — create, assign, edit, re-status or remove an action item on ANY
   * delivery engagement, on any tenant. The Balo-staff arm of `gateEngagementParticipant`.
   *
   * ⚠ A NEW TOKEN RATHER THAN A REUSED ONE, DELIBERATELY — the CANCEL_ANY_MEETING /
   * VIEW_ANY_REQUEST_FILE / CLOSE_ANY_REQUEST argument verbatim. In particular it is NOT
   * `CANCEL_ANY_ENGAGEMENT` above: ending somebody's delivery and nudging a task on it are
   * different acts with different consequences, and one token across both would make this map
   * lie about what it grants. It is also NOT `VIEW_PLATFORM_ADMIN` — that token's own docblock
   * says it gates REACHABILITY and "IS NOT A PER-SURFACE GRANT", so gating a MUTATION on it is
   * the same lie. Named for the ENGAGEMENT's action item because `action_items.engagement_id`
   * is NOT NULL and is, per its own schema comment, "the capability scope".
   *
   * ⚠ IT REPLACES NO EXISTING BRANCH — it makes an IMPLICIT one explicit. Before BAL-404 the
   * admin arm of `gateEngagementParticipant` passed by FALL-THROUGH: the client arm had a
   * membership check, the expert arm had the lens equality, and admin had nothing, so the real
   * decision was made upstream inside `resolveEngagementLens`'s `platformRole` set read. That
   * is the shape ADR-1029 bans. The write right itself is unchanged and shipped (an admin's
   * action items already attribute to "Balo" in notifications).
   *
   * Granted to BOTH staff roles: it goes in `PLATFORM_STAFF_BUNDLE`, so `admin` (support) holds
   * it — exactly the set that could write before. A consistency migration, not an escalation.
   */
  MANAGE_ANY_ENGAGEMENT_ACTION_ITEM: 'manage_any_engagement_action_item',
  /**
   * BAL-275 — drive a project request forward along the real origination spine from the dev
   * surface, by invoking each real handler with that step's derived actor. DEV-ONLY: the sole
   * consumer is `apps/web/src/app/dev/_actions/fast-forward.ts`, which refuses before it resolves
   * this token unless `NODE_ENV` is in that file's `FAST_FORWARD_ALLOWED_NODE_ENVS` ALLOW-list
   * (`['development', 'test']` — an allow-list, never a `!== 'production'` deny-list, which fails
   * OPEN on an unset or misspelt var), and whose page `notFound()`s outside those environments.
   *
   * "Sole consumer" is a claim about the WHOLE MONOREPO, and it is pinned as one by
   * `apps/web/src/invariants/fast-forward-capability-dev-only.test.ts`, whose walk covers every
   * non-test `.ts`/`.tsx` file under `apps/*` and `packages/*` — not merely `apps/web`, which is
   * what it used to scan. The scope matters because this token lives in `@balo/shared` and is
   * importable by every workspace, and `apps/api` is ALWAYS a production process: a Fastify route
   * resolving this token would sit behind neither the `NODE_ENV` refusal nor the `notFound()`.
   *
   * ⚠ A NEW TOKEN RATHER THAN A REUSED ONE, DELIBERATELY. The nearest shipped token in kind is
   * `IMPERSONATE_USER` ("operate the product AS another user"), and it is the wrong one for
   * three reasons:
   *   1. its own name says "start a Balo-local impersonated session" — this tool never starts a
   *      session, it acts in-process, so gating on it would make the map lie about what it grants;
   *   2. it is `super_admin`-ONLY and deliberately outside `PLATFORM_STAFF_BUNDLE`, which would
   *      put a dev affordance out of reach of the support-role engineers who need it;
   *   3. it would couple a dev tool's reachability to a production security token — a later
   *      narrowing of impersonation would silently break the dev surface, and a later widening of
   *      the dev surface would be argued as a widening of impersonation.
   * It is also NOT `VIEW_PLATFORM_ADMIN` (that token's own docblock says it gates REACHABILITY and
   * "IS NOT A PER-SURFACE GRANT"), NOT `CLOSE_ANY_REQUEST` (ending a request ≠ driving it through
   * six other states as three other users), and NOT `ASSIGN_ANY_REQUEST_OWNER`.
   *
   * Granted to BOTH staff roles: it goes in `PLATFORM_STAFF_BUNDLE`. It confers nothing in
   * production — no reachable call site resolves it there, which is exactly the workspace-wide
   * single-consumer pin above, not an assertion made on trust.
   */
  FAST_FORWARD_REQUEST: 'fast_forward_request',
  /**
   * BAL-560 / ADR-1035 Amendment 1 §A1.3 — set or clear ANOTHER staff member's per-user platform
   * capability override (`users.platform_capabilities`), and set their `platform_role`.
   * `super_admin` ONLY.
   *
   * ⚠ A NEW TOKEN RATHER THAN A REUSED ONE, DELIBERATELY — the CANCEL_ANY_MEETING /
   * VIEW_ANY_REQUEST_FILE / CLOSE_ANY_REQUEST / REDRIVE_JOB argument verbatim. In particular it
   * is NOT `VIEW_PLATFORM_ADMIN`: that token's own docblock says it gates REACHABILITY and "IS
   * NOT A PER-SURFACE GRANT", so gating a MUTATION on it would make this map lie about what it
   * grants — the one thing a capability map must never do.
   *
   * ⚠ DELIBERATELY OUTSIDE `PLATFORM_STAFF_BUNDLE`, following the `DELETE_ANY_INTERNAL_NOTE` /
   * `IMPERSONATE_USER` / `REDRIVE_JOB` precedent, and for a strictly stronger reason than any of
   * them: GRANTING A POWER IS GREATER THAN THE POWER GRANTED (§A1.3). A holder of this token can
   * write itself — or any other token on this axis — onto any staff row, so putting it in the
   * shared bundle would make every `admin` a latent `super_admin`. `admin` does not hold it.
   *
   * ⚠ IT IS INERT IN THIS TICKET. BAL-560 ships the token, the column and the resolution path;
   * BAL-561 ships the Staff access surface that resolves this token and writes the column.
   * Nothing resolves it today, which is pinned as a fact rather than trusted — PIN E of
   * `apps/web/src/invariants/platform-capability-single-resolution-point.test.ts` asserts that
   * exactly ONE non-test file in the whole monorepo names the CONSTANT (its own definition), and
   * exactly TWO name the wire value `'manage_staff_capabilities'` — this file and the CHECK's SQL
   * literal in `packages/db/src/schema/users.ts`, which is a STORAGE rule rather than a
   * resolution (see the next paragraph, and that pin's own docblock).
   *
   * ⚠⚠ **IT MAY APPEAR ONLY ON A `super_admin` ROW** (fix round 1, security F3; NARROWED in fix
   * round 3, R2). An override REPLACES the role bundle and is deliberately unclamped — it is
   * never intersected with what the role could hold, because an additive or clamped reading
   * makes "an admin, minus promo codes" inexpressible, which is the whole reason the column
   * exists. The direct consequence is that
   * `platform_capabilities = ['manage_staff_capabilities']` on a `platform_role='admin'` row
   * resolves to exactly that token, making a plain admin a latent `super_admin` who can then
   * write any token onto any staff row — a one-row privilege escalation and a self-perpetuating
   * one. The RESOLVER deliberately does not special-case it (that would reintroduce clamping);
   * the STORAGE rule is the correct place to refuse.
   *
   * ⚠ IT IS ENFORCED IN THE DATABASE, inside the `users_platform_capabilities_staff_array` CHECK
   * (`packages/db/src/schema/users.ts`), so it holds against a script or a hand edit as well as
   * against BAL-561's writer, and it holds on a later role change: a `super_admin` → `admin`
   * UPDATE on a row whose override still names the token fails 23514 rather than completing into
   * an escalated state. BAL-561 must therefore clear or re-state an override on ANY role change,
   * not only on a demotion to `user`.
   *
   * ⚠ THE RULE IS "ONLY ON A `super_admin` ROW", **NOT** "never in an override" — the blanket
   * form is incompatible with BAL-561's design. Switching a super_admin to a Custom override
   * pre-fills from the current role bundle, which for a `super_admin` INCLUDES this token, and
   * BAL-561's floor rule 3 requires a sole super_admin to keep `manage_staff_capabilities` while
   * remaining a super admin. A blanket refusal would leave a sole super_admin unable to switch to
   * Custom at all, and would silently strip staff management from any other super_admin who did.
   * The hazard is narrow: the token on a NON-super_admin row.
   */
  MANAGE_STAFF_CAPABILITIES: 'manage_staff_capabilities',
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
  PLATFORM_CAPABILITIES.RESOLVE_ADMIN_ALERTS,
  PLATFORM_CAPABILITIES.REVIEW_EXPERT_APPLICATIONS,
  PLATFORM_CAPABILITIES.CANCEL_ANY_ENGAGEMENT,
  PLATFORM_CAPABILITIES.MANAGE_ANY_ENGAGEMENT_ACTION_ITEM,
  PLATFORM_CAPABILITIES.FAST_FORWARD_REQUEST,
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
    PLATFORM_CAPABILITIES.REDRIVE_JOB,
    PLATFORM_CAPABILITIES.MANAGE_STAFF_CAPABILITIES,
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

/**
 * Runtime type guard over the platform axis — the read-path filter for
 * `users.platform_capabilities` (jsonb, so Postgres validates nothing).
 *
 * Takes `unknown` on purpose: `$type<PlatformCapability[]>()` on a jsonb column is a
 * compile-time claim the database does not enforce (memory `reference_jsonb_date_type_lie`),
 * AND the same value arrives from a sealed cookie, which `getIronSession` type-asserts without
 * validating. A retired token left in an old row must DENY, not throw — the
 * `representations.ts:130-137` rule, and narrowing this axis later must take effect immediately
 * rather than waiting for a backfill.
 */
export function isPlatformCapability(value: unknown): value is PlatformCapability {
  return (
    typeof value === 'string' &&
    (Object.values(PLATFORM_CAPABILITIES) as readonly string[]).includes(value)
  );
}

/**
 * The stored override, normalised — or `null` meaning "INHERIT THE ROLE BUNDLE".
 *
 * Three states, and exactly three (ADR-1035 §A1.2):
 *   · `null`  ⇒ inherit `PLATFORM_ROLE_CAPABILITIES[role]` (every row today).
 *   · `[]`    ⇒ the person holds NOTHING. A real, meaningful state — NOT the same as NULL.
 *   · `[...]` ⇒ the resolved set VERBATIM. It REPLACES the bundle; it never extends it, and it
 *               is never clamped to what the role could hold (§A1.2 — an additive or clamped
 *               reading makes "an admin, minus promo codes" inexpressible, which is the whole
 *               reason the column exists).
 *
 * ⚠ D1 DEFENCE IN DEPTH — a NON-STAFF role IGNORES any override and inherits (which, for
 * `user` and every unknown role, is the empty bundle). The table CHECK
 * `users_platform_capabilities_staff_array` already forbids the row; this is the second lock,
 * so a row that somehow predates or evades the constraint cannot produce a capability-only
 * staff account. `platformRoleIsStaff` reads the ROLE ONLY and is a live gate in three places
 * (`@balo/db` assignOwner, `impersonation.ts`, `session-sync/route.ts`) — two seams
 * disagreeing about the same person is the failure this prevents. `platformRoleIsStaff` is NOT
 * made capability-aware (D1).
 *
 * ⚠ A NON-ARRAY (SQL NULL, JSON `'null'`, a scalar, an object, an absent cookie field) MEANS
 * INHERIT, NOT DENY-EVERYTHING. Deliberate, and the opposite of `storedCapabilities`
 * (`repositories/representations.ts`, which returns `[]`): that column has no "inherit" state,
 * so `[]` there is unambiguous. Here the tri-state makes a malformed value genuinely ambiguous,
 * and an override may WIDEN as well as narrow relative to the role — so "inherit" is the
 * conservative direction (never grants more than the role does today), while "[]" would strip a
 * staff member's entire access on a hand-edit typo. Structurally unreachable either way: the
 * CHECK rejects every non-array non-NULL value.
 */
function normalizePlatformOverride(
  role: string,
  storedOverride: unknown
): readonly PlatformCapability[] | null {
  if (!platformRoleIsStaff(role)) return null;
  if (!Array.isArray(storedOverride)) return null;
  return storedOverride.filter(isPlatformCapability);
}

/**
 * BAL-560 — the RESOLVED platform-capability set for one actor. The single interpretation point
 * for `(platform_role, platform_capabilities)` (ADR-1029): no call site anywhere reads
 * `PLATFORM_ROLE_CAPABILITIES` or `users.platform_capabilities` itself.
 *
 * ⚠ TAKES TWO PRIMITIVES, NOT "THE USER". The ticket says "a sibling that takes the user"; that
 * shape lives in the two APP SEAMS (`apps/web/src/lib/authz/platform.ts`,
 * `apps/api/src/authz/platform.ts`), because web supplies the override from the SEALED SESSION
 * and api supplies it from a LIVE ROW (D6) — two different object shapes over one rule. A core
 * that named either shape would force the other app to fake it.
 *
 * PURE and SYNCHRONOUS, like everything else in this module — a hard constraint, not a
 * preference: `hasPlatformCapability` is synchronous by contract across 48 production call sites
 * in `apps/web`, several inside resolvers whose own docblocks promise it
 * (`resolve-request-lens.ts` "Pure + synchronous — no I/O").
 */
export function resolvePlatformCapabilities(
  role: string,
  storedOverride: unknown
): readonly PlatformCapability[] {
  const override = normalizePlatformOverride(role, storedOverride);
  if (override !== null) return override;
  if (!Object.hasOwn(PLATFORM_ROLE_CAPABILITIES, role)) return [];
  return PLATFORM_ROLE_CAPABILITIES[role] ?? [];
}

/**
 * BAL-560 — does this actor hold `capability`, given their role AND their raw stored override?
 * THE predicate both app seams delegate to.
 *
 * ⚠ THE NULL-OVERRIDE ARM IS A LITERAL CALL TO `platformRoleHasCapability`, ON PURPOSE. The
 * migration's entire safety argument is "a NULL column resolves byte-identically to today for
 * every role"; routing that arm through the UNCHANGED shipped function makes it true by
 * construction rather than by review. Pinned exhaustively over role × token anyway
 * (`resolve-platform-capabilities.test.ts`) so the two arms cannot drift.
 */
export function platformActorHasCapability(
  role: string,
  storedOverride: unknown,
  capability: PlatformCapability
): boolean {
  const override = normalizePlatformOverride(role, storedOverride);
  if (override === null) return platformRoleHasCapability(role, capability);
  return override.includes(capability);
}

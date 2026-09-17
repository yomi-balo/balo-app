/**
 * BAL-561 / ADR-1035 Amendment 1 §A1.3, §A1.4, §A1.9 — THE STAFF-ACCESS RULE MODULE: every
 * I/O-free decision the Staff access save makes, in ONE place.
 *
 * Three consumers share it, and that is why it exists rather than living inside the repository:
 *   · `usersRepository.saveStaffAccess` (`@balo/db`) — evaluates the LOCKED rows inside the save
 *     transaction and refuses; the database is the enforcement point;
 *   · the `/admin/staff-access` client — previews the same rules so the UI can disable and explain
 *     before a save is attempted (the UI explains, the transaction refuses);
 *   · this module's unit tests, which pin each rule once instead of once per consumer.
 * The precedent for "one definition, several layers" is `relationshipDeniesHosting`.
 *
 * PURE and dependency-free like everything under `authz/`: no `@balo/db`, no `postgres`, no I/O.
 *
 * ⚠⚠ EVERY MEMBERSHIP QUESTION RESOLVES ONLY THROUGH `platformActorHasCapability`. No rule here
 * reads a role bundle, a role literal or a raw override: a "does this account hold X" question
 * goes to the shared predicate with the account's (role, customList) pair, which is what keeps
 * these rules identical to the gates that enforce the same capabilities everywhere else
 * (ADR-1029). Pinned by PIN B and its threading entry in
 * `apps/web/src/invariants/platform-capability-single-resolution-point.test.ts`.
 *
 * ⚠ F1's `accountMayGainAccess` GAIN CHECK ASKS A DIFFERENT QUESTION — "did the WHOLE SET grow" —
 * so it calls `resolvePlatformCapabilities` (the whole-set sibling of the same predicate) and
 * compares the before/after sets, rather than looping the predicate over every token. This is NOT
 * a second resolution point: both functions share ONE helper (`normalizePlatformOverride` in
 * `platform.ts`) for the override arm, and the equivalence `resolvePlatformCapabilities(role,
 * override).includes(token) === platformActorHasCapability(role, override, token)` is pinned
 * DIRECTLY, over every role × every stored-override shape × every token, by
 * `resolve-platform-capabilities.test.ts`'s "agrees for every role × stored-override shape × token
 * (4 × 6 × 19 = 456 checks)" test — so it holds by construction AND by a test that would fail if
 * either arm drifted, not by coincidence alone.
 *
 * ⚠ IT NAMES THE `MANAGE_STAFF_CAPABILITIES` CONSTANT AND NEVER ITS WIRE VALUE. PIN E counts the
 * constant's namers (this file is one of them, argued there) and holds the wire value to its two
 * existing namers, the definition and the CHECK's SQL literal. Spelling the string here would be a
 * raw-string resolution that pin exists to catch.
 *
 * ⚠ `customList` IS THE ONLY NAME THIS MODULE USES FOR THE OVERRIDE. It is always NORMALISED
 * (known tokens, de-duplicated, canonical order — `canonicalCustomList`), and `null` means "follows
 * the role". The web surface never holds a raw stored override, which is the property PIN C
 * measures.
 */

import type { PlatformRole } from '../parties';
import {
  PLATFORM_CAPABILITIES,
  isPlatformCapability,
  platformActorHasCapability,
  platformRoleIsStaff,
  resolvePlatformCapabilities,
  type PlatformCapability,
} from './platform';

/**
 * The three platform roles in plain words. Lives here, beside the rules, because both the Lookup
 * Timeline sentences (`@balo/shared/lookup`) and the Staff access page render role moves, and two
 * copies of the wording would drift.
 */
export const PLATFORM_ROLE_LABELS: Readonly<Record<PlatformRole, string>> = {
  user: 'No staff access',
  admin: 'Admin',
  super_admin: 'Super admin',
};

/**
 * The two audit actions a Staff access save writes (ADR-1030). ONE definition: the repository
 * writes them and the Lookup Timeline reads them, so neither spells the string itself.
 */
export const STAFF_ACCESS_AUDIT_ACTIONS = {
  /** metadata `{ from: PlatformRole, to: PlatformRole }` */
  ROLE_CHANGED: 'user.platform_role_changed',
  /** metadata `{ from: customList | null, to: customList | null }` — `null` = follows the role */
  CUSTOM_LIST_SET: 'user.platform_capabilities_set',
} as const;

/** One account as the actor re-check and the floor see it. */
export interface StaffAccessAccount {
  readonly id: string;
  readonly role: PlatformRole;
  /**
   * NORMALISED. `null` = follows the role. `[]` = holds nothing, a real state distinct from `null`.
   */
  readonly customList: readonly PlatformCapability[] | null;
  /** `deleted_at IS NULL AND status = 'active'` — see {@link userRowIsLive}. */
  readonly isLive: boolean;
  /**
   * F1 (S1/S2) — `users.email_verified`. Read alongside `isLive` by {@link accountMayGainAccess}:
   * a save may only GRANT a capability this account did not already resolve when both are true.
   * Pure reductions are unaffected — an unverified or suspended account can still be demoted or
   * trimmed, just never handed something new.
   */
  readonly emailVerified: boolean;
}

/** An account plus the identity the Staff access roster renders. */
export interface StaffAccessPerson extends StaffAccessAccount {
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly email: string;
}

/**
 * A (role, customList) pair as it arrives at the save boundary. `customList` is RAW here — tokens
 * are deliberately not a Zod enum upstream, so an unknown token reaches
 * {@link validateStaffAccessDraft} and comes back as the named `unknown_capability`.
 */
export interface StaffAccessState {
  readonly role: PlatformRole;
  readonly customList: readonly string[] | null;
}

/** One Staff access save, as the server-side caller hands it to the repository. */
export interface StaffAccessSaveRequest {
  /** From the SESSION, never from the client payload. */
  readonly actorUserId: string;
  readonly targetUserId: string;
  /** D6 — the before-state the operator reviewed in the confirm dialog. */
  readonly expected: StaffAccessState;
  readonly next: StaffAccessState;
}

/** A validated draft for one account. */
export interface StaffAccessDraft {
  readonly role: PlatformRole;
  readonly customList: readonly PlatformCapability[] | null;
}

/** What a stored or drafted (role, customList) pair looks like once normalised. */
export interface StaffAccessSnapshot {
  readonly role: PlatformRole;
  readonly customList: readonly PlatformCapability[] | null;
}

/** A draft the storage rules would reject — refused before any write, so no raw 23514 (N7). */
export type StaffAccessDraftRefusal =
  | 'unknown_capability'
  | 'custom_list_requires_staff_role'
  | 'staff_management_requires_super_admin';

/** Refusals decided before the transaction opens. */
export type StaffAccessPrecheckRefusal = StaffAccessDraftRefusal | 'self_edit';

/** Refusals decided on the LOCKED rows inside the transaction. */
export type StaffAccessLockedRefusal =
  | 'actor_not_authorized'
  | 'target_not_found'
  | 'stale'
  | 'no_change'
  | 'target_ineligible'
  | 'floor_violation';

/** Every named refusal a Staff access save can return. */
export type StaffAccessSaveRefusal = StaffAccessPrecheckRefusal | StaffAccessLockedRefusal;

export type StaffAccessDraftValidation =
  | { readonly ok: true; readonly customList: PlatformCapability[] | null }
  | { readonly ok: false; readonly reason: StaffAccessDraftRefusal };

/** The precheck's success arm — what the locked evaluation needs from it. */
export interface StaffAccessPrecheckPassed {
  readonly ok: true;
  /** The validated, canonical list the save will store (`null` = follow the role). */
  readonly nextCustomList: PlatformCapability[] | null;
  /** The operator's reviewed list, normalised the same way the stored row is. */
  readonly expectedCustomList: PlatformCapability[] | null;
}

export type StaffAccessSavePrecheck =
  | StaffAccessPrecheckPassed
  | { readonly ok: false; readonly reason: StaffAccessPrecheckRefusal };

/** What the save transaction read under its lock. */
export interface StaffAccessLockedRows {
  /** Every locked row — staff, target and actor — including deleted ones (they fail liveness). */
  readonly accounts: readonly StaffAccessAccount[];
  /** The target row exists but is soft-deleted. `isLive` alone cannot say so: it also means suspended. */
  readonly targetIsDeleted: boolean;
}

export type StaffAccessSaveVerdict =
  | {
      readonly ok: true;
      readonly before: StaffAccessSnapshot;
      readonly after: StaffAccessSnapshot;
      readonly roleChanged: boolean;
      readonly customListChanged: boolean;
    }
  | { readonly ok: false; readonly reason: StaffAccessLockedRefusal };

/**
 * The CANONICAL STORAGE ORDER: declaration order of `PLATFORM_CAPABILITIES`. Stable, and
 * independent of how any display groups the tokens. (Not `PLATFORM_CAPABILITY_SEAL_ORDER` — that
 * is a cookie wire format, private to the codec, PIN H.)
 */
const CANONICAL_ORDER: readonly PlatformCapability[] = Object.values(PLATFORM_CAPABILITIES);

/**
 * `deleted_at IS NULL AND status = 'active'` — the same liveness rule as the web live gate
 * (`actorHoldsPlatformCapability`), stated once for this module's consumers.
 */
export function userRowIsLive(row: {
  readonly status: string;
  readonly deletedAt: Date | null;
}): boolean {
  return row.deletedAt === null && row.status === 'active';
}

/**
 * Normalise a list of tokens: keep only known tokens, drop duplicates, order canonically. What the
 * save stores ("store normalised sets"), so the read path only ever has retired tokens to filter.
 */
export function canonicalCustomList(tokens: readonly unknown[]): PlatformCapability[] {
  const known = new Set<PlatformCapability>(tokens.filter(isPlatformCapability));
  return CANONICAL_ORDER.filter((capability) => known.has(capability));
}

/**
 * A STORED override, normalised into a `customList`: `null` for a non-staff role or a non-array
 * value (both mean "follows the role"), otherwise {@link canonicalCustomList}. It mirrors the
 * resolver's own normalisation, plus de-duplication and ordering, so it resolves to the same set —
 * pinned by the equivalence test in `staff-access.test.ts`.
 */
export function storedCustomListOf(role: string, stored: unknown): PlatformCapability[] | null {
  if (!platformRoleIsStaff(role)) return null;
  if (!Array.isArray(stored)) return null;
  return canonicalCustomList(stored);
}

/**
 * Two customLists are the same when both are `null`, or both are lists holding the same tokens in
 * any order. `[]` never equals `null`: holding nothing and following the role are different states.
 */
export function sameCustomList(
  a: readonly PlatformCapability[] | null,
  b: readonly PlatformCapability[] | null
): boolean {
  if (a === null || b === null) return a === b;
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((capability) => right.has(capability));
}

/**
 * May an account with this role carry a custom list at all? Staff roles only. The JavaScript form
 * of the `users_platform_capabilities_staff_array` CHECK's `platform_role <> 'user'` arm, and D9's
 * "Custom is unavailable for No staff access".
 */
export function staffCustomListAllowed(role: string): boolean {
  return platformRoleIsStaff(role);
}

/**
 * May a custom list on an account with this role hold `capability`? Every token but one is
 * unrestricted. `MANAGE_STAFF_CAPABILITIES` may sit only on a role whose OWN bundle already grants
 * it — the CHECK's "only on a `super_admin` row" arm, stated through the role-only resolution
 * (`null` override) rather than a role literal.
 */
export function customListCanHold(role: string, capability: PlatformCapability): boolean {
  return (
    capability !== PLATFORM_CAPABILITIES.MANAGE_STAFF_CAPABILITIES ||
    platformActorHasCapability(role, null, PLATFORM_CAPABILITIES.MANAGE_STAFF_CAPABILITIES)
  );
}

/**
 * Validate a drafted (role, customList) pair against the storage rules BEFORE any write (N7 —
 * a raw 23514 would abort the caller's transaction and reach the operator as an opaque error).
 *
 * Order: `null` passes → a list on a non-staff role → any unknown token → canonicalise → the
 * staff-management token on a role that cannot hold it. After de-duplication a list holds at most
 * the axis size, so the CHECK's `<= 64` arm is unreachable from here.
 */
export function validateStaffAccessDraft(
  role: string,
  customList: readonly string[] | null
): StaffAccessDraftValidation {
  if (customList === null) return { ok: true, customList: null };
  if (!staffCustomListAllowed(role)) {
    return { ok: false, reason: 'custom_list_requires_staff_role' };
  }
  if (!customList.every(isPlatformCapability)) {
    return { ok: false, reason: 'unknown_capability' };
  }
  const canonical = canonicalCustomList(customList);
  if (!canonical.every((capability) => customListCanHold(role, capability))) {
    return { ok: false, reason: 'staff_management_requires_super_admin' };
  }
  return { ok: true, customList: canonical };
}

/** Does this LIVE account resolve `capability`, through the shared predicate with its override? */
function accountResolves(account: StaffAccessAccount, capability: PlatformCapability): boolean {
  return account.isLive && platformActorHasCapability(account.role, account.customList, capability);
}

/**
 * F1 (S1 MEDIUM / S2 LOW) — may this account GAIN a capability it does not already resolve? ONE
 * definition, consumed by both the save transaction's evaluation and the UI's `saveBlockOf`
 * preview, so the two agree. `true` only when the account is both live and email-verified — the
 * same bar `run-domain-join.ts` / `resolve-actionable-company.ts` / `resolve-identity.ts` already
 * hold email-based grants to elsewhere in the product. Staff access is the most privileged
 * email-based grant of all and had no such check before this ticket.
 *
 * ⚠ IT NEVER BLOCKS A REDUCTION. `evaluateLockedStaffAccessSave` only consults this when the
 * drafted resolved set contains a capability the account's CURRENT resolved set does not — a pure
 * demotion or a custom-list trim stays allowed regardless, so a suspended or unverified staff
 * member can still be walked back, just never handed something new (BAL-568: the api does not yet
 * read `status`, so a promotion here would take effect immediately on that side).
 */
export function accountMayGainAccess(account: StaffAccessAccount): boolean {
  return account.isLive && account.emailVerified;
}

/**
 * May this account manage staff right now? The in-transaction ACTOR RE-CHECK (M2 / D6): it runs
 * on the actor's LOCKED row, never on the session and never through the web live gate (which reads
 * outside the transaction).
 */
export function accountMayManageStaff(account: StaffAccessAccount): boolean {
  return accountResolves(account, PLATFORM_CAPABILITIES.MANAGE_STAFF_CAPABILITIES);
}

/**
 * D2 — does this account keep the staff-management floor? It must be live AND resolve BOTH
 * `MANAGE_STAFF_CAPABILITIES` and `VIEW_PLATFORM_ADMIN`: someone who can manage staff but cannot
 * open `/admin` (middleware gates it on `VIEW_PLATFORM_ADMIN`) cannot actually do it.
 */
export function accountKeepsStaffManagementFloor(account: StaffAccessAccount): boolean {
  return (
    accountResolves(account, PLATFORM_CAPABILITIES.MANAGE_STAFF_CAPABILITIES) &&
    accountResolves(account, PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN)
  );
}

/** D2 — at least one account keeps the floor. */
export function staffManagementFloorHolds(accounts: readonly StaffAccessAccount[]): boolean {
  return accounts.some(accountKeepsStaffManagementFloor);
}

/**
 * The account list as it would be after `draft` lands on `target`: the entry with `target.id` is
 * replaced, or `target` is appended when absent (a person being given access for the first time).
 */
export function applyStaffAccessDraft(
  accounts: readonly StaffAccessAccount[],
  target: StaffAccessAccount,
  draft: StaffAccessDraft
): StaffAccessAccount[] {
  const drafted: StaffAccessAccount = {
    id: target.id,
    role: draft.role,
    customList: draft.customList,
    isLive: target.isLive,
    emailVerified: target.emailVerified,
  };
  let replaced = false;
  const next = accounts.map((account) => {
    if (account.id !== target.id) return account;
    replaced = true;
    return drafted;
  });
  if (!replaced) next.push(drafted);
  return next;
}

/**
 * Everything decidable BEFORE the transaction opens.
 *
 * D3 — EVERY save on the actor's own record is refused, not only a self-reduction: it also blocks
 * self-escalation (a super admin on a custom list adding tokens back). Then the draft is validated
 * against the storage rules, and the operator's reviewed list is normalised for the stale check.
 */
export function precheckStaffAccessSave(request: StaffAccessSaveRequest): StaffAccessSavePrecheck {
  if (request.actorUserId === request.targetUserId) return { ok: false, reason: 'self_edit' };
  const draft = validateStaffAccessDraft(request.next.role, request.next.customList);
  if (!draft.ok) return { ok: false, reason: draft.reason };
  return {
    ok: true,
    nextCustomList: draft.customList,
    expectedCustomList:
      request.expected.customList === null
        ? null
        : canonicalCustomList(request.expected.customList),
  };
}

/**
 * Decide a save on the rows the transaction LOCKED. Order is part of the contract:
 *   1. actor absent, or unable to manage staff on its locked row → `actor_not_authorized` (M2/D6);
 *   2. target absent or soft-deleted → `target_not_found`;
 *   3. target's role or customList differs from the reviewed before-state → `stale` (D6);
 *   4. nothing would change → `no_change`;
 *   5. the draft GAINS a capability the target does not already resolve, and the target is not
 *      live-and-verified → `target_ineligible` (F1, S1/S2);
 *   6. no account would keep the floor afterwards → `floor_violation` (D2).
 * There is no SQL copy of any of these: the repository locks, calls this, and writes.
 *
 * ⚠ STEP 5 SITS AFTER `stale`/`no_change` AND BEFORE THE FLOOR, DELIBERATELY. A stale request on
 * an ineligible target must still report `stale` — the operator is reviewing data that has already
 * moved, and eligibility is not the reason. A no-op draft never reaches step 5 either. The floor
 * stays last because it is the rarest, most consequential refusal and only worth computing once
 * every cheaper check has passed.
 */
export function evaluateLockedStaffAccessSave(
  request: StaffAccessSaveRequest,
  precheck: StaffAccessPrecheckPassed,
  locked: StaffAccessLockedRows
): StaffAccessSaveVerdict {
  const actor = locked.accounts.find((account) => account.id === request.actorUserId);
  if (actor === undefined || !accountMayManageStaff(actor)) {
    return { ok: false, reason: 'actor_not_authorized' };
  }

  const target = locked.accounts.find((account) => account.id === request.targetUserId);
  if (target === undefined || locked.targetIsDeleted) {
    return { ok: false, reason: 'target_not_found' };
  }

  if (
    target.role !== request.expected.role ||
    !sameCustomList(target.customList, precheck.expectedCustomList)
  ) {
    return { ok: false, reason: 'stale' };
  }

  const after: StaffAccessSnapshot = {
    role: request.next.role,
    customList: precheck.nextCustomList,
  };
  const roleChanged = target.role !== after.role;
  const customListChanged = !sameCustomList(target.customList, after.customList);
  if (!roleChanged && !customListChanged) return { ok: false, reason: 'no_change' };

  const beforeResolved = new Set(resolvePlatformCapabilities(target.role, target.customList));
  const afterResolved = new Set(resolvePlatformCapabilities(after.role, after.customList));
  const gainsCapability = [...afterResolved].some((capability) => !beforeResolved.has(capability));
  if (gainsCapability && !accountMayGainAccess(target)) {
    return { ok: false, reason: 'target_ineligible' };
  }

  if (!staffManagementFloorHolds(applyStaffAccessDraft(locked.accounts, target, after))) {
    return { ok: false, reason: 'floor_violation' };
  }

  return {
    ok: true,
    before: { role: target.role, customList: target.customList },
    after,
    roleChanged,
    customListChanged,
  };
}

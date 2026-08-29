/**
 * BAL-494 / ADR-1053 — the `Workspace` type and its pure derivation core.
 *
 * A **workspace** is the single concept replacing the two independent session fields
 * `activeMode` + `companyId`: the user acts either as their approved EXPERT self, or as
 * ONE COMPANY (held by membership, or — BAL-313/ADR-1029 — by an org-grain representation
 * grant). This module is the PURE core (no I/O); the async fetch-and-call wrapper lives at
 * `apps/web/src/lib/workspaces/derive-workspaces.ts` (mirrors `@balo/shared/authz`'s
 * engagement axis: pure core here, thin per-app resolver there).
 *
 * ⚠ Reachable from CLIENT components (`packages/shared/src/index.ts` is untouched — this is
 * a subpath-only export), so this file must never import `@balo/db` or anything else that
 * drags `postgres` into a browser bundle.
 *
 * ⚠⚠ R1 (orchestrator ruling, BAL-494) — REPRESENTATION WORKSPACES ARE LISTED BUT NOT
 * SWITCHABLE. `deriveWorkspaces` still EMITS `{ type:'company', via:'representation', ... }`
 * entries (so BAL-496 can render them), but `resolveActiveWorkspace` below NEVER selects one
 * as the active workspace — not by explicit switch (that gate lives in
 * `apps/web/src/lib/workspaces/switch-workspace.ts`) and not via the stored
 * `active_company_id` fallback either. That is what makes it safe to keep
 * `WorkspaceSessionProjection.companyRole` a REAL, non-fabricated membership role: the
 * plan's `companyRole: 'member'` fabrication for a representation workspace is DELETED, not
 * shipped. See `resolveActiveWorkspace` for the guard. BAL-314 is the ticket that must
 * reconcile `hasCapability` with representation before this guard can even be reconsidered.
 */

/** How the actor holds a company workspace. Presentation + telemetry only — never an authz input. */
export type WorkspaceVia = 'membership' | 'representation';

/** The company-membership role shape, mirrored from `company_members.role` (native pg enum). */
export type CompanyMemberRole = 'owner' | 'admin' | 'member';

export interface ExpertWorkspace {
  readonly type: 'expert';
  /** Stable identity for set-membership, the switch wire format, and analytics. Always `'expert'`. */
  readonly key: 'expert';
}

export interface CompanyWorkspace {
  readonly type: 'company';
  /** `company:${companyId}`. Deliberately does NOT encode `via`: a company that flips from
   *  representation to membership keeps its key, so no spurious drift and no dead switch target. */
  readonly key: string;
  readonly companyId: string;
  readonly name: string;
  readonly via: WorkspaceVia;
  /** Orchestrator decision: personal workspaces are INCLUDED; BAL-496 decides presentation. */
  readonly isPersonal: boolean;
}

export type Workspace = ExpertWorkspace | CompanyWorkspace;

/** The frozen singleton — there is only ever one expert workspace per actor. */
export const EXPERT_WORKSPACE: ExpertWorkspace = Object.freeze({ type: 'expert', key: 'expert' });

/** `company:${companyId}` — the ONE place this format is written. */
export function companyWorkspaceKey(companyId: string): string {
  return `company:${companyId}`;
}

export type ParsedWorkspaceKey = { kind: 'expert' } | { kind: 'company'; companyId: string };

/**
 * Simple, fixed-length UUID matcher — deliberately NOT a general-purpose regex (no nested
 * quantifiers, no unbounded repetition; SonarCloud S5852 / ReDoS is not engaged by a
 * fixed-width pattern like this one).
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const COMPANY_KEY_PREFIX = 'company:';

/**
 * Parse a raw (client- or query-string-supplied) workspace key. `null` on anything that is
 * not exactly `'expert'` or `company:<uuid>` — including a non-string, an empty id, and a
 * path-traversal-shaped payload (`company:../../etc`, which fails the UUID check).
 */
export function parseWorkspaceKey(raw: unknown): ParsedWorkspaceKey | null {
  if (typeof raw !== 'string') return null;
  if (raw === EXPERT_WORKSPACE.key) return { kind: 'expert' };
  if (!raw.startsWith(COMPANY_KEY_PREFIX)) return null;
  const companyId = raw.slice(COMPANY_KEY_PREFIX.length).toLowerCase();
  if (!UUID_PATTERN.test(companyId)) return null;
  // Lower-cased BEFORE it is compared to anything: Postgres renders uuids lower-case, so an
  // upper-case key from a hand-typed or re-cased URL would otherwise fail set membership in
  // `switchWorkspace` with a confusing "not in your list" rejection.
  return { kind: 'company', companyId };
}

export type WorkspaceSwitchTrigger = 'switcher' | 'deep_link_auto';

// ── Derivation input ──────────────────────────────────────────────────────────────────────

export interface MembershipCompanyInput {
  readonly companyId: string;
  readonly name: string;
  readonly isPersonal: boolean;
  readonly role: CompanyMemberRole;
}

export interface RepresentedCompanyInput {
  readonly companyId: string;
  readonly name: string;
  readonly isPersonal: boolean;
}

export interface WorkspaceDerivationInput {
  /** `expert_profiles` row exists AND `approvedAt !== null` (orchestrator decision; CLAUDE.md auth model). */
  readonly hasApprovedExpertProfile: boolean;
  /** LIVE company memberships in the CANONICAL session-hydration order `[role, joinedAt, id]`. */
  readonly memberships: readonly MembershipCompanyInput[];
  /** Company ids from `listCapabilityEligibleCompanies(userId, PARTICIPATE)` — the ELIGIBILITY GATE. */
  readonly eligibleCompanyIds: readonly string[];
  /**
   * LIVE, `scope='org'`, PARTICIPATE-carrying representation grants, ALREADY FILTERED by the
   * caller (scope + capability + liveness all live in the async wrapper, which has the raw
   * `Representation` rows this pure core deliberately never sees). Empty in production
   * (BAL-313 is data-inert — nothing writes `representations` yet).
   */
  readonly representedCompanies: readonly RepresentedCompanyInput[];
}

export interface StoredWorkspaceChoice {
  readonly activeMode: 'client' | 'expert';
  readonly activeCompanyId: string | null;
}

export interface WorkspaceSessionProjection {
  readonly activeMode: 'client' | 'expert';
  readonly companyId: string;
  readonly companyName: string;
  readonly companyRole: CompanyMemberRole;
}

export interface DerivedWorkspaces {
  readonly workspaces: readonly Workspace[];
  readonly activeWorkspace: Workspace;
  readonly session: WorkspaceSessionProjection;
}

function toCompanyWorkspace(
  entry: { readonly companyId: string; readonly name: string; readonly isPersonal: boolean },
  via: WorkspaceVia
): CompanyWorkspace {
  return {
    type: 'company',
    key: companyWorkspaceKey(entry.companyId),
    companyId: entry.companyId,
    name: entry.name,
    via,
    isPersonal: entry.isPersonal,
  };
}

/**
 * R1 (BAL-494) — resolve the ACTIVE workspace from the stored choice, with the fallback
 * rule applied on EVERY read (a stale/foreign stored value is never trusted). The caller
 * guarantees `membershipWorkspaces` is non-empty (checked once, before this runs), so the
 * "default company workspace" — the FIRST membership-derived entry, in canonical order,
 * NEVER a representation-derived one — always exists.
 *
 * ⚠⚠ THE R1 GUARD: a `company:${id}` match against the stored `activeCompanyId` is only
 * honoured when that workspace's `via === 'membership'`. A representation-only match falls
 * through to the default company workspace, exactly like "not in the list" — a
 * representation workspace can NEVER become `activeWorkspace`, so no projection for one is
 * ever built (see `projectActiveWorkspace`). BAL-314 must reconcile `hasCapability` with
 * representation before this guard is loosened.
 */
function resolveActiveWorkspace(
  workspaces: readonly Workspace[],
  membershipWorkspaces: readonly CompanyWorkspace[],
  stored: StoredWorkspaceChoice,
  hasExpertWorkspace: boolean
): Workspace {
  const [defaultCompanyWorkspace] = membershipWorkspaces;
  if (defaultCompanyWorkspace === undefined) {
    // Unreachable: the caller returns `null` before calling this function when
    // `membershipWorkspaces` is empty. Fail loud rather than silently mis-resolve.
    throw new Error('resolveActiveWorkspace: no default company workspace available');
  }

  if (stored.activeMode === 'expert') {
    // Fail-safe demotion: activeMode='expert' with no (approved) expert profile falls back
    // to the default company workspace rather than resolving to a mode with nothing behind it.
    return hasExpertWorkspace ? EXPERT_WORKSPACE : defaultCompanyWorkspace;
  }

  if (stored.activeCompanyId !== null) {
    const match = workspaces.find(
      (w): w is CompanyWorkspace => w.type === 'company' && w.companyId === stored.activeCompanyId
    );
    // R1 guard — see docblock above.
    if (match !== undefined && match.via === 'membership') return match;
    return defaultCompanyWorkspace;
  }

  return defaultCompanyWorkspace;
}

function roleForCompany(
  companyId: string,
  roleByCompanyId: ReadonlyMap<string, CompanyMemberRole>
): CompanyMemberRole {
  const role = roleByCompanyId.get(companyId);
  if (role === undefined) {
    // Unreachable: `roleByCompanyId` is built from the same eligible membership set that
    // produced every candidate `activeWorkspace` (expert's default company, or a
    // `via:'membership'` match) — see `resolveActiveWorkspace`.
    throw new Error(`deriveWorkspaces: no membership role recorded for company ${companyId}`);
  }
  return role;
}

/**
 * The contract half of expand/contract: project the resolved active workspace onto the
 * legacy four session fields. Only ever called with `EXPERT_WORKSPACE` or a
 * `via:'membership'` `CompanyWorkspace` — `resolveActiveWorkspace` structurally guarantees
 * a representation workspace is never passed here (R1).
 */
function projectActiveWorkspace(
  active: Workspace,
  membershipWorkspaces: readonly CompanyWorkspace[],
  roleByCompanyId: ReadonlyMap<string, CompanyMemberRole>,
  storedActiveCompanyId: string | null
): WorkspaceSessionProjection {
  if (active.type === 'expert') {
    // ⚠ The expert workspace still projects a COMPANY (`SessionUser.companyId` is
    // non-optional), and it must be the user's STORED choice — not blindly the default.
    // `switchWorkspace` deliberately leaves `active_company_id` alone when switching TO
    // expert, on the stated ground that "a trip through the expert workspace must not lose
    // the user's company choice"; projecting `membershipWorkspaces[0]` here would throw that
    // choice away anyway (switch to B → switch to expert → `companyId` silently flips to A).
    // ⚠ EXPAND/CONTRACT IS UNAFFECTED: with `activeCompanyId = NULL` — every pre-BAL-494 row
    // — `stored` matches nothing and the fallback is still `[0]`, bit-identical to today.
    const stored =
      storedActiveCompanyId === null
        ? undefined
        : membershipWorkspaces.find((w) => w.companyId === storedActiveCompanyId);
    const [firstMembershipWorkspace] = membershipWorkspaces;
    const companyWorkspace = stored ?? firstMembershipWorkspace;
    if (companyWorkspace === undefined) {
      throw new Error('projectActiveWorkspace: no default company workspace available');
    }
    return {
      activeMode: 'expert',
      companyId: companyWorkspace.companyId,
      companyName: companyWorkspace.name,
      companyRole: roleForCompany(companyWorkspace.companyId, roleByCompanyId),
    };
  }

  if (active.via !== 'membership') {
    // R1 — structurally unreachable; see `resolveActiveWorkspace`. Fail loud rather than
    // fabricate a role for a non-member (the plan's `companyRole:'member'` is DELETED).
    throw new Error('projectActiveWorkspace: a representation workspace can never be active');
  }

  return {
    activeMode: 'client',
    companyId: active.companyId,
    companyName: active.name,
    companyRole: roleForCompany(active.companyId, roleByCompanyId),
  };
}

/**
 * Derive every workspace this actor may hold, and resolve which one is active.
 *
 * `null` ONLY when the actor has no MEMBERSHIP company workspace at all —
 * `SessionUser.companyId` is non-optional, so the caller must keep its existing "no company
 * membership" behaviour. In production this is unreachable (signup always creates a
 * personal-workspace membership in the same transaction as the user row).
 *
 * Ordering (deterministic — the stable default depends on it):
 *  1. Company workspaces held by MEMBERSHIP, in the order `memberships` arrives — the
 *     canonical `[role asc, joinedAt asc, id asc]` order `usersRepository.findWithCompany`
 *     already produces. No role string is compared here — the order is inherited from SQL.
 *  2. Company workspaces held ONLY by representation, ordered `name asc, companyId asc`.
 *  3. `EXPERT_WORKSPACE` last.
 *
 * Membership beats representation on `via` when both hold for the same company (union by
 * `companyId`, first writer wins) — a membership entry is built first and "claims" the id,
 * so the representation arm skips it.
 */
export function deriveWorkspaces(
  input: WorkspaceDerivationInput,
  stored: StoredWorkspaceChoice
): DerivedWorkspaces | null {
  const eligibleCompanyIds = new Set(input.eligibleCompanyIds);
  const seenCompanyIds = new Set<string>();
  const roleByCompanyId = new Map<string, CompanyMemberRole>();

  const membershipWorkspaces: CompanyWorkspace[] = [];
  for (const membership of input.memberships) {
    if (!eligibleCompanyIds.has(membership.companyId)) continue;
    if (seenCompanyIds.has(membership.companyId)) continue; // defensive: never double-count
    seenCompanyIds.add(membership.companyId);
    roleByCompanyId.set(membership.companyId, membership.role);
    membershipWorkspaces.push(toCompanyWorkspace(membership, 'membership'));
  }

  if (membershipWorkspaces.length === 0) {
    return null;
  }

  // ⚠ `localeCompare` is pinned to 'en'. Unpinned, it follows the RUNTIME's ICU locale, so
  // two servers with different `LANG` could order `workspaces[]` differently — and ORDER
  // decides the fallback active workspace (`resolveActiveWorkspace` takes the first entry
  // when the stored choice is unusable). Two hosts resolving different defaults would make
  // `checkSessionDrift`'s `activeWorkspace.key` comparison ping-pong between them.
  const sortedRepresented = [...input.representedCompanies].sort(
    (a, b) => a.name.localeCompare(b.name, 'en') || a.companyId.localeCompare(b.companyId, 'en')
  );

  // The arm CLAIMS every id it emits. Filtering against `seenCompanyIds` without adding to it
  // would let two representation rows for the SAME company emit two entries with the same
  // `key` — a duplicated switcher row, and an ambiguous target for `switchWorkspace`'s
  // `find(w => w.key === targetKey)`. The async wrapper happens to de-dupe upstream today;
  // the pure core must not depend on that.
  const representationWorkspaces: CompanyWorkspace[] = [];
  for (const represented of sortedRepresented) {
    if (seenCompanyIds.has(represented.companyId)) continue;
    seenCompanyIds.add(represented.companyId);
    representationWorkspaces.push(toCompanyWorkspace(represented, 'representation'));
  }

  const workspaces: Workspace[] = [
    ...membershipWorkspaces,
    ...representationWorkspaces,
    ...(input.hasApprovedExpertProfile ? [EXPERT_WORKSPACE] : []),
  ];

  const activeWorkspace = resolveActiveWorkspace(
    workspaces,
    membershipWorkspaces,
    stored,
    input.hasApprovedExpertProfile
  );

  const session = projectActiveWorkspace(
    activeWorkspace,
    membershipWorkspaces,
    roleByCompanyId,
    stored.activeCompanyId
  );

  return { workspaces, activeWorkspace, session };
}

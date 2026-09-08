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

/** The company-membership role shape, mirrored from `company_members.role` (native pg enum). */
export type CompanyMemberRole = 'owner' | 'admin' | 'member';

export interface ExpertWorkspace {
  readonly type: 'expert';
  /** Stable identity for set-membership, the switch wire format, and analytics. Always `'expert'`. */
  readonly key: 'expert';
}

/**
 * The five fields every company workspace carries regardless of HOW it is held. Not exported:
 * `via` is what makes a company workspace meaningful, so there is no legitimate consumer of a
 * `via`-less company shape. (`ActiveWorkspacePointer` below is a different, narrower thing — the
 * serialized cookie projection — and is declared separately rather than extending this.)
 *
 * `via` itself is declared per-arm below (`'membership'` / `'representation'`), not as a shared
 * literal-union type here — a former `WorkspaceVia` alias was deleted (BAL-507 fix round) once
 * its last two consumers (the pre-union `CompanyWorkspace.via` field and `toCompanyWorkspace`'s
 * parameter) were removed by the discriminated-union restructure, leaving it dead code.
 * How the actor holds a company workspace is PRESENTATION + TELEMETRY ONLY — never an authz
 * input.
 */
interface CompanyWorkspaceBase {
  readonly type: 'company';
  /** `company:${companyId}`. Deliberately does NOT encode `via`: a company that flips from
   *  representation to membership keeps its key, so no spurious drift and no dead switch target. */
  readonly key: string;
  readonly companyId: string;
  readonly name: string;
  /** Orchestrator decision (BAL-494): personal workspaces are INCLUDED; BAL-496 decides presentation. */
  readonly isPersonal: boolean;
}

/**
 * A company held by MEMBERSHIP. `role` is REQUIRED here and is the actor's REAL
 * `company_members.role` — never fabricated, never defaulted.
 *
 * ⚠⚠ PRESENTATION ONLY — NEVER AN AUTHORIZATION INPUT (ADR-1029). `role` being *required* on
 * this arm is a statement about what is KNOWN, not a licence to gate on it. Authorization
 * resolves a capability at the call site: `hasCapability(actor, capability, { companyId })` in
 * `@balo/shared/authz`. Reading `.role` off a workspace to decide what someone MAY DO is the
 * exact drift ADR-1029 exists to prevent, and it is CI-enforced —
 * `apps/web/src/invariants/workspace-role-presentation.test.ts` fails the build on a DIRECT
 * `.role` read off a `Workspace`-typed value outside its single-entry allowlist (the switcher's
 * subtitle builder, `apps/web/src/components/layout/workspace-presentation.ts`).
 *
 * ⚠ WHAT "DIRECT" COVERS, PRECISELY — an earlier wording of this sentence claimed "including
 * renamed … forms" without qualification, and that is FALSE. Caught: property access
 * (`w.role`), element access with a string-literal or string-literal-TYPED key (`w['role']`,
 * `w[ROLE_FIELD]`), destructuring (`const { role } = w`), and the IDENTIFIER spelling of a
 * rename (`const { role: myRole } = w`). NOT caught, each measured: the non-identifier rename
 * spellings `const { 'role': r } = w` and `const { [KEY]: r } = w`, destructuring ASSIGNMENT
 * (`({ role } = w)`), and any read through a value first re-typed into a mapped or anonymous
 * type (`Readonly<…>` / `Pick<…>` at the read site, a spread copy). That suite's own KNOWN BLIND
 * SPOTS docblock is the maintained list; this note exists so the guarantee is not overstated
 * HERE, where a reader meets it first. The invariant is a backstop against drift, not a proof of
 * absence — review still has to think.
 */
export interface MembershipCompanyWorkspace extends CompanyWorkspaceBase {
  readonly via: 'membership';
  readonly role: CompanyMemberRole;
}

/**
 * A company held ONLY by an org-grain representation grant (BAL-313 / ADR-1029).
 *
 * ⚠⚠ THERE IS NO `role` MEMBER, AT ALL — not `role?: …`, not `role: undefined`. BAL-494
 * deliberately DELETED the plan's `companyRole: 'member'` fabrication (see the R1 note at the
 * top of this file) because a fabricated role makes `hasCapability` and the presentation layer
 * disagree. BAL-507 promotes that from a code-path property to a TYPE-LEVEL one:
 * `{ via: 'representation', role: 'owner' }` is now a COMPILE ERROR, pinned under
 * `@ts-expect-error` in `apps/web/src/invariants/workspace-role-presentation.test.ts` (an
 * `apps/web` file, because `web#check-types` compiles it — nothing in CI compiles any test
 * file under `packages/shared/src`).
 *
 * ⚠ The runtime shape must have NO `role` KEY. `index.test.ts` asserts `'role' in w === false`;
 * writing `role: undefined` would type-check and fail that assertion.
 */
export interface RepresentationCompanyWorkspace extends CompanyWorkspaceBase {
  readonly via: 'representation';
}

export type CompanyWorkspace = MembershipCompanyWorkspace | RepresentationCompanyWorkspace;

export type Workspace = ExpertWorkspace | CompanyWorkspace;

/**
 * BAL-507 (R-A) — THE SERIALIZED PROJECTION of the active workspace, and the ONLY workspace
 * shape that is ever sealed into the `balo_session` cookie (`SessionUser.activeWorkspace`).
 *
 * ⚠⚠ WHY THIS EXISTS AND WHY IT IS NOT `Workspace`. `getIronSession<SessionData>()` is a TYPE
 * ASSERTION over cookie JSON — no Zod, no runtime shape check. With a 7-day cookie TTL, a
 * session sealed before BAL-496 carries `{ type:'company', via:'membership', … }` with NO
 * `role`: a value `MembershipCompanyWorkspace` now declares impossible. Typing the cookie field
 * as `Workspace` would therefore be a type LIE for a week after every deploy, and a permanent
 * one for any future field the union makes required. The pointer carries only IDENTITY
 * (`type` / `key` / `companyId`) and DISPLAY (`name`) — never `via`, `isPersonal`, or `role` —
 * so no `Workspace`, `CompanyWorkspace`, or `MembershipCompanyWorkspace` is ever reconstructed
 * from cookie JSON and there is nothing for a stale cookie to lie about.
 *
 * ⚠ A discriminated union on `type`, not `{ companyId?: string }`, so
 * `name-workspace-and-complete.ts`'s `activeWorkspace?.type === 'company'` guard narrows to a
 * shape where `companyId` and `name` are non-optional — no cast, no `!`.
 *
 * ⚠ `Workspace` IS structurally assignable to this type (it has every member plus extras), so
 * the compiler does NOT force writers through `toActiveWorkspacePointer`. That is deliberate —
 * a nominal brand or `via?: never` phantom members would buy byte-hygiene, not correctness,
 * because the TYPE is what stops a reader touching `.role`, whatever bytes are in the cookie.
 * The single-conversion-site rule is held by a runtime key-set pin in
 * `apps/web/src/lib/workspaces/session-workspace.test.ts`.
 */
export interface ExpertWorkspacePointer {
  readonly type: 'expert';
  readonly key: 'expert';
}

export interface CompanyWorkspacePointer {
  readonly type: 'company';
  readonly key: string;
  readonly companyId: string;
  readonly name: string;
}

export type ActiveWorkspacePointer = ExpertWorkspacePointer | CompanyWorkspacePointer;

/**
 * THE ONE place a live `Workspace` becomes the sealed pointer. Every session writer goes through
 * `applyWorkspaceDerivationToSessionUser` (`apps/web/src/lib/workspaces/session-workspace.ts`),
 * which is this function's only caller. The rename patch in
 * `apps/web/src/lib/auth/actions/name-workspace-and-complete.ts` is a pointer→pointer edit, not a
 * conversion, so it does not need — and must not duplicate — this projection.
 */
export function toActiveWorkspacePointer(workspace: Workspace): ActiveWorkspacePointer {
  if (workspace.type === 'expert') return { type: 'expert', key: workspace.key };
  return {
    type: 'company',
    key: workspace.key,
    companyId: workspace.companyId,
    name: workspace.name,
  };
}

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

function companyWorkspaceBase(entry: {
  readonly companyId: string;
  readonly name: string;
  readonly isPersonal: boolean;
}): CompanyWorkspaceBase {
  return {
    type: 'company',
    key: companyWorkspaceKey(entry.companyId),
    companyId: entry.companyId,
    name: entry.name,
    isPersonal: entry.isPersonal,
  };
}

/** D2 — the role rides along HERE and only here; `MembershipCompanyInput.role` is required, so
 *  there is nothing to default and nothing to fabricate. */
function toMembershipCompanyWorkspace(entry: MembershipCompanyInput): MembershipCompanyWorkspace {
  return { ...companyWorkspaceBase(entry), via: 'membership', role: entry.role };
}

/** D2 — emits NO `role` key at all (not `role: undefined`): `index.test.ts` asserts
 *  `'role' in w === false`, and `RepresentedCompanyInput` has no role to supply anyway. */
function toRepresentationCompanyWorkspace(
  entry: RepresentedCompanyInput
): RepresentationCompanyWorkspace {
  return { ...companyWorkspaceBase(entry), via: 'representation' };
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
    // Two builders, one per arm. The `role ⟺ membership` invariant is now carried by the TYPE
    // (see `MembershipCompanyWorkspace`), not by which builder happens to be called.
    membershipWorkspaces.push(toMembershipCompanyWorkspace(membership));
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
    representationWorkspaces.push(toRepresentationCompanyWorkspace(represented));
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

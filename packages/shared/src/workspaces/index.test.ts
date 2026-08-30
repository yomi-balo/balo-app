import { describe, it, expect } from 'vitest';
import {
  deriveWorkspaces,
  parseWorkspaceKey,
  companyWorkspaceKey,
  EXPERT_WORKSPACE,
  type WorkspaceDerivationInput,
  type StoredWorkspaceChoice,
  type CompanyWorkspace,
  type MembershipCompanyInput,
  type RepresentedCompanyInput,
} from './index';

// ── Fixtures ────────────────────────────────────────────────────────────────

const PERSONAL_ID = '11111111-1111-4111-8111-111111111111';
const ORG_ID = '22222222-2222-4222-8222-222222222222';
const REP_ID = '33333333-3333-4333-8333-333333333333';

function membership(overrides: Partial<MembershipCompanyInput> = {}): MembershipCompanyInput {
  return {
    companyId: PERSONAL_ID,
    name: "Dana's Workspace",
    isPersonal: true,
    role: 'owner',
    ...overrides,
  };
}

function represented(overrides: Partial<RepresentedCompanyInput> = {}): RepresentedCompanyInput {
  return {
    companyId: REP_ID,
    name: 'Represented Co',
    isPersonal: false,
    ...overrides,
  };
}

function baseInput(overrides: Partial<WorkspaceDerivationInput> = {}): WorkspaceDerivationInput {
  return {
    hasApprovedExpertProfile: false,
    memberships: [membership()],
    eligibleCompanyIds: [PERSONAL_ID],
    representedCompanies: [],
    ...overrides,
  };
}

/** An approved expert who is ALSO a member of two companies (personal first, then Northwind). */
function approvedExpertWithTwoMemberships(): WorkspaceDerivationInput {
  return baseInput({
    hasApprovedExpertProfile: true,
    memberships: [
      membership(),
      membership({ companyId: ORG_ID, name: 'Northwind', isPersonal: false, role: 'admin' }),
    ],
    eligibleCompanyIds: [PERSONAL_ID, ORG_ID],
  });
}

function stored(overrides: Partial<StoredWorkspaceChoice> = {}): StoredWorkspaceChoice {
  return { activeMode: 'client', activeCompanyId: null, ...overrides };
}

function companyWorkspaces(workspaces: DerivedNonNull['workspaces']): CompanyWorkspace[] {
  return workspaces.filter((w): w is CompanyWorkspace => w.type === 'company');
}

type DerivedNonNull = NonNullable<ReturnType<typeof deriveWorkspaces>>;

function deriveNonNull(
  input: WorkspaceDerivationInput,
  storedChoice: StoredWorkspaceChoice
): DerivedNonNull {
  const result = deriveWorkspaces(input, storedChoice);
  if (result === null) throw new Error('expected a non-null derivation');
  return result;
}

// ── Matrix: membership / representation / both / expert / none ──────────────

describe('deriveWorkspaces — matrix', () => {
  it('membership only: one company workspace, no expert workspace', () => {
    const result = deriveNonNull(baseInput(), stored());
    expect(result.workspaces).toHaveLength(1);
    expect(result.workspaces[0]).toMatchObject({
      type: 'company',
      companyId: PERSONAL_ID,
      via: 'membership',
    });
    expect(result.activeWorkspace).toEqual(result.workspaces[0]);
  });

  it('representation only (no membership at all) — returns null: no default company exists', () => {
    const result = deriveWorkspaces(
      {
        hasApprovedExpertProfile: false,
        memberships: [],
        eligibleCompanyIds: [],
        representedCompanies: [represented()],
      },
      stored()
    );
    expect(result).toBeNull();
  });

  it('membership AND representation for DIFFERENT companies: both listed, membership first', () => {
    const result = deriveNonNull(baseInput({ representedCompanies: [represented()] }), stored());
    const companies = companyWorkspaces(result.workspaces);
    expect(companies).toHaveLength(2);
    expect(companies[0]).toMatchObject({ companyId: PERSONAL_ID, via: 'membership' });
    expect(companies[1]).toMatchObject({ companyId: REP_ID, via: 'representation' });
  });

  it('membership wins `via` when both hold for the SAME company (union by companyId)', () => {
    const result = deriveNonNull(
      baseInput({
        memberships: [membership({ companyId: ORG_ID, name: 'Northwind', role: 'admin' })],
        eligibleCompanyIds: [ORG_ID],
        representedCompanies: [represented({ companyId: ORG_ID, name: 'Northwind' })],
      }),
      stored()
    );
    const companies = companyWorkspaces(result.workspaces);
    expect(companies).toHaveLength(1);
    expect(companies[0]).toMatchObject({ companyId: ORG_ID, via: 'membership' });
  });

  it('expert only is impossible: an expert workspace requires a membership to exist too', () => {
    // hasApprovedExpertProfile true but zero memberships → still null (no default company).
    const result = deriveWorkspaces(
      {
        hasApprovedExpertProfile: true,
        memberships: [],
        eligibleCompanyIds: [],
        representedCompanies: [],
      },
      stored({ activeMode: 'expert' })
    );
    expect(result).toBeNull();
  });

  it('expert + company: expert workspace appended LAST', () => {
    const result = deriveNonNull(baseInput({ hasApprovedExpertProfile: true }), stored());
    expect(result.workspaces.at(-1)).toEqual(EXPERT_WORKSPACE);
  });

  it('none: no membership, no representation, no expert profile → null', () => {
    const result = deriveWorkspaces(
      {
        hasApprovedExpertProfile: false,
        memberships: [],
        eligibleCompanyIds: [],
        representedCompanies: [],
      },
      stored()
    );
    expect(result).toBeNull();
  });
});

// ── Representation arm filters ───────────────────────────────────────────────

describe('deriveWorkspaces — representation arm', () => {
  it('a representation entry passed in is trusted as already-filtered (scope/capability live in the wrapper)', () => {
    // The pure core takes `representedCompanies` as pre-filtered input — this test pins that
    // contract: whatever is passed through appears (minus a membership union), nothing more.
    const result = deriveNonNull(baseInput({ representedCompanies: [represented()] }), stored());
    const companies = companyWorkspaces(result.workspaces);
    expect(companies.some((c) => c.companyId === REP_ID && c.via === 'representation')).toBe(true);
  });

  it('eligibility gate: a membership whose id is absent from eligibleCompanyIds is dropped', () => {
    const result = deriveWorkspaces(
      {
        hasApprovedExpertProfile: false,
        memberships: [membership(), membership({ companyId: ORG_ID, name: 'Northwind' })],
        eligibleCompanyIds: [PERSONAL_ID], // ORG_ID is NOT eligible
        representedCompanies: [],
      },
      stored()
    );
    expect(result).not.toBeNull();
    const companies = companyWorkspaces(result!.workspaces);
    expect(companies).toHaveLength(1);
    expect(companies[0]?.companyId).toBe(PERSONAL_ID);
  });
});

// ── Ordering ──────────────────────────────────────────────────────────────

describe('deriveWorkspaces — ordering', () => {
  it('memberships preserve supplied order; representation-only sorted name/id asc; expert last', () => {
    const repB = represented({
      companyId: '44444444-4444-4444-8444-444444444444',
      name: 'Beta Co',
    });
    const repA = represented({
      companyId: '55555555-5555-4555-8555-555555555555',
      name: 'Alpha Co',
    });

    const result = deriveNonNull(
      baseInput({
        hasApprovedExpertProfile: true,
        representedCompanies: [repB, repA],
      }),
      stored()
    );

    expect(result.workspaces.map((w) => w.key)).toEqual([
      companyWorkspaceKey(PERSONAL_ID),
      companyWorkspaceKey(repA.companyId), // Alpha before Beta
      companyWorkspaceKey(repB.companyId),
      EXPERT_WORKSPACE.key,
    ]);
  });

  it('the default company is the FIRST membership-derived entry, never a representation one', () => {
    const result = deriveNonNull(
      baseInput({ representedCompanies: [represented({ name: 'AAA First Alphabetically' })] }),
      stored({ activeMode: 'expert' })
    );
    // activeMode expert but no expert workspace derived → falls back to default company,
    // which must be the membership entry even though the rep company sorts first alphabetically.
    expect(result.activeWorkspace).toMatchObject({ companyId: PERSONAL_ID, via: 'membership' });
  });
});

// ── Fallback table (§2a) ─────────────────────────────────────────────────────

describe('deriveWorkspaces — fallback table', () => {
  it("activeMode='expert' with an expert workspace → EXPERT_WORKSPACE", () => {
    const result = deriveNonNull(
      baseInput({ hasApprovedExpertProfile: true }),
      stored({ activeMode: 'expert' })
    );
    expect(result.activeWorkspace).toEqual(EXPERT_WORKSPACE);
  });

  it("activeMode='expert' with NO expert workspace → default company (fail-safe demotion)", () => {
    const result = deriveNonNull(
      baseInput({ hasApprovedExpertProfile: false }),
      stored({ activeMode: 'expert' })
    );
    expect(result.activeWorkspace).toMatchObject({ companyId: PERSONAL_ID });
    expect(result.session.activeMode).toBe('client');
  });

  it('activeCompanyId=X matching a membership workspace → that workspace', () => {
    const result = deriveNonNull(
      baseInput({
        memberships: [
          membership(),
          membership({ companyId: ORG_ID, name: 'Northwind', role: 'admin' }),
        ],
        eligibleCompanyIds: [PERSONAL_ID, ORG_ID],
      }),
      stored({ activeCompanyId: ORG_ID })
    );
    expect(result.activeWorkspace).toMatchObject({ companyId: ORG_ID, via: 'membership' });
    expect(result.session.companyRole).toBe('admin');
  });

  it('activeCompanyId=X NOT in the derived list → default company workspace', () => {
    const result = deriveNonNull(baseInput(), stored({ activeCompanyId: 'not-in-the-list' }));
    expect(result.activeWorkspace).toMatchObject({ companyId: PERSONAL_ID });
  });

  it('activeCompanyId=null → default company workspace', () => {
    const result = deriveNonNull(baseInput(), stored({ activeCompanyId: null }));
    expect(result.activeWorkspace).toMatchObject({ companyId: PERSONAL_ID });
  });

  it('no company workspace at all → null', () => {
    const result = deriveWorkspaces(
      {
        hasApprovedExpertProfile: true,
        memberships: [],
        eligibleCompanyIds: [],
        representedCompanies: [],
      },
      stored({ activeMode: 'expert' })
    );
    expect(result).toBeNull();
  });

  it('R1 — activeCompanyId=X matching a REPRESENTATION-ONLY workspace falls back to default company', () => {
    const result = deriveNonNull(
      baseInput({ representedCompanies: [represented()] }),
      stored({ activeCompanyId: REP_ID })
    );
    // Must NOT resolve to the representation workspace, even though its id matches exactly.
    expect(result.activeWorkspace).toMatchObject({ companyId: PERSONAL_ID, via: 'membership' });
    expect(result.session.companyId).toBe(PERSONAL_ID);
    expect(result.session.companyRole).toBe('owner');
  });
});

// ── Projection ────────────────────────────────────────────────────────────

describe('deriveWorkspaces — projection', () => {
  it("expert → activeMode:'expert' AND a populated companyId (the default company)", () => {
    const result = deriveNonNull(
      baseInput({ hasApprovedExpertProfile: true }),
      stored({ activeMode: 'expert' })
    );
    expect(result.session).toEqual({
      activeMode: 'expert',
      companyId: PERSONAL_ID,
      companyName: "Dana's Workspace",
      companyRole: 'owner',
    });
  });

  it('expert → the STORED company, not blindly the default (the company choice survives)', () => {
    // `switchWorkspace` leaves `active_company_id` alone when switching TO expert, precisely
    // so the company choice is not lost. The projection must honour it, or "switch to B →
    // switch to expert" silently flips `session.companyId` back to A.
    const result = deriveNonNull(
      approvedExpertWithTwoMemberships(),
      stored({ activeMode: 'expert', activeCompanyId: ORG_ID })
    );

    expect(result.activeWorkspace).toEqual(EXPERT_WORKSPACE);
    expect(result.session).toEqual({
      activeMode: 'expert',
      companyId: ORG_ID,
      companyName: 'Northwind',
      companyRole: 'admin',
    });
  });

  it('expert with a NULL stored company still projects the DEFAULT company (expand/contract)', () => {
    // Every pre-BAL-494 row has `active_company_id = NULL`; the fallback must remain
    // `membershipWorkspaces[0]`, bit-identical to today.
    const result = deriveNonNull(
      approvedExpertWithTwoMemberships(),
      stored({ activeMode: 'expert', activeCompanyId: null })
    );
    expect(result.session.companyId).toBe(PERSONAL_ID);
    expect(result.session.companyRole).toBe('owner');
  });

  it('expert with a STALE stored company falls back to the default company', () => {
    const result = deriveNonNull(
      baseInput({ hasApprovedExpertProfile: true }),
      stored({ activeMode: 'expert', activeCompanyId: ORG_ID }) // not in the derived list
    );
    expect(result.session.companyId).toBe(PERSONAL_ID);
  });

  it('R1 — expert never projects a REPRESENTATION company even when it is the stored choice', () => {
    const result = deriveNonNull(
      baseInput({ hasApprovedExpertProfile: true, representedCompanies: [represented()] }),
      stored({ activeMode: 'expert', activeCompanyId: REP_ID })
    );
    expect(result.session.companyId).toBe(PERSONAL_ID);
    expect(result.session.companyRole).toBe('owner');
  });

  it('membership company → that company real role', () => {
    const result = deriveNonNull(
      baseInput({ memberships: [membership({ role: 'admin' })] }),
      stored()
    );
    expect(result.session.companyRole).toBe('admin');
  });

  it('R1 — a representation workspace is NEVER the projected companyRole source (no fabricated "member")', () => {
    // Exhaustively: for every stored state that could conceivably target the rep company,
    // the projected companyRole is always the REAL membership role, never a placeholder.
    const cases: StoredWorkspaceChoice[] = [
      stored({ activeCompanyId: REP_ID }),
      stored({ activeCompanyId: null }),
      stored({ activeMode: 'expert' }),
    ];
    for (const storedChoice of cases) {
      const result = deriveNonNull(
        baseInput({ representedCompanies: [represented()] }),
        storedChoice
      );
      expect(result.session.companyRole).toBe('owner'); // the real personal-workspace role
      expect(result.session.companyId).toBe(PERSONAL_ID); // never REP_ID
    }
  });
});

// ── Representation arm: id claiming ───────────────────────────────────────

describe('deriveWorkspaces — the representation arm claims the ids it emits', () => {
  it('emits ONE workspace when two representation rows name the same company', () => {
    // The async wrapper de-dupes upstream today, but the pure core must not depend on that:
    // two entries would produce a duplicated switcher row and an ambiguous key list.
    const result = deriveNonNull(
      baseInput({
        representedCompanies: [
          represented({ name: 'Represented Co' }),
          represented({ name: 'Represented Co (dup grant)' }),
        ],
      }),
      stored()
    );

    const repKeys = result.workspaces
      .filter((w): w is CompanyWorkspace => w.type === 'company' && w.via === 'representation')
      .map((w) => w.key);
    expect(repKeys).toEqual([companyWorkspaceKey(REP_ID)]);
    expect(new Set(result.workspaces.map((w) => w.key)).size).toBe(result.workspaces.length);
  });

  it('a company held by BOTH membership and representation stays membership-only', () => {
    const result = deriveNonNull(
      baseInput({ representedCompanies: [represented({ companyId: PERSONAL_ID })] }),
      stored()
    );
    expect(companyWorkspaces(result.workspaces)).toHaveLength(1);
    expect(companyWorkspaces(result.workspaces)[0]?.via).toBe('membership');
  });
});

// ── parseWorkspaceKey ─────────────────────────────────────────────────────

describe('parseWorkspaceKey', () => {
  it("accepts 'expert'", () => {
    expect(parseWorkspaceKey('expert')).toEqual({ kind: 'expert' });
  });

  it('lower-cases an UPPER-CASE uuid so it matches the pg-rendered key', () => {
    expect(parseWorkspaceKey(`company:${ORG_ID.toUpperCase()}`)).toEqual({
      kind: 'company',
      companyId: ORG_ID,
    });
  });

  it('accepts company:<uuid>', () => {
    expect(parseWorkspaceKey(`company:${ORG_ID}`)).toEqual({ kind: 'company', companyId: ORG_ID });
  });

  it('rejects a non-uuid company id', () => {
    expect(parseWorkspaceKey('company:not-a-uuid')).toBeNull();
  });

  it('rejects an empty company id', () => {
    expect(parseWorkspaceKey('company:')).toBeNull();
  });

  it('rejects a path-traversal payload', () => {
    expect(parseWorkspaceKey('company:../../etc/passwd')).toBeNull();
  });

  it('rejects a non-string', () => {
    expect(parseWorkspaceKey(42)).toBeNull();
    expect(parseWorkspaceKey(null)).toBeNull();
    expect(parseWorkspaceKey(undefined)).toBeNull();
    expect(parseWorkspaceKey({ kind: 'expert' })).toBeNull();
  });

  it('rejects an unrelated string', () => {
    expect(parseWorkspaceKey('admin')).toBeNull();
    expect(parseWorkspaceKey('')).toBeNull();
  });
});

// ── BAL-496 (D2) — CompanyWorkspace.role ─────────────────────────────────────

describe('BAL-496 (D2) — CompanyWorkspace.role', () => {
  it('membership workspaces carry the REAL role — one case each for owner / admin / member', () => {
    for (const role of ['owner', 'admin', 'member'] as const) {
      const result = deriveNonNull(baseInput({ memberships: [membership({ role })] }), stored());
      const [companyWorkspace] = companyWorkspaces(result.workspaces);
      expect(companyWorkspace?.role).toBe(role);
    }
  });

  it("a representation-only workspace has role === undefined AND 'role' in w === false", () => {
    const result = deriveNonNull(baseInput({ representedCompanies: [represented()] }), stored());
    const repWorkspace = companyWorkspaces(result.workspaces).find(
      (w) => w.via === 'representation'
    );
    expect(repWorkspace).toBeDefined();
    expect(repWorkspace?.role).toBeUndefined();
    expect('role' in (repWorkspace ?? {})).toBe(false);
  });

  it('THE INVARIANT — for every company workspace, (role !== undefined) === (via === "membership")', () => {
    const result = deriveNonNull(
      baseInput({
        memberships: [
          membership(),
          membership({ companyId: ORG_ID, name: 'Northwind', role: 'admin' }),
        ],
        eligibleCompanyIds: [PERSONAL_ID, ORG_ID],
        representedCompanies: [represented()],
      }),
      stored()
    );
    for (const workspace of companyWorkspaces(result.workspaces)) {
      expect(workspace.role !== undefined).toBe(workspace.via === 'membership');
    }
  });

  it('membership WINS for a company held both ways: keeps via:membership AND the real role', () => {
    const result = deriveNonNull(
      baseInput({
        memberships: [membership({ companyId: ORG_ID, name: 'Northwind', role: 'admin' })],
        eligibleCompanyIds: [ORG_ID],
        representedCompanies: [represented({ companyId: ORG_ID, name: 'Northwind' })],
      }),
      stored()
    );
    const companies = companyWorkspaces(result.workspaces);
    expect(companies).toHaveLength(1);
    expect(companies[0]).toMatchObject({ companyId: ORG_ID, via: 'membership', role: 'admin' });
  });

  it('REGRESSION GUARD — session.companyRole is unchanged by adding role to the list', () => {
    const result = deriveNonNull(
      baseInput({ memberships: [membership({ role: 'admin' })] }),
      stored()
    );
    expect(result.session.companyRole).toBe('admin');
  });
});

// ── Derivation scale (was: "cookie budget") ─────────────────────────────────

describe('derivation at scale', () => {
  it('emits one entry per eligible company for a 15-company user, with no truncation', () => {
    // ⚠ THIS IS NO LONGER A COOKIE TEST. An earlier cut sealed `workspaces[]` into
    // `balo_session` and guarded it here with `JSON.stringify(...).length` — which measures
    // the PLAINTEXT, not the seal, and so never engaged the real 4096-byte browser limit
    // (the seal is roughly twice the plaintext). Security fix round 2 removed the list from
    // the cookie entirely; the genuine, seal-measuring guard is
    // `apps/web/src/lib/auth/session-cookie-size.test.ts`.
    //
    // What remains worth pinning here is orchestrator ruling R2's OTHER half: the derivation
    // must never cap or truncate — a hidden workspace is a workspace the user cannot reach.
    const memberships: MembershipCompanyInput[] = Array.from({ length: 15 }, (_, i) =>
      membership({
        companyId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        name: `Northwind Industrial ${i}`,
        role: 'member',
      })
    );
    const result = deriveNonNull(
      {
        hasApprovedExpertProfile: true,
        memberships,
        eligibleCompanyIds: memberships.map((m) => m.companyId),
        representedCompanies: [],
      },
      stored()
    );
    // 15 companies + the expert workspace — every one of them, in full.
    expect(result.workspaces).toHaveLength(16);
    expect(companyWorkspaces(result.workspaces).map((w) => w.name)).toEqual(
      memberships.map((m) => m.name)
    );
  });
});

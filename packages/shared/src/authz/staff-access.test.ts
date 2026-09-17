import { describe, it, expect } from 'vitest';
import type { PlatformRole } from '../parties';
import {
  PLATFORM_CAPABILITIES,
  resolvePlatformCapabilities,
  platformActorHasCapability,
  type PlatformCapability,
} from './platform';
import {
  PLATFORM_ROLE_LABELS,
  STAFF_ACCESS_AUDIT_ACTIONS,
  accountKeepsStaffManagementFloor,
  accountMayGainAccess,
  accountMayManageStaff,
  applyStaffAccessDraft,
  canonicalCustomList,
  customListCanHold,
  evaluateLockedStaffAccessSave,
  precheckStaffAccessSave,
  sameCustomList,
  staffCustomListAllowed,
  staffManagementFloorHolds,
  storedCustomListOf,
  userRowIsLive,
  validateStaffAccessDraft,
  type StaffAccessAccount,
  type StaffAccessLockedRows,
  type StaffAccessPrecheckPassed,
  type StaffAccessSaveRequest,
} from './staff-access';

/**
 * BAL-561 — the staff-access RULE MODULE. Pure, so nothing is mocked.
 *
 * ⚠ Every predicate assertion over a collection is paired with a LENGTH (or count) assertion, so an
 * emptied fixture cannot make an `every`/`toEqual` pass for the wrong reason (memory
 * `feedback_mutation_proof_is_per_assertion_not_per_suite`).
 */

const CAP = PLATFORM_CAPABILITIES;

/** Written as literals on purpose: these are the CHECK's own spellings, not values read back. */
const ALL_ROLES: readonly PlatformRole[] = ['user', 'admin', 'super_admin'];

const FULL_AXIS: readonly PlatformCapability[] = Object.values(PLATFORM_CAPABILITIES);

function account(
  id: string,
  role: PlatformRole,
  customList: readonly PlatformCapability[] | null = null,
  isLive = true,
  emailVerified = true
): StaffAccessAccount {
  return { id, role, customList, isLive, emailVerified };
}

describe('PLATFORM_ROLE_LABELS / STAFF_ACCESS_AUDIT_ACTIONS', () => {
  it('names every platform role in plain words', () => {
    expect(PLATFORM_ROLE_LABELS).toEqual({
      user: 'No staff access',
      admin: 'Admin',
      super_admin: 'Super admin',
    });
    expect(Object.keys(PLATFORM_ROLE_LABELS)).toHaveLength(ALL_ROLES.length);
  });

  it('pins the two audit action wire strings (they are persisted in audit_events.action)', () => {
    expect(STAFF_ACCESS_AUDIT_ACTIONS).toEqual({
      ROLE_CHANGED: 'user.platform_role_changed',
      CUSTOM_LIST_SET: 'user.platform_capabilities_set',
    });
    expect(Object.keys(STAFF_ACCESS_AUDIT_ACTIONS)).toHaveLength(2);
  });
});

describe('userRowIsLive', () => {
  it('is true only for an active, undeleted row', () => {
    expect(userRowIsLive({ status: 'active', deletedAt: null })).toBe(true);
    expect(userRowIsLive({ status: 'suspended', deletedAt: null })).toBe(false);
    expect(userRowIsLive({ status: 'inactive', deletedAt: null })).toBe(false);
    expect(userRowIsLive({ status: 'active', deletedAt: new Date() })).toBe(false);
  });
});

describe('canonicalCustomList', () => {
  it('drops unknown tokens and non-strings, de-duplicates, and orders by declaration order', () => {
    const result = canonicalCustomList([
      CAP.VIEW_PLATFORM_ADMIN,
      'retired_token',
      CAP.MANAGE_PLATFORM_FEES,
      CAP.VIEW_PLATFORM_ADMIN,
      42,
      null,
      { token: CAP.REDRIVE_JOB },
    ]);
    expect(result).toEqual([CAP.MANAGE_PLATFORM_FEES, CAP.VIEW_PLATFORM_ADMIN]);
    expect(result).toHaveLength(2);
  });

  it('returns [] for [] — holding nothing survives normalisation', () => {
    expect(canonicalCustomList([])).toEqual([]);
  });

  it('restores the full axis to declaration order from any order', () => {
    const result = canonicalCustomList([...FULL_AXIS].reverse());
    expect(result).toEqual([...FULL_AXIS]);
    expect(result).toHaveLength(19);
  });
});

describe('storedCustomListOf', () => {
  it('is null for a non-staff role even when an array is stored', () => {
    expect(storedCustomListOf('user', [CAP.VIEW_PLATFORM_ADMIN])).toBeNull();
    expect(storedCustomListOf('owner', [])).toBeNull();
  });

  it('is null for any non-array stored value on a staff role (follows the role)', () => {
    const nonArrays: readonly unknown[] = [null, undefined, 'null', 42, { a: 1 }];
    expect(nonArrays).toHaveLength(5);
    for (const stored of nonArrays) {
      expect(storedCustomListOf('admin', stored)).toBeNull();
      expect(storedCustomListOf('super_admin', stored)).toBeNull();
    }
  });

  it('keeps [] as [] and normalises a messy array on a staff role', () => {
    expect(storedCustomListOf('admin', [])).toEqual([]);
    const messy = storedCustomListOf('admin', [
      'view_platform_admin',
      'view_platform_admin',
      'retired_x',
    ]);
    expect(messy).toEqual([CAP.VIEW_PLATFORM_ADMIN]);
    expect(messy).toHaveLength(1);
  });

  it('EQUIVALENCE: resolves to exactly the SET the raw stored value resolves to, for every role × shape', () => {
    // As SETS, not arrays: the resolver keeps a raw duplicate (`[a, a]` resolves to `[a, a]`),
    // and de-duplication is exactly what normalisation adds. What must not change is membership.
    const asSortedSet = (tokens: readonly PlatformCapability[]): PlatformCapability[] =>
      [...new Set(tokens)].sort((a, b) => a.localeCompare(b));
    const storedShapes: readonly unknown[] = [
      null,
      undefined,
      'null',
      42,
      { a: 1 },
      [],
      [CAP.VIEW_PLATFORM_ADMIN, CAP.VIEW_PLATFORM_ADMIN],
      [CAP.MANAGE_PLATFORM_FEES, 'retired_token', CAP.VIEW_PLATFORM_ADMIN],
      [...FULL_AXIS].reverse(),
    ];
    let compared = 0;
    for (const role of ALL_ROLES) {
      for (const stored of storedShapes) {
        const raw = asSortedSet(resolvePlatformCapabilities(role, stored));
        const normalised = asSortedSet(
          resolvePlatformCapabilities(role, storedCustomListOf(role, stored))
        );
        expect(normalised, `${role} × ${JSON.stringify(stored)}`).toEqual(raw);
        expect(normalised).toHaveLength(raw.length);
        compared += 1;
      }
    }
    expect(compared).toBe(ALL_ROLES.length * storedShapes.length);
  });
});

describe('sameCustomList', () => {
  it('null equals only null, and [] is not null', () => {
    expect(sameCustomList(null, null)).toBe(true);
    expect(sameCustomList(null, [])).toBe(false);
    expect(sameCustomList([], null)).toBe(false);
    expect(sameCustomList([], [])).toBe(true);
  });

  it('compares lists as SETS — order-insensitive, membership-sensitive', () => {
    expect(
      sameCustomList(
        [CAP.MANAGE_PLATFORM_FEES, CAP.VIEW_PLATFORM_ADMIN],
        [CAP.VIEW_PLATFORM_ADMIN, CAP.MANAGE_PLATFORM_FEES]
      )
    ).toBe(true);
    expect(sameCustomList([CAP.VIEW_PLATFORM_ADMIN], [CAP.MANAGE_PLATFORM_FEES])).toBe(false);
    expect(
      sameCustomList([CAP.VIEW_PLATFORM_ADMIN], [CAP.VIEW_PLATFORM_ADMIN, CAP.REDRIVE_JOB])
    ).toBe(false);
  });
});

describe('CHECK equivalence — users_platform_capabilities_staff_array, stated in JavaScript', () => {
  it("staffCustomListAllowed(role) === (role <> 'user')", () => {
    const checked = ALL_ROLES.filter((role) => {
      expect(staffCustomListAllowed(role), role).toBe(role !== 'user');
      return true;
    });
    expect(checked).toHaveLength(3);
  });

  it("customListCanHold(role, MANAGE_STAFF_CAPABILITIES) === (role = 'super_admin')", () => {
    const checked = ALL_ROLES.filter((role) => {
      expect(customListCanHold(role, CAP.MANAGE_STAFF_CAPABILITIES), role).toBe(
        role === 'super_admin'
      );
      return true;
    });
    expect(checked).toHaveLength(3);
  });

  it('every OTHER token may sit on any staff custom list', () => {
    const others = FULL_AXIS.filter((token) => token !== CAP.MANAGE_STAFF_CAPABILITIES);
    expect(others).toHaveLength(18);
    for (const role of ['admin', 'super_admin'] as const) {
      expect(others.every((token) => customListCanHold(role, token))).toBe(true);
    }
  });

  it("the axis fits the CHECK's <= 64 length arm, so a canonical list can never trip it", () => {
    expect(FULL_AXIS.length).toBeLessThanOrEqual(64);
  });
});

describe('validateStaffAccessDraft', () => {
  it('passes null (follow the role) for every role, including user', () => {
    for (const role of ALL_ROLES) {
      expect(validateStaffAccessDraft(role, null)).toEqual({ ok: true, customList: null });
    }
  });

  it('refuses any list on the user role — before looking at the tokens', () => {
    expect(validateStaffAccessDraft('user', [])).toEqual({
      ok: false,
      reason: 'custom_list_requires_staff_role',
    });
    expect(validateStaffAccessDraft('user', ['retired_token'])).toEqual({
      ok: false,
      reason: 'custom_list_requires_staff_role',
    });
  });

  it('refuses an unknown token — before the super-admin-only check', () => {
    expect(validateStaffAccessDraft('admin', ['retired_token'])).toEqual({
      ok: false,
      reason: 'unknown_capability',
    });
    expect(
      validateStaffAccessDraft('admin', [CAP.MANAGE_STAFF_CAPABILITIES, 'retired_token'])
    ).toEqual({ ok: false, reason: 'unknown_capability' });
  });

  it('refuses MANAGE_STAFF_CAPABILITIES on an admin list', () => {
    expect(
      validateStaffAccessDraft('admin', [CAP.VIEW_PLATFORM_ADMIN, CAP.MANAGE_STAFF_CAPABILITIES])
    ).toEqual({ ok: false, reason: 'staff_management_requires_super_admin' });
  });

  it('accepts and canonicalises a valid list', () => {
    expect(
      validateStaffAccessDraft('super_admin', [
        CAP.MANAGE_STAFF_CAPABILITIES,
        CAP.VIEW_PLATFORM_ADMIN,
        CAP.MANAGE_STAFF_CAPABILITIES,
      ])
    ).toEqual({ ok: true, customList: [CAP.VIEW_PLATFORM_ADMIN, CAP.MANAGE_STAFF_CAPABILITIES] });
    expect(validateStaffAccessDraft('admin', [])).toEqual({ ok: true, customList: [] });
  });
});

describe('accountMayManageStaff / accountKeepsStaffManagementFloor', () => {
  it('an admin following the bundle may not manage staff and is not a floor holder', () => {
    const admin = account('a', 'admin');
    expect(accountMayManageStaff(admin)).toBe(false);
    expect(accountKeepsStaffManagementFloor(admin)).toBe(false);
  });

  it('a super_admin following the bundle may manage staff and keeps the floor', () => {
    const superAdmin = account('s', 'super_admin');
    expect(accountMayManageStaff(superAdmin)).toBe(true);
    expect(accountKeepsStaffManagementFloor(superAdmin)).toBe(true);
  });

  it('D2 — a super_admin whose list lacks VIEW_PLATFORM_ADMIN may manage staff but is NOT a floor holder', () => {
    const noView = account('x', 'super_admin', [CAP.MANAGE_STAFF_CAPABILITIES]);
    expect(accountMayManageStaff(noView)).toBe(true);
    expect(accountKeepsStaffManagementFloor(noView)).toBe(false);
  });

  it('a super_admin whose list lacks the token can neither manage staff nor keep the floor', () => {
    const noToken = account('y', 'super_admin', [CAP.VIEW_PLATFORM_ADMIN]);
    expect(accountMayManageStaff(noToken)).toBe(false);
    expect(accountKeepsStaffManagementFloor(noToken)).toBe(false);
    const empty = account('z', 'super_admin', []);
    expect(accountMayManageStaff(empty)).toBe(false);
    expect(accountKeepsStaffManagementFloor(empty)).toBe(false);
  });

  it('a suspended (not live) super_admin counts for nothing', () => {
    const suspended = account('s', 'super_admin', null, false);
    expect(accountMayManageStaff(suspended)).toBe(false);
    expect(accountKeepsStaffManagementFloor(suspended)).toBe(false);
  });

  it('documents, not relies on: an admin row carrying the token would resolve it — the CHECK and validateStaffAccessDraft are what make that row unstorable', () => {
    const impossible = account('i', 'admin', [
      CAP.MANAGE_STAFF_CAPABILITIES,
      CAP.VIEW_PLATFORM_ADMIN,
    ]);
    // The resolver is deliberately unclamped (ADR-1035 §A1.2)…
    expect(
      platformActorHasCapability('admin', impossible.customList, CAP.MANAGE_STAFF_CAPABILITIES)
    ).toBe(true);
    expect(accountMayManageStaff(impossible)).toBe(true);
    // …so the refusal lives in the storage rule, which this module restates before any write.
    expect(validateStaffAccessDraft('admin', impossible.customList)).toEqual({
      ok: false,
      reason: 'staff_management_requires_super_admin',
    });
  });

  it('staffManagementFloorHolds is true iff SOME account keeps the floor', () => {
    expect(staffManagementFloorHolds([])).toBe(false);
    const nonHolders = [
      account('a', 'admin'),
      account('x', 'super_admin', [CAP.MANAGE_STAFF_CAPABILITIES]),
      account('s', 'super_admin', null, false),
    ];
    expect(nonHolders).toHaveLength(3);
    expect(staffManagementFloorHolds(nonHolders)).toBe(false);
    expect(staffManagementFloorHolds([...nonHolders, account('h', 'super_admin')])).toBe(true);
  });
});

describe('accountMayGainAccess (F1 / S1 / S2)', () => {
  it('is true only when BOTH live and email-verified', () => {
    expect(accountMayGainAccess(account('a', 'user', null, true, true))).toBe(true);
    expect(accountMayGainAccess(account('a', 'user', null, false, true))).toBe(false);
    expect(accountMayGainAccess(account('a', 'user', null, true, false))).toBe(false);
    expect(accountMayGainAccess(account('a', 'user', null, false, false))).toBe(false);
  });

  it('is independent of role and customList', () => {
    const suspendedSuperAdmin = account('s', 'super_admin', [CAP.MANAGE_STAFF_CAPABILITIES], false);
    expect(accountMayGainAccess(suspendedSuperAdmin)).toBe(false);
  });
});

describe('applyStaffAccessDraft', () => {
  it('replaces the target in place, keeps its liveness, and does not mutate the input', () => {
    const accounts = [account('a', 'super_admin'), account('b', 'admin', null, false)];
    const target = accounts[1];
    if (target === undefined) throw new Error('fixture');

    const next = applyStaffAccessDraft(accounts, target, {
      role: 'super_admin',
      customList: [CAP.VIEW_PLATFORM_ADMIN],
    });

    expect(next).toEqual([
      account('a', 'super_admin'),
      account('b', 'super_admin', [CAP.VIEW_PLATFORM_ADMIN], false),
    ]);
    expect(next).toHaveLength(2);
    expect(accounts[1]).toEqual(account('b', 'admin', null, false));
  });

  it('appends a target that is not in the list (a person being given access)', () => {
    const accounts = [account('a', 'super_admin')];
    const next = applyStaffAccessDraft(accounts, account('n', 'user'), {
      role: 'admin',
      customList: null,
    });
    expect(next).toEqual([account('a', 'super_admin'), account('n', 'admin')]);
    expect(next).toHaveLength(2);
    expect(accounts).toHaveLength(1);
  });
});

const ACTOR = 'actor-id';
const TARGET = 'target-id';

function request(overrides: Partial<StaffAccessSaveRequest> = {}): StaffAccessSaveRequest {
  return {
    actorUserId: ACTOR,
    targetUserId: TARGET,
    expected: { role: 'admin', customList: null },
    next: { role: 'super_admin', customList: null },
    ...overrides,
  };
}

function passed(req: StaffAccessSaveRequest): StaffAccessPrecheckPassed {
  const pre = precheckStaffAccessSave(req);
  if (!pre.ok) throw new Error(`precheck refused the fixture: ${pre.reason}`);
  return pre;
}

function locked(
  accounts: readonly StaffAccessAccount[],
  targetIsDeleted = false
): StaffAccessLockedRows {
  return { accounts, targetIsDeleted };
}

describe('precheckStaffAccessSave', () => {
  it('D3 — refuses EVERY save on the actor’s own record, even a valid one', () => {
    expect(precheckStaffAccessSave(request({ targetUserId: ACTOR }))).toEqual({
      ok: false,
      reason: 'self_edit',
    });
  });

  it('D3 — self_edit is decided before the draft is validated', () => {
    expect(
      precheckStaffAccessSave(
        request({ targetUserId: ACTOR, next: { role: 'user', customList: ['retired_token'] } })
      )
    ).toEqual({ ok: false, reason: 'self_edit' });
  });

  it('passes each draft refusal through', () => {
    const cases = [
      {
        next: { role: 'user' as const, customList: [] },
        reason: 'custom_list_requires_staff_role',
      },
      { next: { role: 'admin' as const, customList: ['retired'] }, reason: 'unknown_capability' },
      {
        next: { role: 'admin' as const, customList: [CAP.MANAGE_STAFF_CAPABILITIES] },
        reason: 'staff_management_requires_super_admin',
      },
    ];
    expect(cases).toHaveLength(3);
    for (const { next, reason } of cases) {
      expect(precheckStaffAccessSave(request({ next }))).toEqual({ ok: false, reason });
    }
  });

  it('normalises both the next list and the reviewed (expected) list', () => {
    expect(
      precheckStaffAccessSave(
        request({
          expected: {
            role: 'admin',
            customList: [CAP.VIEW_PLATFORM_ADMIN, 'retired_token', CAP.MANAGE_PLATFORM_FEES],
          },
          next: {
            role: 'admin',
            customList: [CAP.VIEW_PLATFORM_ADMIN, CAP.VIEW_PLATFORM_ADMIN],
          },
        })
      )
    ).toEqual({
      ok: true,
      nextCustomList: [CAP.VIEW_PLATFORM_ADMIN],
      expectedCustomList: [CAP.MANAGE_PLATFORM_FEES, CAP.VIEW_PLATFORM_ADMIN],
    });
    expect(precheckStaffAccessSave(request())).toEqual({
      ok: true,
      nextCustomList: null,
      expectedCustomList: null,
    });
  });
});

describe('evaluateLockedStaffAccessSave — refusals, in contract order', () => {
  const holder = account(ACTOR, 'super_admin');
  const target = account(TARGET, 'admin');

  it('actor_not_authorized: the actor is not among the locked rows', () => {
    const req = request();
    expect(evaluateLockedStaffAccessSave(req, passed(req), locked([target]))).toEqual({
      ok: false,
      reason: 'actor_not_authorized',
    });
  });

  it('actor_not_authorized: admin, suspended super_admin, or a list without the token', () => {
    const req = request();
    const actors = [
      account(ACTOR, 'admin'),
      account(ACTOR, 'super_admin', null, false),
      account(ACTOR, 'super_admin', [CAP.VIEW_PLATFORM_ADMIN]),
    ];
    expect(actors).toHaveLength(3);
    for (const actor of actors) {
      expect(
        evaluateLockedStaffAccessSave(
          req,
          passed(req),
          locked([actor, account('h', 'super_admin'), target])
        )
      ).toEqual({ ok: false, reason: 'actor_not_authorized' });
    }
  });

  it('actor_not_authorized is decided before target_not_found', () => {
    const req = request();
    expect(evaluateLockedStaffAccessSave(req, passed(req), locked([], true))).toEqual({
      ok: false,
      reason: 'actor_not_authorized',
    });
  });

  it('target_not_found: absent, or present but soft-deleted', () => {
    const req = request();
    expect(evaluateLockedStaffAccessSave(req, passed(req), locked([holder]))).toEqual({
      ok: false,
      reason: 'target_not_found',
    });
    expect(
      evaluateLockedStaffAccessSave(
        req,
        passed(req),
        locked([holder, account(TARGET, 'admin', null, false)], true)
      )
    ).toEqual({ ok: false, reason: 'target_not_found' });
  });

  it('D6 stale: the reviewed role differs from the locked row', () => {
    const req = request({ expected: { role: 'user', customList: null } });
    expect(evaluateLockedStaffAccessSave(req, passed(req), locked([holder, target]))).toEqual({
      ok: false,
      reason: 'stale',
    });
  });

  it('D6 stale: the reviewed list differs — including null vs [] in both directions', () => {
    const cases: readonly {
      readonly reviewed: readonly string[] | null;
      readonly stored: readonly PlatformCapability[] | null;
    }[] = [
      { reviewed: null, stored: [] },
      { reviewed: [], stored: null },
      { reviewed: [CAP.VIEW_PLATFORM_ADMIN], stored: [CAP.MANAGE_PLATFORM_FEES] },
    ];
    expect(cases).toHaveLength(3);
    for (const { reviewed, stored } of cases) {
      const req = request({
        expected: { role: 'admin', customList: reviewed },
        next: { role: 'super_admin', customList: null },
      });
      expect(
        evaluateLockedStaffAccessSave(
          req,
          passed(req),
          locked([holder, account(TARGET, 'admin', stored)])
        )
      ).toEqual({ ok: false, reason: 'stale' });
    }
  });

  it('stale is decided before no_change', () => {
    const req = request({
      expected: { role: 'super_admin', customList: null },
      next: { role: 'super_admin', customList: null },
    });
    expect(evaluateLockedStaffAccessSave(req, passed(req), locked([holder, target]))).toEqual({
      ok: false,
      reason: 'stale',
    });
  });

  it('no_change: the same role and the same list as a set, in a different order', () => {
    const stored = [CAP.MANAGE_PLATFORM_FEES, CAP.VIEW_PLATFORM_ADMIN];
    const req = request({
      expected: { role: 'admin', customList: [CAP.VIEW_PLATFORM_ADMIN, CAP.MANAGE_PLATFORM_FEES] },
      next: { role: 'admin', customList: [CAP.VIEW_PLATFORM_ADMIN, CAP.MANAGE_PLATFORM_FEES] },
    });
    expect(
      evaluateLockedStaffAccessSave(
        req,
        passed(req),
        locked([holder, account(TARGET, 'admin', stored)])
      )
    ).toEqual({ ok: false, reason: 'no_change' });
  });
});

describe('evaluateLockedStaffAccessSave — target_ineligible (F1 / S1 / S2)', () => {
  const holder = account(ACTOR, 'super_admin');

  it('refuses promoting a SUSPENDED user to admin', () => {
    const req = request({
      expected: { role: 'user', customList: null },
      next: { role: 'admin', customList: null },
    });
    const rows = [holder, account(TARGET, 'user', null, false, true)];
    expect(evaluateLockedStaffAccessSave(req, passed(req), locked(rows))).toEqual({
      ok: false,
      reason: 'target_ineligible',
    });
  });

  it('refuses promoting an UNVERIFIED user to admin', () => {
    const req = request({
      expected: { role: 'user', customList: null },
      next: { role: 'admin', customList: null },
    });
    const rows = [holder, account(TARGET, 'user', null, true, false)];
    expect(evaluateLockedStaffAccessSave(req, passed(req), locked(rows))).toEqual({
      ok: false,
      reason: 'target_ineligible',
    });
  });

  it('refuses ADDING a token to a suspended admin’s custom list', () => {
    const req = request({
      expected: { role: 'admin', customList: [CAP.RESOLVE_ADMIN_ALERTS] },
      next: {
        role: 'admin',
        customList: [CAP.RESOLVE_ADMIN_ALERTS, CAP.MANAGE_PROMO_CODES],
      },
    });
    const rows = [holder, account(TARGET, 'admin', [CAP.RESOLVE_ADMIN_ALERTS], false, true)];
    expect(evaluateLockedStaffAccessSave(req, passed(req), locked(rows))).toEqual({
      ok: false,
      reason: 'target_ineligible',
    });
  });

  it('allows REMOVING a token from a suspended admin’s custom list — a pure reduction', () => {
    const req = request({
      expected: { role: 'admin', customList: [CAP.RESOLVE_ADMIN_ALERTS, CAP.MANAGE_PROMO_CODES] },
      next: { role: 'admin', customList: [CAP.RESOLVE_ADMIN_ALERTS] },
    });
    const rows = [
      holder,
      account(TARGET, 'admin', [CAP.RESOLVE_ADMIN_ALERTS, CAP.MANAGE_PROMO_CODES], false, true),
    ];
    expect(evaluateLockedStaffAccessSave(req, passed(req), locked(rows))).toMatchObject({
      ok: true,
    });
  });

  it('allows DEMOTING a suspended super_admin — another live holder keeps the floor', () => {
    const req = request({
      expected: { role: 'super_admin', customList: null },
      next: { role: 'admin', customList: null },
    });
    const rows = [
      account(ACTOR, 'super_admin', [CAP.MANAGE_STAFF_CAPABILITIES]),
      account(TARGET, 'super_admin', null, false, true),
      account('second', 'super_admin'),
    ];
    expect(evaluateLockedStaffAccessSave(req, passed(req), locked(rows))).toMatchObject({
      ok: true,
    });
  });

  it('a STALE request on an ineligible target still reports stale — checked first', () => {
    const req = request({
      expected: { role: 'user', customList: null }, // reviewed BEFORE the row actually changed
      next: { role: 'admin', customList: null },
    });
    const rows = [holder, account(TARGET, 'admin', null, false, false)]; // already admin, not user
    expect(evaluateLockedStaffAccessSave(req, passed(req), locked(rows))).toEqual({
      ok: false,
      reason: 'stale',
    });
  });
});

describe('evaluateLockedStaffAccessSave — the D2 floor, on the POST-save state', () => {
  /** An authorised actor who is NOT a floor holder — isolates the floor from the actor re-check. */
  const nonHolderActor = account(ACTOR, 'super_admin', [CAP.MANAGE_STAFF_CAPABILITIES]);
  const soleHolder = account(TARGET, 'super_admin');

  it('refuses demoting the sole holder', () => {
    const req = request({
      expected: { role: 'super_admin', customList: null },
      next: { role: 'admin', customList: null },
    });
    const rows = [nonHolderActor, soleHolder];
    expect(rows.filter(accountKeepsStaffManagementFloor)).toHaveLength(1);
    expect(evaluateLockedStaffAccessSave(req, passed(req), locked(rows))).toEqual({
      ok: false,
      reason: 'floor_violation',
    });
  });

  it('refuses demoting the sole holder all the way to user too', () => {
    const req = request({
      expected: { role: 'super_admin', customList: null },
      next: { role: 'user', customList: null },
    });
    expect(
      evaluateLockedStaffAccessSave(req, passed(req), locked([nonHolderActor, soleHolder]))
    ).toEqual({ ok: false, reason: 'floor_violation' });
  });

  it('refuses removing MANAGE_STAFF_CAPABILITIES — or VIEW_PLATFORM_ADMIN (D2) — from the sole holder’s list', () => {
    const both = [CAP.VIEW_PLATFORM_ADMIN, CAP.MANAGE_STAFF_CAPABILITIES];
    const listHolder = account(TARGET, 'super_admin', both);
    const drafts: readonly PlatformCapability[][] = [
      [CAP.VIEW_PLATFORM_ADMIN],
      [CAP.MANAGE_STAFF_CAPABILITIES],
    ];
    expect(drafts).toHaveLength(2);
    for (const customList of drafts) {
      const req = request({
        expected: { role: 'super_admin', customList: both },
        next: { role: 'super_admin', customList },
      });
      expect(
        evaluateLockedStaffAccessSave(req, passed(req), locked([nonHolderActor, listHolder]))
      ).toEqual({ ok: false, reason: 'floor_violation' });
    }
  });

  it('a SUSPENDED second holder does not rescue the floor', () => {
    const req = request({
      expected: { role: 'super_admin', customList: null },
      next: { role: 'admin', customList: null },
    });
    const rows = [nonHolderActor, soleHolder, account('suspended', 'super_admin', null, false)];
    expect(evaluateLockedStaffAccessSave(req, passed(req), locked(rows))).toEqual({
      ok: false,
      reason: 'floor_violation',
    });
  });

  it('a LIVE second holder lets the demotion save', () => {
    const req = request({
      expected: { role: 'super_admin', customList: null },
      next: { role: 'admin', customList: null },
    });
    const rows = [nonHolderActor, soleHolder, account('second', 'super_admin')];
    expect(evaluateLockedStaffAccessSave(req, passed(req), locked(rows))).toMatchObject({
      ok: true,
    });
  });

  it('counts the POST-save state: promoting the only future holder saves even with none today', () => {
    const req = request({
      expected: { role: 'user', customList: null },
      next: { role: 'super_admin', customList: null },
    });
    const rows = [nonHolderActor, account(TARGET, 'user')];
    expect(rows.filter(accountKeepsStaffManagementFloor)).toHaveLength(0);
    expect(evaluateLockedStaffAccessSave(req, passed(req), locked(rows))).toMatchObject({
      ok: true,
    });
  });
});

describe('evaluateLockedStaffAccessSave — ok verdicts', () => {
  const holder = account(ACTOR, 'super_admin');

  it('role only: before/after and the change flags', () => {
    const req = request({
      expected: { role: 'user', customList: null },
      next: { role: 'admin', customList: null },
    });
    expect(
      evaluateLockedStaffAccessSave(req, passed(req), locked([holder, account(TARGET, 'user')]))
    ).toEqual({
      ok: true,
      before: { role: 'user', customList: null },
      after: { role: 'admin', customList: null },
      roleChanged: true,
      customListChanged: false,
    });
  });

  it('list only: stores the CANONICAL list', () => {
    const req = request({
      expected: { role: 'admin', customList: null },
      next: {
        role: 'admin',
        customList: [CAP.VIEW_PLATFORM_ADMIN, CAP.MANAGE_PLATFORM_FEES, CAP.VIEW_PLATFORM_ADMIN],
      },
    });
    expect(
      evaluateLockedStaffAccessSave(req, passed(req), locked([holder, account(TARGET, 'admin')]))
    ).toEqual({
      ok: true,
      before: { role: 'admin', customList: null },
      after: { role: 'admin', customList: [CAP.MANAGE_PLATFORM_FEES, CAP.VIEW_PLATFORM_ADMIN] },
      roleChanged: false,
      customListChanged: true,
    });
  });

  it('both: a super_admin on a custom list reset to follow a new role (ruling 1)', () => {
    const stored = [CAP.VIEW_PLATFORM_ADMIN, CAP.MANAGE_STAFF_CAPABILITIES];
    const req = request({
      expected: { role: 'super_admin', customList: stored },
      next: { role: 'admin', customList: null },
    });
    expect(
      evaluateLockedStaffAccessSave(
        req,
        passed(req),
        locked([holder, account(TARGET, 'super_admin', stored)])
      )
    ).toEqual({
      ok: true,
      before: { role: 'super_admin', customList: stored },
      after: { role: 'admin', customList: null },
      roleChanged: true,
      customListChanged: true,
    });
  });
});

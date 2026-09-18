import { describe, expect, it } from 'vitest';
import { PLATFORM_CAPABILITIES, type StaffAccessPerson } from '@balo/shared/authz';
import {
  accessDiff,
  capabilityLockOf,
  draftCustomListOf,
  initialStaffAccessForm,
  isStaffAccessFormDirty,
  reduceStaffAccessForm,
  resolvedAccessOf,
  roleOptionFloorBlocked,
  saveBlockOf,
  type StaffAccessFormState,
} from './staff-access-form';

function person(overrides: Partial<StaffAccessPerson> = {}): StaffAccessPerson {
  return {
    id: 'u1',
    firstName: 'Dana',
    lastName: 'Whitfield',
    email: 'dana@example.com',
    role: 'admin',
    customList: null,
    isLive: true,
    emailVerified: true,
    ...overrides,
  };
}

describe('initialStaffAccessForm', () => {
  it('follow mode for a null stored customList, resolved from the role bundle', () => {
    const p = person({ role: 'admin', customList: null });
    const state = initialStaffAccessForm(p);
    expect(state.role).toBe('admin');
    expect(state.mode).toBe('follow');
    expect(state.customList).toContain(PLATFORM_CAPABILITIES.RESOLVE_ADMIN_ALERTS);
    expect(state.customList).not.toContain(PLATFORM_CAPABILITIES.MANAGE_STAFF_CAPABILITIES);
  });

  it('custom mode for a non-null stored customList', () => {
    const p = person({
      role: 'admin',
      customList: [PLATFORM_CAPABILITIES.RESOLVE_ADMIN_ALERTS],
    });
    const state = initialStaffAccessForm(p);
    expect(state.mode).toBe('custom');
    expect(state.customList).toEqual([PLATFORM_CAPABILITIES.RESOLVE_ADMIN_ALERTS]);
  });

  it('an empty custom list is a real, distinct state — holds nothing', () => {
    const p = person({ role: 'admin', customList: [] });
    const state = initialStaffAccessForm(p);
    expect(state.mode).toBe('custom');
    expect(state.customList).toEqual([]);
  });
});

describe('reduceStaffAccessForm — select_role (ruling 1)', () => {
  it('a no-op selection of the current role returns the same state reference', () => {
    const state = initialStaffAccessForm(person({ role: 'admin', customList: null }));
    const next = reduceStaffAccessForm(state, { type: 'select_role', role: 'admin' });
    expect(next).toBe(state);
  });

  it('a role change ALWAYS resets to follow-role, discarding any custom list', () => {
    const state: StaffAccessFormState = {
      role: 'admin',
      mode: 'custom',
      customList: [PLATFORM_CAPABILITIES.RESOLVE_ADMIN_ALERTS],
    };
    const next = reduceStaffAccessForm(state, { type: 'select_role', role: 'super_admin' });
    expect(next.role).toBe('super_admin');
    expect(next.mode).toBe('follow');
  });

  it('the following use_custom pre-fills from the NEW role bundle, not the old one', () => {
    const afterRoleChange = reduceStaffAccessForm(
      { role: 'admin', mode: 'custom', customList: [PLATFORM_CAPABILITIES.RESOLVE_ADMIN_ALERTS] },
      { type: 'select_role', role: 'super_admin' }
    );
    const afterCustom = reduceStaffAccessForm(afterRoleChange, { type: 'use_custom' });
    expect(afterCustom.mode).toBe('custom');
    // super_admin's bundle includes tokens admin's does not.
    expect(afterCustom.customList).toContain(PLATFORM_CAPABILITIES.IMPERSONATE_USER);
    expect(afterCustom.customList).toContain(PLATFORM_CAPABILITIES.MANAGE_STAFF_CAPABILITIES);
  });
});

describe('reduceStaffAccessForm — use_custom (D9)', () => {
  it('does nothing for role "user" — Custom is unavailable', () => {
    const state: StaffAccessFormState = { role: 'user', mode: 'follow', customList: [] };
    const next = reduceStaffAccessForm(state, { type: 'use_custom' });
    expect(next).toBe(state);
  });

  it('switches to custom and pre-fills from the role bundle for admin', () => {
    const state: StaffAccessFormState = {
      role: 'admin',
      mode: 'follow',
      customList: [],
    };
    const next = reduceStaffAccessForm(state, { type: 'use_custom' });
    expect(next.mode).toBe('custom');
    expect(next.customList).toContain(PLATFORM_CAPABILITIES.RESOLVE_ADMIN_ALERTS);
  });

  it('F2 (R1): use_custom while ALREADY in custom mode is a no-op — it must not re-fill and wipe the draft', () => {
    const edited: StaffAccessFormState = {
      role: 'admin',
      mode: 'custom',
      customList: [PLATFORM_CAPABILITIES.MANAGE_PROMO_CODES],
    };
    const next = reduceStaffAccessForm(edited, { type: 'use_custom' });
    expect(next).toBe(edited);
    expect(next.customList).toEqual([PLATFORM_CAPABILITIES.MANAGE_PROMO_CODES]);
  });
});

describe('reduceStaffAccessForm — follow_role', () => {
  it('switches mode back to follow without touching role', () => {
    const state: StaffAccessFormState = {
      role: 'admin',
      mode: 'custom',
      customList: [PLATFORM_CAPABILITIES.RESOLVE_ADMIN_ALERTS],
    };
    const next = reduceStaffAccessForm(state, { type: 'follow_role' });
    expect(next.mode).toBe('follow');
    expect(next.role).toBe('admin');
  });
});

describe('reduceStaffAccessForm — toggle', () => {
  it('does nothing outside custom mode', () => {
    const state: StaffAccessFormState = { role: 'admin', mode: 'follow', customList: [] };
    const next = reduceStaffAccessForm(state, {
      type: 'toggle',
      capability: PLATFORM_CAPABILITIES.RESOLVE_ADMIN_ALERTS,
    });
    expect(next).toBe(state);
  });

  it('does nothing for MANAGE_STAFF_CAPABILITIES on an admin — the role cannot hold it', () => {
    const state: StaffAccessFormState = {
      role: 'admin',
      mode: 'custom',
      customList: [PLATFORM_CAPABILITIES.RESOLVE_ADMIN_ALERTS],
    };
    const next = reduceStaffAccessForm(state, {
      type: 'toggle',
      capability: PLATFORM_CAPABILITIES.MANAGE_STAFF_CAPABILITIES,
    });
    expect(next).toBe(state);
  });

  it('adds an unheld token and removes a held one, keeping canonical order', () => {
    const state: StaffAccessFormState = { role: 'admin', mode: 'custom', customList: [] };
    const added = reduceStaffAccessForm(state, {
      type: 'toggle',
      capability: PLATFORM_CAPABILITIES.RESOLVE_ADMIN_ALERTS,
    });
    expect(added.customList).toEqual([PLATFORM_CAPABILITIES.RESOLVE_ADMIN_ALERTS]);

    const removed = reduceStaffAccessForm(added, {
      type: 'toggle',
      capability: PLATFORM_CAPABILITIES.RESOLVE_ADMIN_ALERTS,
    });
    expect(removed.customList).toEqual([]);
  });
});

describe('reduceStaffAccessForm — reset', () => {
  it('rebuilds the initial state from the given person, discarding the draft', () => {
    const p = person({ role: 'admin', customList: null });
    const dirty: StaffAccessFormState = {
      role: 'super_admin',
      mode: 'custom',
      customList: [PLATFORM_CAPABILITIES.IMPERSONATE_USER],
    };
    const next = reduceStaffAccessForm(dirty, { type: 'reset', person: p });
    expect(next).toEqual(initialStaffAccessForm(p));
  });
});

describe('draftCustomListOf', () => {
  it('is null in follow mode regardless of the customList field', () => {
    const state: StaffAccessFormState = {
      role: 'admin',
      mode: 'follow',
      customList: [PLATFORM_CAPABILITIES.RESOLVE_ADMIN_ALERTS],
    };
    expect(draftCustomListOf(state)).toBeNull();
  });

  it('is the canonical custom list in custom mode', () => {
    const state: StaffAccessFormState = {
      role: 'admin',
      mode: 'custom',
      customList: [PLATFORM_CAPABILITIES.RESOLVE_ADMIN_ALERTS],
    };
    expect(draftCustomListOf(state)).toEqual([PLATFORM_CAPABILITIES.RESOLVE_ADMIN_ALERTS]);
  });
});

describe('isStaffAccessFormDirty', () => {
  it('is false for the untouched initial state', () => {
    const p = person({ role: 'admin', customList: null });
    expect(isStaffAccessFormDirty(p, initialStaffAccessForm(p))).toBe(false);
  });

  it('is true after a role change', () => {
    const p = person({ role: 'admin', customList: null });
    const state = reduceStaffAccessForm(initialStaffAccessForm(p), {
      type: 'select_role',
      role: 'super_admin',
    });
    expect(isStaffAccessFormDirty(p, state)).toBe(true);
  });

  it('switching an IDENTICAL set from follow to custom is still dirty', () => {
    const p = person({ role: 'admin', customList: null });
    const state = reduceStaffAccessForm(initialStaffAccessForm(p), { type: 'use_custom' });
    // The resolved set is byte-identical to the role bundle, but `null` (follow) !== an array
    // (custom) — "following the role" and "a custom list that happens to match it" are different
    // stored states, and the confirm dialog must show that distinction.
    expect(isStaffAccessFormDirty(p, state)).toBe(true);
  });
});

describe('resolvedAccessOf', () => {
  it('resolves the role bundle when customList is null', () => {
    const resolved = resolvedAccessOf('admin', null);
    expect(resolved.has(PLATFORM_CAPABILITIES.RESOLVE_ADMIN_ALERTS)).toBe(true);
    expect(resolved.has(PLATFORM_CAPABILITIES.MANAGE_STAFF_CAPABILITIES)).toBe(false);
  });

  it('resolves the override verbatim when customList is an array', () => {
    const resolved = resolvedAccessOf('admin', [PLATFORM_CAPABILITIES.MANAGE_PROMO_CODES]);
    expect([...resolved]).toEqual([PLATFORM_CAPABILITIES.MANAGE_PROMO_CODES]);
  });
});

describe('accessDiff', () => {
  it('orders added and removed by the display order, not insertion order', () => {
    const before = new Set([PLATFORM_CAPABILITIES.MANAGE_PROMO_CODES]);
    const after = new Set([
      PLATFORM_CAPABILITIES.RESOLVE_ADMIN_ALERTS,
      PLATFORM_CAPABILITIES.CLOSE_ANY_REQUEST,
    ]);
    const diff = accessDiff(before, after);
    // CLOSE_ANY_REQUEST (project_requests) precedes RESOLVE_ADMIN_ALERTS (queues) in display order.
    expect(diff.added).toEqual([
      PLATFORM_CAPABILITIES.CLOSE_ANY_REQUEST,
      PLATFORM_CAPABILITIES.RESOLVE_ADMIN_ALERTS,
    ]);
    expect(diff.removed).toEqual([PLATFORM_CAPABILITIES.MANAGE_PROMO_CODES]);
  });

  it('is empty for two identical sets', () => {
    const set = new Set([PLATFORM_CAPABILITIES.RESOLVE_ADMIN_ALERTS]);
    expect(accessDiff(set, set)).toEqual({ added: [], removed: [] });
  });
});

describe('roleOptionFloorBlocked', () => {
  it('blocks demoting the SOLE floor holder', () => {
    const sole = person({ id: 'u1', role: 'super_admin', customList: null, isLive: true });
    expect(roleOptionFloorBlocked([sole], sole, 'admin')).toBe(true);
    expect(roleOptionFloorBlocked([sole], sole, 'super_admin')).toBe(false);
  });

  it('a SUSPENDED second super_admin does not save the floor', () => {
    const sole = person({ id: 'u1', role: 'super_admin', customList: null, isLive: true });
    const suspended = person({ id: 'u2', role: 'super_admin', customList: null, isLive: false });
    expect(roleOptionFloorBlocked([sole, suspended], sole, 'admin')).toBe(true);
  });

  it('a second LIVE floor holder means demoting the first is not blocked', () => {
    const first = person({ id: 'u1', role: 'super_admin', customList: null, isLive: true });
    const second = person({ id: 'u2', role: 'super_admin', customList: null, isLive: true });
    expect(roleOptionFloorBlocked([first, second], first, 'admin')).toBe(false);
  });
});

describe('capabilityLockOf', () => {
  it('is null outside custom mode', () => {
    const p = person({ role: 'super_admin', customList: null });
    const state: StaffAccessFormState = { role: 'super_admin', mode: 'follow', customList: [] };
    expect(
      capabilityLockOf([p], p, state, PLATFORM_CAPABILITIES.MANAGE_STAFF_CAPABILITIES, false)
    ).toBe(null);
  });

  it('is "super_admin_only" for a token an admin role cannot hold, regardless of membership', () => {
    const p = person({ role: 'admin', customList: [] });
    const state: StaffAccessFormState = { role: 'admin', mode: 'custom', customList: [] };
    expect(
      capabilityLockOf([p], p, state, PLATFORM_CAPABILITIES.MANAGE_STAFF_CAPABILITIES, false)
    ).toBe('super_admin_only');
  });

  it('is "floor" for the sole holder\'s own manage_staff_capabilities row', () => {
    const p = person({
      id: 'u1',
      role: 'super_admin',
      customList: [
        PLATFORM_CAPABILITIES.MANAGE_STAFF_CAPABILITIES,
        PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN,
      ],
      isLive: true,
    });
    const state: StaffAccessFormState = {
      role: 'super_admin',
      mode: 'custom',
      customList: [
        PLATFORM_CAPABILITIES.MANAGE_STAFF_CAPABILITIES,
        PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN,
      ],
    };
    expect(
      capabilityLockOf([p], p, state, PLATFORM_CAPABILITIES.MANAGE_STAFF_CAPABILITIES, false)
    ).toBe('floor');
  });

  it('is null when a second holder keeps the floor', () => {
    const p = person({
      id: 'u1',
      role: 'super_admin',
      customList: [
        PLATFORM_CAPABILITIES.MANAGE_STAFF_CAPABILITIES,
        PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN,
      ],
      isLive: true,
    });
    const other = person({ id: 'u2', role: 'super_admin', customList: null, isLive: true });
    const state: StaffAccessFormState = {
      role: 'super_admin',
      mode: 'custom',
      customList: [
        PLATFORM_CAPABILITIES.MANAGE_STAFF_CAPABILITIES,
        PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN,
      ],
    };
    expect(
      capabilityLockOf([p, other], p, state, PLATFORM_CAPABILITIES.MANAGE_STAFF_CAPABILITIES, false)
    ).toBe(null);
  });

  it('is null for a token not currently held', () => {
    const p = person({ role: 'super_admin', customList: [] });
    const state: StaffAccessFormState = { role: 'super_admin', mode: 'custom', customList: [] };
    expect(capabilityLockOf([p], p, state, PLATFORM_CAPABILITIES.RESOLVE_ADMIN_ALERTS, false)).toBe(
      null
    );
  });

  it("F9 (U2): is null for the VIEWER'S OWN record, even one that would otherwise be a floor lock", () => {
    const self = person({
      id: 'u1',
      role: 'super_admin',
      customList: [
        PLATFORM_CAPABILITIES.MANAGE_STAFF_CAPABILITIES,
        PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN,
      ],
      isLive: true,
    });
    const state: StaffAccessFormState = {
      role: 'super_admin',
      mode: 'custom',
      customList: [
        PLATFORM_CAPABILITIES.MANAGE_STAFF_CAPABILITIES,
        PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN,
      ],
    };
    // Without `isSelf`, this exact fixture is the "floor" case above.
    expect(
      capabilityLockOf([self], self, state, PLATFORM_CAPABILITIES.MANAGE_STAFF_CAPABILITIES, true)
    ).toBe(null);
  });
});

describe('saveBlockOf', () => {
  it('is "self" when the target is the viewer', () => {
    const p = person({ id: 'u1', role: 'admin', customList: null });
    const state = initialStaffAccessForm(p);
    expect(saveBlockOf([p], p, state, 'u1')).toBe('self');
  });

  it('is "not_dirty" for an untouched draft', () => {
    const p = person({ id: 'u1', role: 'admin', customList: null });
    const state = initialStaffAccessForm(p);
    expect(saveBlockOf([p], p, state, 'viewer')).toBe('not_dirty');
  });

  it('is "floor" when the draft would leave nobody holding it', () => {
    const p = person({ id: 'u1', role: 'super_admin', customList: null, isLive: true });
    const state = reduceStaffAccessForm(initialStaffAccessForm(p), {
      type: 'select_role',
      role: 'admin',
    });
    expect(saveBlockOf([p], p, state, 'viewer')).toBe('floor');
  });

  it('is null (allowed) when a dirty draft still leaves someone holding the floor', () => {
    const p = person({ id: 'u1', role: 'super_admin', customList: null, isLive: true });
    const other = person({ id: 'u2', role: 'super_admin', customList: null, isLive: true });
    const state = reduceStaffAccessForm(initialStaffAccessForm(p), {
      type: 'select_role',
      role: 'admin',
    });
    expect(saveBlockOf([p, other], p, state, 'viewer')).toBe(null);
  });

  it('F1 (S1/S2): is "ineligible" for a SUSPENDED person whose draft GAINS a capability', () => {
    const p = person({
      id: 'u1',
      role: 'user',
      customList: null,
      isLive: false,
      emailVerified: true,
    });
    const state = reduceStaffAccessForm(initialStaffAccessForm(p), {
      type: 'select_role',
      role: 'admin',
    });
    expect(saveBlockOf([p], p, state, 'viewer')).toBe('ineligible');
  });

  it('F1 (S1/S2): is "ineligible" for an UNVERIFIED person whose draft GAINS a capability', () => {
    const p = person({
      id: 'u1',
      role: 'user',
      customList: null,
      isLive: true,
      emailVerified: false,
    });
    const state = reduceStaffAccessForm(initialStaffAccessForm(p), {
      type: 'select_role',
      role: 'admin',
    });
    expect(saveBlockOf([p], p, state, 'viewer')).toBe('ineligible');
  });

  it('F1: a PURE REDUCTION on an ineligible (suspended) person is never "ineligible"', () => {
    const p = person({
      id: 'u1',
      role: 'super_admin',
      customList: null,
      isLive: false,
      emailVerified: true,
    });
    const state = reduceStaffAccessForm(initialStaffAccessForm(p), {
      type: 'select_role',
      role: 'admin',
    });
    // Demoting an already-suspended super_admin is a reduction — floor is the only rule left to
    // clear, and this fixture has no other holder, so it must be "floor", never "ineligible".
    expect(saveBlockOf([p], p, state, 'viewer')).toBe('floor');
  });

  it('F1: order — "ineligible" is decided AFTER "self" and "not_dirty"', () => {
    const self = person({ id: 'u1', role: 'user', customList: null, isLive: false });
    const untouched = initialStaffAccessForm(self);
    expect(saveBlockOf([self], self, untouched, 'u1')).toBe('self');

    const other = person({ id: 'u2', role: 'user', customList: null, isLive: false });
    expect(saveBlockOf([other], other, initialStaffAccessForm(other), 'viewer')).toBe('not_dirty');
  });

  describe('C4 — grant_exceeds_actor', () => {
    it('is "grant_exceeds_actor" when the viewer cannot grant everything the draft adds', () => {
      const viewer = person({
        id: 'viewer',
        role: 'super_admin',
        customList: [PLATFORM_CAPABILITIES.MANAGE_STAFF_CAPABILITIES],
      });
      const target = person({ id: 'u1', role: 'user', customList: null });
      const state = reduceStaffAccessForm(initialStaffAccessForm(target), {
        type: 'select_role',
        role: 'super_admin',
      });
      expect(saveBlockOf([viewer, target], target, state, 'viewer')).toBe('grant_exceeds_actor');
    });

    it('is null (allowed) when the viewer holds the FULL bundle being granted', () => {
      const viewer = person({ id: 'viewer', role: 'super_admin', customList: null });
      const target = person({ id: 'u1', role: 'user', customList: null });
      const state = reduceStaffAccessForm(initialStaffAccessForm(target), {
        type: 'select_role',
        role: 'super_admin',
      });
      // The target becomes the floor holder post-save (super_admin, following the role).
      expect(saveBlockOf([viewer, target], target, state, 'viewer')).toBe(null);
    });

    it('a reduction by a restricted viewer is never "grant_exceeds_actor" — removals are unaffected', () => {
      const viewer = person({
        id: 'viewer',
        role: 'super_admin',
        customList: [PLATFORM_CAPABILITIES.MANAGE_STAFF_CAPABILITIES],
      });
      const target = person({ id: 'u1', role: 'super_admin', customList: null });
      const other = person({ id: 'u2', role: 'super_admin', customList: null }); // keeps the floor
      const state = reduceStaffAccessForm(initialStaffAccessForm(target), {
        type: 'select_role',
        role: 'admin',
      });
      expect(saveBlockOf([viewer, target, other], target, state, 'viewer')).toBe(null);
    });

    it('order — "grant_exceeds_actor" is decided AFTER "ineligible" and BEFORE "floor"', () => {
      // Ineligible target takes priority even when the grant would also exceed the actor.
      const viewer = person({
        id: 'viewer',
        role: 'super_admin',
        customList: [PLATFORM_CAPABILITIES.MANAGE_STAFF_CAPABILITIES],
      });
      const ineligibleTarget = person({
        id: 'u1',
        role: 'user',
        customList: null,
        isLive: false,
      });
      const ineligibleState = reduceStaffAccessForm(initialStaffAccessForm(ineligibleTarget), {
        type: 'select_role',
        role: 'super_admin',
      });
      expect(
        saveBlockOf([viewer, ineligibleTarget], ineligibleTarget, ineligibleState, 'viewer')
      ).toBe('ineligible');

      // An eligible target whose grant exceeds the actor, and — because the draft's custom list
      // omits both floor tokens — would ALSO fail the floor with nobody else holding it: the
      // ceiling is reported (checked first), never "floor".
      const eligibleTarget = person({ id: 'u2', role: 'user', customList: null });
      const stateAddingImpersonate = reduceStaffAccessForm(initialStaffAccessForm(eligibleTarget), {
        type: 'select_role',
        role: 'admin',
      });
      const draftState: StaffAccessFormState = {
        ...stateAddingImpersonate,
        mode: 'custom',
        customList: [PLATFORM_CAPABILITIES.IMPERSONATE_USER],
      };
      expect(saveBlockOf([viewer, eligibleTarget], eligibleTarget, draftState, 'viewer')).toBe(
        'grant_exceeds_actor'
      );
    });
  });
});

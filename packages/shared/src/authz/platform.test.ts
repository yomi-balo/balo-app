import { describe, it, expect } from 'vitest';
import {
  PLATFORM_CAPABILITIES,
  PLATFORM_ROLE_CAPABILITIES,
  PLATFORM_STAFF_ROLES,
  platformRoleHasCapability,
  platformRoleIsStaff,
} from './platform';

/**
 * Unit tests for the platform-capability axis (BAL-358). Pure map — mocks nothing.
 * Authorization logic is the "ALWAYS test" category: every allow/deny branch is
 * locked here so a role can never silently gain or lose `MANAGE_PLATFORM_FEES`.
 */
describe('platformRoleHasCapability', () => {
  it('grants MANAGE_PLATFORM_FEES to admin', () => {
    expect(platformRoleHasCapability('admin', PLATFORM_CAPABILITIES.MANAGE_PLATFORM_FEES)).toBe(
      true
    );
  });

  it('grants MANAGE_PLATFORM_FEES to super_admin', () => {
    expect(
      platformRoleHasCapability('super_admin', PLATFORM_CAPABILITIES.MANAGE_PLATFORM_FEES)
    ).toBe(true);
  });

  it('denies a plain user', () => {
    expect(platformRoleHasCapability('user', PLATFORM_CAPABILITIES.MANAGE_PLATFORM_FEES)).toBe(
      false
    );
  });

  it('denies an unknown / empty role', () => {
    expect(platformRoleHasCapability('', PLATFORM_CAPABILITIES.MANAGE_PLATFORM_FEES)).toBe(false);
    expect(platformRoleHasCapability('owner', PLATFORM_CAPABILITIES.MANAGE_PLATFORM_FEES)).toBe(
      false
    );
  });
});

/**
 * BAL-410 — the cancel-override token. Same allow/deny table as its siblings: a cancel that
 * bypasses BOTH party axes is Balo-staff-only, and a plain `user` must never hold it.
 */
describe('platformRoleHasCapability — CANCEL_ANY_MEETING', () => {
  it.each(['admin', 'super_admin'])('grants CANCEL_ANY_MEETING to %s', (role) => {
    expect(platformRoleHasCapability(role, PLATFORM_CAPABILITIES.CANCEL_ANY_MEETING)).toBe(true);
  });

  it.each(['user', '', 'owner', 'member', 'expert'])('denies CANCEL_ANY_MEETING to %s', (role) => {
    expect(platformRoleHasCapability(role, PLATFORM_CAPABILITIES.CANCEL_ANY_MEETING)).toBe(false);
  });
});

/**
 * BAL-431 — the request-file all-access token. Same allow/deny table as its siblings: reading
 * every party's confidential request file crosses tenants and is Balo-staff-only.
 */
describe('platformRoleHasCapability — VIEW_ANY_REQUEST_FILE', () => {
  it.each(['admin', 'super_admin'])('grants VIEW_ANY_REQUEST_FILE to %s', (role) => {
    expect(platformRoleHasCapability(role, PLATFORM_CAPABILITIES.VIEW_ANY_REQUEST_FILE)).toBe(true);
  });

  it.each(['user', '', 'owner', 'member', 'expert'])(
    'denies VIEW_ANY_REQUEST_FILE to %s',
    (role) => {
      expect(platformRoleHasCapability(role, PLATFORM_CAPABILITIES.VIEW_ANY_REQUEST_FILE)).toBe(
        false
      );
    }
  );
});

describe('PLATFORM_CAPABILITIES / PLATFORM_ROLE_CAPABILITIES', () => {
  it('maps MANAGE_PLATFORM_FEES to its snake_case token', () => {
    expect(PLATFORM_CAPABILITIES.MANAGE_PLATFORM_FEES).toBe('manage_platform_fees');
  });

  it('maps CANCEL_ANY_MEETING to its snake_case token', () => {
    expect(PLATFORM_CAPABILITIES.CANCEL_ANY_MEETING).toBe('cancel_any_meeting');
  });

  it('maps VIEW_ANY_REQUEST_FILE to its snake_case token', () => {
    expect(PLATFORM_CAPABILITIES.VIEW_ANY_REQUEST_FILE).toBe('view_any_request_file');
  });

  /**
   * ⚠ BAL-541 REWROTE THIS ASSERTION, IT DID NOT DELETE IT. It used to read
   * `expect(admin).toEqual(super_admin)` — the two roles held one shared array. `super_admin` now
   * holds `DELETE_ANY_INTERNAL_NOTE` on top, so the relationship this pins is CONTAINMENT plus an
   * EXACT difference: `admin` ⊆ `super_admin`, and the only thing between them is that one token.
   * Written as a set difference rather than as a length check so a third role-differentiated token
   * fails here loudly and has to be argued for, instead of sliding in.
   *
   * ⚠ BAL-553 WIDENED THE DIFFERENCE, IT DID NOT REWRITE THE SHAPE. `IMPERSONATE_USER` is the
   * exact "a third role-differentiated token fails here loudly and has to be argued for" case
   * this test was written to force — ⟦R3⟧ is the argument. `super_admin` now holds the admin
   * bundle plus BOTH `DELETE_ANY_INTERNAL_NOTE` and `IMPERSONATE_USER`, and nothing else.
   */
  it('gives super_admin the admin bundle plus exactly DELETE_ANY_INTERNAL_NOTE and IMPERSONATE_USER, and omits user', () => {
    const admin = PLATFORM_ROLE_CAPABILITIES.admin ?? [];
    const superAdmin = PLATFORM_ROLE_CAPABILITIES.super_admin ?? [];

    // Containment: every admin token is a super_admin token.
    expect(superAdmin).toEqual(expect.arrayContaining([...admin]));
    // The difference, in both directions, is exactly two tokens.
    expect(superAdmin.filter((c) => !admin.includes(c))).toEqual([
      PLATFORM_CAPABILITIES.DELETE_ANY_INTERNAL_NOTE,
      PLATFORM_CAPABILITIES.IMPERSONATE_USER,
    ]);
    expect(admin.filter((c) => !superAdmin.includes(c))).toEqual([]);
    expect(PLATFORM_ROLE_CAPABILITIES.user).toBeUndefined();
  });

  it('admin does NOT hold DELETE_ANY_INTERNAL_NOTE', () => {
    expect(PLATFORM_ROLE_CAPABILITIES.admin).not.toContain(
      PLATFORM_CAPABILITIES.DELETE_ANY_INTERNAL_NOTE
    );
  });

  it('admin does NOT hold IMPERSONATE_USER', () => {
    expect(PLATFORM_ROLE_CAPABILITIES.admin).not.toContain(PLATFORM_CAPABILITIES.IMPERSONATE_USER);
  });

  /**
   * BAL-541 — the map's keys and the staff-role list are two spellings of "who is Balo staff".
   * A staff role with no bundle would pass `platformRoleIsStaff` while holding nothing; a bundle
   * under a key that is not a staff role would grant tokens to somebody the eligibility check
   * refuses. Pinned so the two can never drift.
   */
  it('has exactly the staff roles as its keys', () => {
    expect(Object.keys(PLATFORM_ROLE_CAPABILITIES).sort()).toEqual(
      [...PLATFORM_STAFF_ROLES].sort()
    );
  });

  it('bundle includes VIEW_ANY_REQUEST_FILE for the staff roles', () => {
    expect(PLATFORM_ROLE_CAPABILITIES.admin).toContain(PLATFORM_CAPABILITIES.VIEW_ANY_REQUEST_FILE);
  });

  it('maps CLOSE_ANY_REQUEST to its snake_case token', () => {
    expect(PLATFORM_CAPABILITIES.CLOSE_ANY_REQUEST).toBe('close_any_request');
  });

  it('bundle includes CLOSE_ANY_REQUEST for the staff roles', () => {
    expect(PLATFORM_ROLE_CAPABILITIES.admin).toContain(PLATFORM_CAPABILITIES.CLOSE_ANY_REQUEST);
  });

  it('maps VIEW_PLATFORM_ADMIN to its snake_case token', () => {
    expect(PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN).toBe('view_platform_admin');
  });

  it('bundle includes VIEW_PLATFORM_ADMIN for the staff roles', () => {
    expect(PLATFORM_ROLE_CAPABILITIES.admin).toContain(PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN);
  });
  it('maps ASSIGN_ANY_REQUEST_OWNER to its snake_case token', () => {
    expect(PLATFORM_CAPABILITIES.ASSIGN_ANY_REQUEST_OWNER).toBe('assign_any_request_owner');
  });

  it('maps MANAGE_INTERNAL_NOTES to its snake_case token', () => {
    expect(PLATFORM_CAPABILITIES.MANAGE_INTERNAL_NOTES).toBe('manage_internal_notes');
  });

  it('maps DELETE_ANY_INTERNAL_NOTE to its snake_case token', () => {
    expect(PLATFORM_CAPABILITIES.DELETE_ANY_INTERNAL_NOTE).toBe('delete_any_internal_note');
  });

  it('bundle includes the two BAL-541 staff tokens for the staff roles', () => {
    expect(PLATFORM_ROLE_CAPABILITIES.admin).toContain(
      PLATFORM_CAPABILITIES.ASSIGN_ANY_REQUEST_OWNER
    );
    expect(PLATFORM_ROLE_CAPABILITIES.admin).toContain(PLATFORM_CAPABILITIES.MANAGE_INTERNAL_NOTES);
  });
});

/**
 * BAL-541 — the request-owner token. Same allow/deny table as its siblings: staffing a request is
 * Balo's own business, so both party axes are bypassed and a plain `user` must never hold it.
 */
describe('platformRoleHasCapability — ASSIGN_ANY_REQUEST_OWNER', () => {
  it.each(['admin', 'super_admin'])('grants ASSIGN_ANY_REQUEST_OWNER to %s', (role) => {
    expect(platformRoleHasCapability(role, PLATFORM_CAPABILITIES.ASSIGN_ANY_REQUEST_OWNER)).toBe(
      true
    );
  });

  it.each(['user', '', 'owner', 'member', 'expert'])(
    'denies ASSIGN_ANY_REQUEST_OWNER to %s',
    (role) => {
      expect(platformRoleHasCapability(role, PLATFORM_CAPABILITIES.ASSIGN_ANY_REQUEST_OWNER)).toBe(
        false
      );
    }
  );
});

/**
 * BAL-541 — the internal-notes token. Gates a READ as well as a write (there is no party-axis
 * reader for staff-only text), so the deny half of this table is the entire confidentiality
 * boundary for note bodies — not a formality.
 */
describe('platformRoleHasCapability — MANAGE_INTERNAL_NOTES', () => {
  it.each(['admin', 'super_admin'])('grants MANAGE_INTERNAL_NOTES to %s', (role) => {
    expect(platformRoleHasCapability(role, PLATFORM_CAPABILITIES.MANAGE_INTERNAL_NOTES)).toBe(true);
  });

  it.each(['user', '', 'owner', 'member', 'expert'])(
    'denies MANAGE_INTERNAL_NOTES to %s',
    (role) => {
      expect(platformRoleHasCapability(role, PLATFORM_CAPABILITIES.MANAGE_INTERNAL_NOTES)).toBe(
        false
      );
    }
  );
});

/**
 * BAL-541 — the axis's FIRST role-differentiated token: `super_admin` only. `admin` sits on the
 * DENY side here and nowhere else, which is the whole point — it is what lets "author or
 * super_admin" be expressed without a `platformRole === 'super_admin'` read in feature code.
 */
describe('platformRoleHasCapability — DELETE_ANY_INTERNAL_NOTE', () => {
  it('grants DELETE_ANY_INTERNAL_NOTE to super_admin', () => {
    expect(
      platformRoleHasCapability('super_admin', PLATFORM_CAPABILITIES.DELETE_ANY_INTERNAL_NOTE)
    ).toBe(true);
  });

  it.each(['admin', 'user', '', 'owner', 'member', 'expert'])(
    'denies DELETE_ANY_INTERNAL_NOTE to %s',
    (role) => {
      expect(platformRoleHasCapability(role, PLATFORM_CAPABILITIES.DELETE_ANY_INTERNAL_NOTE)).toBe(
        false
      );
    }
  );
});

/**
 * BAL-553 ⟦R3⟧ — the impersonation entry-point token. Same shape as `DELETE_ANY_INTERNAL_NOTE`:
 * `super_admin` ONLY, and `admin` sits on the DENY side deliberately — operating as another user
 * is strictly more powerful than every capability in the staff bundle combined.
 */
describe('platformRoleHasCapability — IMPERSONATE_USER', () => {
  it('grants IMPERSONATE_USER to super_admin', () => {
    expect(platformRoleHasCapability('super_admin', PLATFORM_CAPABILITIES.IMPERSONATE_USER)).toBe(
      true
    );
  });

  it.each(['admin', 'user', '', 'owner', 'member', 'expert'])(
    'denies IMPERSONATE_USER to %s',
    (role) => {
      expect(platformRoleHasCapability(role, PLATFORM_CAPABILITIES.IMPERSONATE_USER)).toBe(false);
    }
  );

  it('maps IMPERSONATE_USER to its snake_case token', () => {
    expect(PLATFORM_CAPABILITIES.IMPERSONATE_USER).toBe('impersonate_user');
  });
});

/**
 * BAL-541 — `platformRoleIsStaff` answers a question about a SUBJECT (may this user be named as a
 * request's Balo owner?), not about an actor's rights. Its truth table is locked here because
 * `@balo/db`'s `assignOwner` refuses a candidate on its say-so, in-transaction.
 */
describe('platformRoleIsStaff', () => {
  it.each([...PLATFORM_STAFF_ROLES])('treats %s as staff', (role) => {
    expect(platformRoleIsStaff(role)).toBe(true);
  });

  it.each(['user', '', 'owner', 'member', 'expert', 'ADMIN', 'superadmin'])(
    'treats %s as NOT staff',
    (role) => {
      expect(platformRoleIsStaff(role)).toBe(false);
    }
  );
});

/**
 * BAL-540 — the request-close override token. Same allow/deny table as its siblings: closing
 * somebody else's sourcing process bypasses BOTH party axes and is Balo-staff-only.
 */
describe('platformRoleHasCapability — CLOSE_ANY_REQUEST', () => {
  it.each(['admin', 'super_admin'])('grants CLOSE_ANY_REQUEST to %s', (role) => {
    expect(platformRoleHasCapability(role, PLATFORM_CAPABILITIES.CLOSE_ANY_REQUEST)).toBe(true);
  });

  it.each(['user', '', 'owner', 'member', 'expert'])('denies CLOSE_ANY_REQUEST to %s', (role) => {
    expect(platformRoleHasCapability(role, PLATFORM_CAPABILITIES.CLOSE_ANY_REQUEST)).toBe(false);
  });
});

/**
 * BAL-534 / ADR-1053 Amendment 1 — the "see the Balo admin surfaces at all" token. Same
 * allow/deny table as its siblings.
 */
describe('platformRoleHasCapability — VIEW_PLATFORM_ADMIN', () => {
  it.each(['admin', 'super_admin'])('grants VIEW_PLATFORM_ADMIN to %s', (role) => {
    expect(platformRoleHasCapability(role, PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN)).toBe(true);
  });

  it.each(['user', '', 'owner', 'member', 'expert'])('denies VIEW_PLATFORM_ADMIN to %s', (role) => {
    expect(platformRoleHasCapability(role, PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN)).toBe(false);
  });
});

/**
 * BAL-534 fix round F1/F4 (SEC LOW) — `PLATFORM_ROLE_CAPABILITIES[role]` is a bare index into a
 * plain object literal, which also resolves INHERITED members. A role of `constructor` /
 * `__proto__` / `toString` must still deny every capability rather than returning an inherited
 * function/object and throwing out of `.includes`.
 */
describe('platformRoleHasCapability — prototype-chain role names', () => {
  const pollutingRoles = ['constructor', '__proto__', 'toString'];
  const everyCapability = Object.values(PLATFORM_CAPABILITIES);

  it.each(pollutingRoles)('denies every capability for role %s, without throwing', (role) => {
    for (const capability of everyCapability) {
      expect(() => platformRoleHasCapability(role, capability)).not.toThrow();
      expect(platformRoleHasCapability(role, capability)).toBe(false);
    }
  });
});

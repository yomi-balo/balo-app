import { describe, it, expect } from 'vitest';
import { CAPABILITIES, ROLE_CAPABILITIES, roleHasCapability, rolesWithCapability } from './index';

/**
 * Unit tests for the pure role→capability map (BAL-345 / ADR-1029). This IS the
 * "permission/authorization logic" the testing skill says to ALWAYS unit-test —
 * it is the single point where a role string is interpreted, and the approve
 * gate depends on `member`/`expert` NOT holding `MANAGE_MEMBERS`. Mocks nothing:
 * the module is pure (no `db`, no I/O).
 */

describe('roleHasCapability — MANAGE_MEMBERS (the approve/decline gate)', () => {
  it('grants MANAGE_MEMBERS to owner', () => {
    expect(roleHasCapability('owner', CAPABILITIES.MANAGE_MEMBERS)).toBe(true);
  });

  it('grants MANAGE_MEMBERS to admin', () => {
    expect(roleHasCapability('admin', CAPABILITIES.MANAGE_MEMBERS)).toBe(true);
  });

  // The MANAGE_REQUESTS vs MANAGE_MEMBERS footgun (§3.2): base members hold
  // manage_requests but must NOT hold manage_members. Explicit guard.
  it('DENIES MANAGE_MEMBERS to a company member', () => {
    expect(roleHasCapability('member', CAPABILITIES.MANAGE_MEMBERS)).toBe(false);
  });

  it('DENIES MANAGE_MEMBERS to an agency expert', () => {
    expect(roleHasCapability('expert', CAPABILITIES.MANAGE_MEMBERS)).toBe(false);
  });
});

describe('roleHasCapability — the base member bundle', () => {
  it('grants the member bundle (participate/manage_requests/approve_own_proposals) to member', () => {
    expect(roleHasCapability('member', CAPABILITIES.PARTICIPATE)).toBe(true);
    expect(roleHasCapability('member', CAPABILITIES.MANAGE_REQUESTS)).toBe(true);
    expect(roleHasCapability('member', CAPABILITIES.APPROVE_OWN_PROPOSALS)).toBe(true);
  });

  it('grants the member bundle to agency expert', () => {
    expect(roleHasCapability('expert', CAPABILITIES.PARTICIPATE)).toBe(true);
    expect(roleHasCapability('expert', CAPABILITIES.MANAGE_REQUESTS)).toBe(true);
    expect(roleHasCapability('expert', CAPABILITIES.APPROVE_OWN_PROPOSALS)).toBe(true);
  });

  it('grants the full admin bundle to owner/admin (member bundle + MANAGE_MEMBERS)', () => {
    for (const role of ['owner', 'admin'] as const) {
      expect(roleHasCapability(role, CAPABILITIES.PARTICIPATE)).toBe(true);
      expect(roleHasCapability(role, CAPABILITIES.MANAGE_REQUESTS)).toBe(true);
      expect(roleHasCapability(role, CAPABILITIES.APPROVE_OWN_PROPOSALS)).toBe(true);
      expect(roleHasCapability(role, CAPABILITIES.MANAGE_MEMBERS)).toBe(true);
    }
  });
});

describe('roleHasCapability — unknown role', () => {
  it('grants nothing to an unknown role (fail closed)', () => {
    for (const cap of Object.values(CAPABILITIES)) {
      expect(roleHasCapability('super_admin', cap)).toBe(false);
      expect(roleHasCapability('', cap)).toBe(false);
      expect(roleHasCapability('nonsense', cap)).toBe(false);
    }
  });

  it('has no entry for unknown roles in the map', () => {
    expect(ROLE_CAPABILITIES['nonsense']).toBeUndefined();
  });
});

describe('rolesWithCapability', () => {
  it('returns exactly [owner, admin] for MANAGE_MEMBERS (admin-role fan-out source of truth)', () => {
    expect(rolesWithCapability(CAPABILITIES.MANAGE_MEMBERS)).toEqual(['owner', 'admin']);
  });

  it('returns all four roles for a base-member capability', () => {
    expect(rolesWithCapability(CAPABILITIES.PARTICIPATE)).toEqual([
      'owner',
      'admin',
      'member',
      'expert',
    ]);
  });
});

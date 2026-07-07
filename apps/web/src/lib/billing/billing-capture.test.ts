import { describe, it, expect } from 'vitest';
import { canManageBilling, type CompanyRole } from './billing-capture';

/**
 * BAL-345 — `canManageBilling` now delegates to the pure `@balo/shared/authz` map
 * (roleHasCapability(role, MANAGE_MEMBERS)) instead of an inline `role === 'owner'
 * || role === 'admin'`. This asserts the fold-in preserved the exact owner/admin
 * gate. `@balo/shared/authz` is pure (bundle-safe) so this needs no mocks.
 */
describe('canManageBilling (BAL-345 authz fold-in)', () => {
  it('grants owner and admin (the MANAGE_MEMBERS bundle)', () => {
    expect(canManageBilling('owner')).toBe(true);
    expect(canManageBilling('admin')).toBe(true);
  });

  it('denies a plain member', () => {
    expect(canManageBilling('member')).toBe(false);
  });

  it('matches the previous inline gate for every CompanyRole', () => {
    const roles: CompanyRole[] = ['owner', 'admin', 'member'];
    for (const role of roles) {
      expect(canManageBilling(role)).toBe(role === 'owner' || role === 'admin');
    }
  });
});

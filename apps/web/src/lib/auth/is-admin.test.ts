import { describe, it, expect } from 'vitest';

import type { SessionUser } from './session';
import { ADMIN_ROLES, isPlatformAdmin } from './is-admin';

function buildUser(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: 'user-1',
    email: 'person@balo.expert',
    firstName: 'Sam',
    lastName: 'Sample',
    avatarUrl: null,
    activeMode: 'client',
    onboardingCompleted: true,
    platformRole: 'user',
    companyId: 'company-1',
    companyName: 'Balo',
    companyRole: 'owner',
    ...overrides,
  };
}

describe('isPlatformAdmin', () => {
  it('is true for an admin', () => {
    expect(isPlatformAdmin(buildUser({ platformRole: 'admin' }))).toBe(true);
  });

  it('is true for a super_admin', () => {
    expect(isPlatformAdmin(buildUser({ platformRole: 'super_admin' }))).toBe(true);
  });

  it('is false for a plain user', () => {
    expect(isPlatformAdmin(buildUser({ platformRole: 'user' }))).toBe(false);
  });
});

describe('ADMIN_ROLES', () => {
  it('contains exactly admin and super_admin', () => {
    expect([...ADMIN_ROLES].sort()).toEqual(['admin', 'super_admin']);
  });
});

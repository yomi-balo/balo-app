import { describe, expect, it } from 'vitest';
import { PLATFORM_ROLE_LABELS } from '@balo/shared/authz';
import type { PlatformRole } from '@balo/shared/parties';
import { STAFF_ACCESS_ROLE_COPY, STAFF_ACCESS_ROLE_ORDER } from './staff-access-roles';

describe('STAFF_ACCESS_ROLE_ORDER', () => {
  it('is a permutation of the platform role union', () => {
    const roles: readonly PlatformRole[] = ['user', 'admin', 'super_admin'];
    expect([...STAFF_ACCESS_ROLE_ORDER].sort()).toEqual([...roles].sort());
    expect(STAFF_ACCESS_ROLE_ORDER).toHaveLength(3);
  });

  it('leads with the least-privileged role and ends with the most-privileged', () => {
    expect(STAFF_ACCESS_ROLE_ORDER[0]).toBe('user');
    expect(STAFF_ACCESS_ROLE_ORDER[2]).toBe('super_admin');
  });
});

describe('STAFF_ACCESS_ROLE_COPY', () => {
  it('every title equals PLATFORM_ROLE_LABELS — one wording, not a second copy', () => {
    for (const role of STAFF_ACCESS_ROLE_ORDER) {
      expect(STAFF_ACCESS_ROLE_COPY[role].title).toBe(PLATFORM_ROLE_LABELS[role]);
    }
  });

  it('every description is non-empty', () => {
    for (const role of STAFF_ACCESS_ROLE_ORDER) {
      expect(STAFF_ACCESS_ROLE_COPY[role].description.length).toBeGreaterThan(0);
    }
  });

  it('only super_admin carries the primary tone', () => {
    expect(STAFF_ACCESS_ROLE_COPY.super_admin.tone).toBe('primary');
    expect(STAFF_ACCESS_ROLE_COPY.user.tone).toBe('neutral');
    expect(STAFF_ACCESS_ROLE_COPY.admin.tone).toBe('neutral');
  });
});

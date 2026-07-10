import { describe, it, expect } from 'vitest';
import type { SessionUser } from '@/lib/auth/session';
import { hasPlatformCapability, PLATFORM_CAPABILITIES } from './platform';

/**
 * Unit tests for the platform-capability web seam (BAL-358). `@balo/shared/authz`
 * is REAL (pure map) so the allow/deny logic is exercised end-to-end through the
 * seam. Only `platformRole` is read, so the fixture is a minimal `Pick`.
 */
function user(platformRole: SessionUser['platformRole']): Pick<SessionUser, 'platformRole'> {
  return { platformRole };
}

describe('hasPlatformCapability', () => {
  it('allows an admin to MANAGE_PLATFORM_FEES', () => {
    expect(hasPlatformCapability(user('admin'), PLATFORM_CAPABILITIES.MANAGE_PLATFORM_FEES)).toBe(
      true
    );
  });

  it('allows a super_admin to MANAGE_PLATFORM_FEES', () => {
    expect(
      hasPlatformCapability(user('super_admin'), PLATFORM_CAPABILITIES.MANAGE_PLATFORM_FEES)
    ).toBe(true);
  });

  it('denies a plain user', () => {
    expect(hasPlatformCapability(user('user'), PLATFORM_CAPABILITIES.MANAGE_PLATFORM_FEES)).toBe(
      false
    );
  });
});

import { describe, it, expect } from 'vitest';
import {
  PLATFORM_CAPABILITIES,
  PLATFORM_ROLE_CAPABILITIES,
  platformRoleHasCapability,
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

describe('PLATFORM_CAPABILITIES / PLATFORM_ROLE_CAPABILITIES', () => {
  it('maps MANAGE_PLATFORM_FEES to its snake_case token', () => {
    expect(PLATFORM_CAPABILITIES.MANAGE_PLATFORM_FEES).toBe('manage_platform_fees');
  });

  it('gives admin and super_admin the identical staff bundle, and omits user', () => {
    expect(PLATFORM_ROLE_CAPABILITIES.admin).toEqual(PLATFORM_ROLE_CAPABILITIES.super_admin);
    expect(PLATFORM_ROLE_CAPABILITIES.user).toBeUndefined();
  });
});

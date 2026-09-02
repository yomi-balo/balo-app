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

  it('gives admin and super_admin the identical staff bundle, and omits user', () => {
    expect(PLATFORM_ROLE_CAPABILITIES.admin).toEqual(PLATFORM_ROLE_CAPABILITIES.super_admin);
    expect(PLATFORM_ROLE_CAPABILITIES.user).toBeUndefined();
  });

  it('bundle includes VIEW_ANY_REQUEST_FILE for the staff roles', () => {
    expect(PLATFORM_ROLE_CAPABILITIES.admin).toContain(PLATFORM_CAPABILITIES.VIEW_ANY_REQUEST_FILE);
  });
});

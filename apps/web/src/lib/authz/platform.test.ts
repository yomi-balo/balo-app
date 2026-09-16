import { describe, it, expect } from 'vitest';
import type { SessionUser } from '@/lib/auth/session';
import { hasPlatformCapability, PLATFORM_CAPABILITIES } from './platform';

/**
 * Unit tests for the platform-capability web seam (BAL-358). `@balo/shared/authz`
 * is REAL (pure map) so the allow/deny logic is exercised end-to-end through the
 * seam.
 *
 * ⚠ BAL-560 — the seam now reads TWO session fields, `platformRole` and the RAW per-user
 * override `platformCapabilities` (ADR-1035 §A1.2). The fixture widened with it; the three
 * original role cases are kept verbatim and pass an ABSENT override, which is what every
 * session carries today and what must resolve byte-identically to the role bundle.
 */
function user(
  platformRole: SessionUser['platformRole'],
  platformCapabilities?: SessionUser['platformCapabilities']
): Pick<SessionUser, 'platformRole' | 'platformCapabilities'> {
  if (platformCapabilities === undefined) return { platformRole };
  return { platformRole, platformCapabilities };
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

describe('hasPlatformCapability — the per-user override (BAL-560)', () => {
  it('an ABSENT override inherits the role bundle (every session today)', () => {
    expect(hasPlatformCapability(user('admin'), PLATFORM_CAPABILITIES.MANAGE_PLATFORM_FEES)).toBe(
      true
    );
    expect(hasPlatformCapability(user('admin'), PLATFORM_CAPABILITIES.IMPERSONATE_USER)).toBe(
      false
    );
  });

  it('an EMPTY override denies everything the role would otherwise grant', () => {
    expect(
      hasPlatformCapability(user('super_admin', []), PLATFORM_CAPABILITIES.MANAGE_PLATFORM_FEES)
    ).toBe(false);
    expect(
      hasPlatformCapability(user('super_admin', []), PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN)
    ).toBe(false);
  });

  it('a SUBSET override grants exactly what it names and nothing else', () => {
    const viewer = user('admin', [PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN]);
    expect(hasPlatformCapability(viewer, PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN)).toBe(true);
    // The fee-blind staff viewer BAL-551 wants: reaches /admin, cannot manage fees.
    expect(hasPlatformCapability(viewer, PLATFORM_CAPABILITIES.MANAGE_PLATFORM_FEES)).toBe(false);
  });

  it('an override WIDENS as well as narrows — it replaces the bundle, never intersects it', () => {
    const viewer = user('admin', [PLATFORM_CAPABILITIES.IMPERSONATE_USER]);
    expect(hasPlatformCapability(viewer, PLATFORM_CAPABILITIES.IMPERSONATE_USER)).toBe(true);
    expect(hasPlatformCapability(viewer, PLATFORM_CAPABILITIES.MANAGE_PLATFORM_FEES)).toBe(false);
  });

  it('an UNKNOWN token in the override denies and the rest resolve — it does not throw', () => {
    const viewer = user('admin', [
      'a_token_that_no_longer_exists',
      PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN,
    ] as SessionUser['platformCapabilities']);
    expect(() =>
      hasPlatformCapability(viewer, PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN)
    ).not.toThrow();
    expect(hasPlatformCapability(viewer, PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN)).toBe(true);
    expect(hasPlatformCapability(viewer, PLATFORM_CAPABILITIES.MANAGE_PLATFORM_FEES)).toBe(false);
  });

  it('a NON-STAFF role ignores an override entirely (D1 defence in depth)', () => {
    const viewer = user('user', [PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN]);
    expect(hasPlatformCapability(viewer, PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN)).toBe(false);
  });
});

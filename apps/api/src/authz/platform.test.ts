import { describe, it, expect } from 'vitest';
import { PLATFORM_CAPABILITIES, type PlatformCapability } from '@balo/shared/authz';
import { userHasPlatformCapability, type PlatformCapabilityActor } from './platform.js';

/**
 * BAL-560 — the `apps/api` platform-capability seam. Mirror of
 * `apps/web/src/lib/authz/platform.test.ts` over the api side, whose actor comes from a LIVE
 * `usersRepository.findById` row rather than from the sealed session (D6 — a deliberate,
 * permanent asymmetry over ONE shared pure core).
 */
function actor(
  platformRole: string,
  platformCapabilities: PlatformCapability[] | null = null
): PlatformCapabilityActor {
  return { platformRole, platformCapabilities };
}

/**
 * A MALFORMED actor, constructed through an explicit cast.
 *
 * ⚠ THE CAST IS THE POINT, NOT A SHORTCUT. Since fix round 1 (security F5)
 * `PlatformCapabilityActor.platformCapabilities` is `PlatformCapability[] | null`, so no ordinary
 * caller can pass a non-array — that narrowing is what stops a caller satisfying the "required"
 * field with `undefined` and silently resolving a fee-blind admin as a full admin on the money
 * gate. But the value ORIGINATES in a jsonb column, and `$type<PlatformCapability[]>()` is a
 * compile-time claim Postgres does not enforce, so the runtime must still be robust to a value
 * the type says is impossible. This helper reaches past the type to prove that it is.
 */
function malformedActor(platformRole: string, stored: unknown): PlatformCapabilityActor {
  return { platformRole, platformCapabilities: stored } as PlatformCapabilityActor;
}

describe('userHasPlatformCapability — role only (platformCapabilities: null)', () => {
  it('grants a staff-bundle token to admin', () => {
    expect(
      userHasPlatformCapability(actor('admin'), PLATFORM_CAPABILITIES.MANAGE_PLATFORM_FEES)
    ).toBe(true);
  });

  it('grants a super_admin-only token to super_admin', () => {
    expect(userHasPlatformCapability(actor('super_admin'), PLATFORM_CAPABILITIES.REDRIVE_JOB)).toBe(
      true
    );
  });

  it('denies a super_admin-only token to admin', () => {
    expect(userHasPlatformCapability(actor('admin'), PLATFORM_CAPABILITIES.REDRIVE_JOB)).toBe(
      false
    );
  });

  it('denies everything to a plain user', () => {
    expect(
      userHasPlatformCapability(actor('user'), PLATFORM_CAPABILITIES.MANAGE_PLATFORM_FEES)
    ).toBe(false);
    expect(
      userHasPlatformCapability(actor('user'), PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN)
    ).toBe(false);
  });
});

describe('userHasPlatformCapability — the per-user override (BAL-560)', () => {
  it('an override that OMITS a token the role holds DENIES it', () => {
    expect(
      userHasPlatformCapability(
        actor('admin', [PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN]),
        PLATFORM_CAPABILITIES.MANAGE_PLATFORM_FEES
      )
    ).toBe(false);
  });

  it('an override that NAMES a token the role LACKS GRANTS it (widening is expressible)', () => {
    expect(
      userHasPlatformCapability(
        actor('admin', [PLATFORM_CAPABILITIES.REDRIVE_JOB]),
        PLATFORM_CAPABILITIES.REDRIVE_JOB
      )
    ).toBe(true);
  });

  it('an EMPTY override denies everything — "holds nothing" is a real state, not "inherit"', () => {
    expect(
      userHasPlatformCapability(
        actor('super_admin', []),
        PLATFORM_CAPABILITIES.MANAGE_PLATFORM_FEES
      )
    ).toBe(false);
  });

  it('an UNKNOWN token denies and the rest resolve — it does not throw', () => {
    // A retired token is, by construction, no longer a `PlatformCapability` — so it can only
    // reach the seam past the type, exactly as a stale jsonb row would.
    const fixture = malformedActor('admin', [
      'a_token_that_no_longer_exists',
      PLATFORM_CAPABILITIES.MANAGE_PLATFORM_FEES,
    ]);
    expect(() =>
      userHasPlatformCapability(fixture, PLATFORM_CAPABILITIES.MANAGE_PLATFORM_FEES)
    ).not.toThrow();
    expect(userHasPlatformCapability(fixture, PLATFORM_CAPABILITIES.MANAGE_PLATFORM_FEES)).toBe(
      true
    );
    expect(userHasPlatformCapability(fixture, PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN)).toBe(
      false
    );
  });

  it.each([
    ['a non-array string', 'nonsense'],
    ['a number', 42],
    ['an object', {}],
    ['undefined', undefined],
  ])(
    '%s INHERITS the role bundle rather than denying everything (runtime robustness past the type)',
    (_label, stored) => {
      expect(
        userHasPlatformCapability(
          malformedActor('admin', stored),
          PLATFORM_CAPABILITIES.MANAGE_PLATFORM_FEES
        )
      ).toBe(true);
    }
  );

  /**
   * ⚠ FIX ROUND 1, SECURITY F5 — THE TYPE-LEVEL HALF, held by `tsc` rather than by vitest.
   * `platformCapabilities: undefined` used to satisfy `PlatformCapabilityActor` because the field
   * was `unknown`, so a caller could look like it supplied the override while supplying nothing —
   * on the MONEY gate. Widening the field back to `unknown` (or adding `| undefined`) makes
   * `UndefinedIsNotAnActor` resolve to `never`, `true` stops being assignable, and
   * `pnpm --filter api typecheck` fails.
   */
  it('an `undefined` override does NOT satisfy PlatformCapabilityActor — compile-time pin', () => {
    type UndefinedIsNotAnActor = {
      platformRole: string;
      platformCapabilities: undefined;
    } extends PlatformCapabilityActor
      ? never
      : true;
    const pin: UndefinedIsNotAnActor = true;
    expect(pin).toBe(true);
  });

  it('a NON-STAFF role ignores an override entirely (D1 defence in depth)', () => {
    expect(
      userHasPlatformCapability(
        actor('user', [PLATFORM_CAPABILITIES.MANAGE_PLATFORM_FEES]),
        PLATFORM_CAPABILITIES.MANAGE_PLATFORM_FEES
      )
    ).toBe(false);
  });
});

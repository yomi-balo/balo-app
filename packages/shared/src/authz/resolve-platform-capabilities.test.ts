import { describe, it, expect } from 'vitest';
import {
  PLATFORM_CAPABILITIES,
  PLATFORM_ROLE_CAPABILITIES,
  isPlatformCapability,
  platformActorHasCapability,
  platformRoleHasCapability,
  resolvePlatformCapabilities,
  type PlatformCapability,
} from './platform';

/**
 * BAL-560 / ADR-1035 §A1.2 — the per-user platform-capability OVERRIDE resolution path.
 *
 * ⚠ THIS FILE IS D3's RE-SCOPE OF THE TICKET'S "every real staff account" AC. There is no list,
 * seed, fixture or constant of real staff accounts anywhere in the repo, and a test must never
 * read production rows — so the AC's stated PURPOSE ("a bundle edit that silently changes a live
 * person's access fails CI") is delivered hermetically instead, by two things together:
 *   1. the role × override MATRIX below, asserting the EXACT resolved set per cell; and
 *   2. the EXACT-SET pins on `PLATFORM_ROLE_CAPABILITIES.admin` / `.super_admin`, spelled out
 *      literally, so any edit to the bundle constants fails here by name.
 *
 * ⚠ EXACT SET EQUALITY EVERYWHERE, NEVER `arrayContaining`. An `arrayContaining` assertion on a
 * capability set cannot notice a token being ADDED, which is the direction that grants access.
 * Every non-empty expectation is additionally paired with a length assertion so an accidentally
 * empty expected array cannot make a `toEqual` pass for the wrong reason (memory
 * `feedback_mutation_proof_is_per_assertion_not_per_suite`).
 */

/**
 * ⚠ SPELLED AS RAW WIRE STRINGS, NOT AS `PLATFORM_CAPABILITIES.X` REFERENCES — deliberately, and
 * for two reasons.
 *
 * 1. INDEPENDENCE. `PLATFORM_STAFF_BUNDLE` is module-private (D13) and is not imported here.
 *    Asserting the role map against values read out of the same module would be a TAUTOLOGY;
 *    these literals are what make a bundle edit — or a renamed constant whose VALUE silently
 *    changed — fail CI by name. A `PLATFORM_CAPABILITIES.X` reference would still track a
 *    changed value silently.
 * 2. FIDELITY. These strings are what actually travels: the database stores them (the sealed
 *    cookie carries their `PLATFORM_CAPABILITY_SEAL_ORDER` indexes since BAL-558), and the
 *    read-path filter compares them. Pinning the wire form pins the thing the database and the
 *    browser actually hold.
 */
const ADMIN_BUNDLE: readonly PlatformCapability[] = [
  'manage_platform_fees',
  'manage_promo_codes',
  'cancel_any_meeting',
  'view_any_request_file',
  'close_any_request',
  'view_platform_admin',
  'assign_any_request_owner',
  'manage_internal_notes',
  'resolve_admin_alerts',
  'review_expert_applications',
  'cancel_any_engagement',
  'manage_any_engagement_action_item',
  'fast_forward_request',
  'manage_any_request_sourcing',
  'manage_any_kickoff_gate',
];

/** The four role-differentiated tokens, in the order the role map spreads them. */
const SUPER_ADMIN_BUNDLE: readonly PlatformCapability[] = [
  ...ADMIN_BUNDLE,
  'delete_any_internal_note',
  'impersonate_user',
  'redrive_job',
  'manage_staff_capabilities',
];

/** The whole axis — the largest override expressible (D10: 17 after BAL-560, 19 after BAL-558). */
const FULL_AXIS: readonly PlatformCapability[] = Object.values(PLATFORM_CAPABILITIES);

/** A strict subset — "an admin, minus everything but fees and the admin surface". */
const SUBSET: readonly PlatformCapability[] = [
  PLATFORM_CAPABILITIES.MANAGE_PLATFORM_FEES,
  PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN,
];

/**
 * A stored value carrying a token that is NOT on the axis — a retired token left behind by a
 * narrowing, or a hand edit. It must DENY that token and resolve the rest, never throw.
 */
const WITH_UNKNOWN_TOKEN: readonly unknown[] = [
  'manage_platform_fees',
  'retired_token',
  'view_platform_admin',
];

/** Every role the product can present to the resolver, plus the prototype-chain hazards. */
const EVERY_ROLE: readonly string[] = [
  'admin',
  'super_admin',
  'user',
  '',
  'owner',
  'member',
  'expert',
  'constructor',
  '__proto__',
];

const EVERY_TOKEN: readonly PlatformCapability[] = Object.values(PLATFORM_CAPABILITIES);

/** The NON-staff roles. Every cell of the matrix resolves to `[]` for each of them (D1). */
const NON_STAFF_ROLES: readonly string[] = [
  'user',
  '',
  'owner',
  'member',
  'expert',
  // ⚠ BOTH prototype-chain hazards (fix round 1, review finding 14). `PLATFORM_ROLE_CAPABILITIES`
  // is a plain object literal, so a bare index resolves INHERITED keys: `constructor` returns a
  // function and `__proto__` returns an object, neither of which is `undefined`, so a `?? []`
  // fallback never fires and `.includes` throws `TypeError` instead of denying. `__proto__` is
  // the more interesting of the two and was absent from this sweep.
  'constructor',
  '__proto__',
];

interface MatrixCell {
  readonly label: string;
  readonly stored: unknown;
  readonly admin: readonly PlatformCapability[];
  readonly superAdmin: readonly PlatformCapability[];
}

const MATRIX: readonly MatrixCell[] = [
  {
    label: 'undefined (absent cookie field)',
    stored: undefined,
    admin: ADMIN_BUNDLE,
    superAdmin: SUPER_ADMIN_BUNDLE,
  },
  {
    label: 'null (SQL NULL — every row today)',
    stored: null,
    admin: ADMIN_BUNDLE,
    superAdmin: SUPER_ADMIN_BUNDLE,
  },
  { label: '[] (holds NOTHING — a real state)', stored: [], admin: [], superAdmin: [] },
  { label: 'a strict subset', stored: SUBSET, admin: SUBSET, superAdmin: SUBSET },
  { label: 'the full axis', stored: FULL_AXIS, admin: FULL_AXIS, superAdmin: FULL_AXIS },
  {
    label: 'an array containing an unknown token',
    stored: WITH_UNKNOWN_TOKEN,
    admin: SUBSET,
    superAdmin: SUBSET,
  },
  {
    label: "a non-array string 'x'",
    stored: 'x',
    admin: ADMIN_BUNDLE,
    superAdmin: SUPER_ADMIN_BUNDLE,
  },
  {
    label: 'a non-array object {}',
    stored: {},
    admin: ADMIN_BUNDLE,
    superAdmin: SUPER_ADMIN_BUNDLE,
  },
  {
    label: 'a non-array number 42',
    stored: 42,
    admin: ADMIN_BUNDLE,
    superAdmin: SUPER_ADMIN_BUNDLE,
  },
];

describe('resolvePlatformCapabilities — the D3 role × override matrix', () => {
  it('the matrix fixtures are the sizes claimed (non-vacuity for every cell below)', () => {
    expect(ADMIN_BUNDLE).toHaveLength(15);
    expect(SUPER_ADMIN_BUNDLE).toHaveLength(19);
    expect(FULL_AXIS).toHaveLength(19);
    expect(SUBSET).toHaveLength(2);
    expect(MATRIX).toHaveLength(9);
    expect(NON_STAFF_ROLES).toHaveLength(7);
  });

  it.each(MATRIX)('admin × $label resolves to the exact expected set', ({ stored, admin }) => {
    const resolved = resolvePlatformCapabilities('admin', stored);
    expect(resolved).toEqual([...admin]);
    expect(resolved).toHaveLength(admin.length);
  });

  it.each(MATRIX)(
    'super_admin × $label resolves to the exact expected set',
    ({ stored, superAdmin }) => {
      const resolved = resolvePlatformCapabilities('super_admin', stored);
      expect(resolved).toEqual([...superAdmin]);
      expect(resolved).toHaveLength(superAdmin.length);
    }
  );

  /**
   * D1 DEFENCE IN DEPTH — the `users_platform_capabilities_staff_array` CHECK already forbids a
   * non-staff row from carrying an override; this is the second lock, so a row that predates or
   * evades the constraint still cannot produce a capability-only staff account. Every cell,
   * including the full-axis one, resolves to NOTHING for a non-staff role.
   */
  it.each(NON_STAFF_ROLES)('a non-staff role (%j) IGNORES every override in the matrix', (role) => {
    for (const cell of MATRIX) {
      expect(resolvePlatformCapabilities(role, cell.stored), `${role} × ${cell.label}`).toEqual([]);
    }
    // Non-vacuity: the loop above ran over all nine cells, not zero.
    expect(MATRIX).toHaveLength(9);
  });
});

describe('platformActorHasCapability — a NULL override is byte-identical to today', () => {
  /**
   * THE MIGRATION'S WHOLE SAFETY ARGUMENT, PROVEN RATHER THAN ASSERTED. Every gate converted by
   * this ticket is a provable no-op only while a NULL column resolves exactly as the role bundle
   * does — so the NULL arm is compared against the UNCHANGED shipped `platformRoleHasCapability`
   * across every role × every token, not sampled.
   */
  it('a NULL override resolves byte-identically to platformRoleHasCapability for EVERY role × EVERY token', () => {
    // ⚠ The two length assertions are not decoration. Without them a future refactor that
    // emptied `PLATFORM_CAPABILITIES` would make this loop run zero times and pass.
    expect(EVERY_TOKEN).toHaveLength(19);
    expect(EVERY_ROLE.length * EVERY_TOKEN.length).toBe(171);

    for (const role of EVERY_ROLE) {
      for (const token of EVERY_TOKEN) {
        for (const nullish of [undefined, null]) {
          expect(
            platformActorHasCapability(role, nullish, token),
            `${role} × ${token} × ${String(nullish)}`
          ).toBe(platformRoleHasCapability(role, token));
        }
      }
    }

    // …and the SET form agrees with the map, for the two staff roles.
    expect(resolvePlatformCapabilities('admin', null)).toEqual(PLATFORM_ROLE_CAPABILITIES.admin);
    expect(resolvePlatformCapabilities('super_admin', null)).toEqual(
      PLATFORM_ROLE_CAPABILITIES.super_admin
    );
  });

  it('an override RESOLVES rather than delegating — it replaces the bundle verbatim', () => {
    // A token the role does NOT hold is GRANTED by the override (widening is expressible).
    expect(
      platformActorHasCapability(
        'admin',
        [PLATFORM_CAPABILITIES.IMPERSONATE_USER],
        PLATFORM_CAPABILITIES.IMPERSONATE_USER
      )
    ).toBe(true);
    // …and a token the role DOES hold is denied once the override omits it.
    expect(
      platformActorHasCapability(
        'admin',
        [PLATFORM_CAPABILITIES.IMPERSONATE_USER],
        PLATFORM_CAPABILITIES.MANAGE_PLATFORM_FEES
      )
    ).toBe(false);
  });
});

describe('the read-path allowlist re-filter', () => {
  /**
   * The ticket's AC, and the `representations.ts` rule: a token that is NOT on the axis DENIES
   * and the rest RESOLVE — it never throws. Narrowing the axis later must take effect
   * immediately, rather than waiting for a backfill of every stored row.
   */
  it('filters an unknown token out and resolves the rest, without throwing', () => {
    expect(() => resolvePlatformCapabilities('admin', WITH_UNKNOWN_TOKEN)).not.toThrow();
    const resolved = resolvePlatformCapabilities('admin', WITH_UNKNOWN_TOKEN);
    expect(resolved).toEqual([
      PLATFORM_CAPABILITIES.MANAGE_PLATFORM_FEES,
      PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN,
    ]);
    expect(resolved).toHaveLength(2);
    // Non-vacuity: the input genuinely carried three entries, one of them off-axis.
    expect(WITH_UNKNOWN_TOKEN).toHaveLength(3);
  });

  it('DENIES the unknown token itself rather than throwing on it', () => {
    expect(
      platformActorHasCapability('admin', WITH_UNKNOWN_TOKEN, 'retired_token' as PlatformCapability)
    ).toBe(false);
    expect(
      platformActorHasCapability(
        'admin',
        WITH_UNKNOWN_TOKEN,
        PLATFORM_CAPABILITIES.MANAGE_PLATFORM_FEES
      )
    ).toBe(true);
  });

  it('an array of non-strings resolves to [] without throwing', () => {
    const nonsense: readonly unknown[] = [1, null, {}, [], true];
    expect(() => resolvePlatformCapabilities('super_admin', nonsense)).not.toThrow();
    expect(resolvePlatformCapabilities('super_admin', nonsense)).toEqual([]);
    expect(nonsense).toHaveLength(5);
  });
});

describe('PLATFORM_ROLE_CAPABILITIES — the exact-set pins (D3)', () => {
  /**
   * Spelled out literally so a bundle edit that silently changes a live staff member's access
   * fails CI by name. This is the hermetic delivery of the ticket's "every real staff account"
   * AC — see this file's header.
   */
  it('admin holds exactly the 15-token staff bundle, in order', () => {
    expect(PLATFORM_ROLE_CAPABILITIES.admin).toEqual([...ADMIN_BUNDLE]);
    expect(PLATFORM_ROLE_CAPABILITIES.admin).toHaveLength(15);
  });

  it('super_admin holds exactly those 15 plus the four role-differentiated tokens, in order', () => {
    expect(PLATFORM_ROLE_CAPABILITIES.super_admin).toEqual([...SUPER_ADMIN_BUNDLE]);
    expect(PLATFORM_ROLE_CAPABILITIES.super_admin).toHaveLength(19);
  });

  it('user has no entry at all — a plain user holds nothing', () => {
    expect(PLATFORM_ROLE_CAPABILITIES.user).toBeUndefined();
    expect(resolvePlatformCapabilities('user', null)).toEqual([]);
  });
});

describe('isPlatformCapability', () => {
  it('accepts every token on the axis', () => {
    expect(FULL_AXIS).toHaveLength(19);
    for (const token of FULL_AXIS) {
      expect(isPlatformCapability(token), token).toBe(true);
    }
  });

  it.each([
    ['a retired token', 'retired_token'],
    ['the empty string', ''],
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['an object', {}],
    ['an array of one valid token', ['manage_platform_fees']],
  ])('rejects %s', (_label, value) => {
    expect(isPlatformCapability(value)).toBe(false);
  });
});

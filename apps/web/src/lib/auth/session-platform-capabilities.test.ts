import { describe, it, expect } from 'vitest';
import { PLATFORM_CAPABILITIES } from '@balo/shared/authz';
import type { SessionUser } from './session';
import {
  applyPlatformCapabilitiesToSessionUser,
  platformOverrideKeyOf,
  sealedPlatformCapabilities,
} from './session-platform-capabilities';

/**
 * BAL-560 — the ONE writer/keyer for `SessionUser.platformCapabilities`. Every seal point, the
 * drift comparison and the sync patch route through here, so the encoding these tests pin
 * (absent ⇔ no override) is the encoding the whole app uses.
 */

describe('sealedPlatformCapabilities', () => {
  it('yields the field ABSENT for a NULL column (D4 — an absent field costs zero cookie bytes)', () => {
    const sealed = sealedPlatformCapabilities({ platformCapabilities: null });
    expect(sealed).toEqual({});
    expect(sealed).not.toHaveProperty('platformCapabilities');
  });

  it('yields the field ABSENT when the source carries no such property at all', () => {
    expect(sealedPlatformCapabilities({})).toEqual({});
  });

  it('SEALS an empty array — `[]` means "holds nothing" and is NOT the same as NULL', () => {
    const sealed = sealedPlatformCapabilities({ platformCapabilities: [] });
    expect(sealed).toHaveProperty('platformCapabilities');
    expect(sealed.platformCapabilities).toEqual([]);
  });

  it('seals a populated override verbatim, in order', () => {
    const stored = [
      PLATFORM_CAPABILITIES.MANAGE_PLATFORM_FEES,
      PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN,
    ];
    const sealed = sealedPlatformCapabilities({ platformCapabilities: stored });
    expect(sealed.platformCapabilities).toEqual([
      PLATFORM_CAPABILITIES.MANAGE_PLATFORM_FEES,
      PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN,
    ]);
    expect(sealed.platformCapabilities).toHaveLength(2);
  });

  it.each([
    ['a string', 'nonsense'],
    ['a number', 42],
    ['an object', { manage_platform_fees: true }],
    ['a boolean', true],
  ])('yields the field ABSENT, without throwing, for %s', (_label, value) => {
    expect(() => sealedPlatformCapabilities({ platformCapabilities: value })).not.toThrow();
    expect(sealedPlatformCapabilities({ platformCapabilities: value })).toEqual({});
  });

  /**
   * ⚠ FIX ROUND 1, SECURITY F1 — THE LOCKOUT. Nothing bounded the array before this: the axis has
   * 17 distinct tokens, but a row could carry the same one any number of times, and a measured
   * 26-entry override seals to 4289 bytes — past the 4096-byte browser cliff, where the browser
   * SILENTLY DISCARDS the `Set-Cookie` and the user is locked out with no server-side error.
   */
  it('DE-DUPLICATES — 40 copies of one token seal as exactly one (the lockout fix)', () => {
    const duplicated = Array.from({ length: 40 }, () => PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN);
    expect(duplicated).toHaveLength(40);

    const sealed = sealedPlatformCapabilities({ platformCapabilities: duplicated });

    expect(sealed.platformCapabilities).toEqual([PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN]);
    expect(sealed.platformCapabilities).toHaveLength(1);
  });

  it('FILTERS unknown tokens out of what gets sealed — they confer nothing, so they cost nothing', () => {
    const sealed = sealedPlatformCapabilities({
      platformCapabilities: [
        'a_token_that_no_longer_exists',
        PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN,
        42,
        null,
      ],
    });

    expect(sealed.platformCapabilities).toEqual([PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN]);
    expect(sealed.platformCapabilities).toHaveLength(1);
  });

  it('an array of ONLY unknown tokens seals as [] — "holds nothing", matching what the resolver grants', () => {
    const sealed = sealedPlatformCapabilities({
      platformCapabilities: ['retired_a', 'retired_b'],
    });
    expect(sealed).toHaveProperty('platformCapabilities');
    expect(sealed.platformCapabilities).toEqual([]);
  });

  it('can never seal more entries than the axis holds — the same bound as the DB CHECK', () => {
    const everyTokenTwice = [
      ...Object.values(PLATFORM_CAPABILITIES),
      ...Object.values(PLATFORM_CAPABILITIES),
    ];
    expect(everyTokenTwice).toHaveLength(34);

    const sealed = sealedPlatformCapabilities({ platformCapabilities: everyTokenTwice });

    expect(sealed.platformCapabilities).toHaveLength(17);
  });
});

describe('applyPlatformCapabilitiesToSessionUser', () => {
  it('ASSIGNS a fresh override onto a session user that had none', () => {
    const user: Pick<SessionUser, 'platformCapabilities'> = {};
    applyPlatformCapabilitiesToSessionUser(user, {
      platformCapabilities: [PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN],
    });
    expect(user.platformCapabilities).toEqual([PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN]);
  });

  /**
   * ⚠ THE LOAD-BEARING ARM. A REVOKED override has to LEAVE the cookie; an assign-only patch
   * would let it survive the full seven days on a session that passes every other drift check.
   */
  it('DELETES a revoked override — the column went back to NULL', () => {
    const user: Pick<SessionUser, 'platformCapabilities'> = {
      platformCapabilities: [PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN],
    };
    applyPlatformCapabilitiesToSessionUser(user, { platformCapabilities: null });
    expect(user).not.toHaveProperty('platformCapabilities');
    expect(user.platformCapabilities).toBeUndefined();
  });

  it('replaces an existing override with the fresh one', () => {
    const user: Pick<SessionUser, 'platformCapabilities'> = {
      platformCapabilities: [PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN],
    };
    applyPlatformCapabilitiesToSessionUser(user, {
      platformCapabilities: [PLATFORM_CAPABILITIES.MANAGE_PROMO_CODES],
    });
    expect(user.platformCapabilities).toEqual([PLATFORM_CAPABILITIES.MANAGE_PROMO_CODES]);
  });

  it('patches an EMPTY override on, rather than deleting it ([] is a real state)', () => {
    const user: Pick<SessionUser, 'platformCapabilities'> = {
      platformCapabilities: [PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN],
    };
    applyPlatformCapabilitiesToSessionUser(user, { platformCapabilities: [] });
    expect(user).toHaveProperty('platformCapabilities');
    expect(user.platformCapabilities).toEqual([]);
  });
});

describe('platformOverrideKeyOf', () => {
  it('yields null for an absent field, a SQL NULL and any non-array — ONE state', () => {
    expect(platformOverrideKeyOf({})).toBeNull();
    expect(platformOverrideKeyOf({ platformCapabilities: null })).toBeNull();
    expect(platformOverrideKeyOf({ platformCapabilities: undefined })).toBeNull();
    expect(platformOverrideKeyOf({ platformCapabilities: 'nonsense' })).toBeNull();
    expect(platformOverrideKeyOf({ platformCapabilities: 42 })).toBeNull();
  });

  it('a pre-BAL-560 cookie against a NULL column reports NO drift (null === null)', () => {
    expect(platformOverrideKeyOf({})).toBe(platformOverrideKeyOf({ platformCapabilities: null }));
  });

  it('distinguishes [] from absent — "holds nothing" IS drift against "inherit"', () => {
    expect(platformOverrideKeyOf({ platformCapabilities: [] })).not.toBeNull();
    expect(platformOverrideKeyOf({ platformCapabilities: [] })).toBe('[]');
  });

  it('is ORDER-INSENSITIVE — a pure reorder is not drift', () => {
    const a = platformOverrideKeyOf({
      platformCapabilities: [
        PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN,
        PLATFORM_CAPABILITIES.MANAGE_PLATFORM_FEES,
      ],
    });
    const b = platformOverrideKeyOf({
      platformCapabilities: [
        PLATFORM_CAPABILITIES.MANAGE_PLATFORM_FEES,
        PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN,
      ],
    });
    expect(a).toBe(b);
    // Non-vacuity: the key is a real two-element key, not two nulls compared to each other.
    expect(a).toBe('["manage_platform_fees","view_platform_admin"]');
  });

  it('does NOT mutate the source array while sorting', () => {
    const stored = [
      PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN,
      PLATFORM_CAPABILITIES.MANAGE_PLATFORM_FEES,
    ];
    platformOverrideKeyOf({ platformCapabilities: stored });
    expect(stored).toEqual([
      PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN,
      PLATFORM_CAPABILITIES.MANAGE_PLATFORM_FEES,
    ]);
  });

  it('a different member set IS drift', () => {
    expect(
      platformOverrideKeyOf({
        platformCapabilities: [PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN],
      })
    ).not.toBe(
      platformOverrideKeyOf({
        platformCapabilities: [
          PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN,
          PLATFORM_CAPABILITIES.MANAGE_PLATFORM_FEES,
        ],
      })
    );
  });
});

/**
 * ⚠⚠ FIX ROUND 1, REVIEW FINDING 4 — **THE CONVERGENCE PIN.** This is the test that makes
 * filtering at seal time SAFE rather than a regression.
 *
 * `checkSessionDrift` compares `platformOverrideKeyOf(session.user)` against
 * `platformOverrideKeyOf(dbUser)`. The session side has been NORMALISED by the seal path; the DB
 * side is the RAW jsonb row. If the keyer read the raw value, a row carrying duplicates or an
 * unknown token could never match the session sealed from it — `sync-needed` on every render, an
 * infinite redirect storm traded for the cookie lockout. Both sides go through one normaliser, so
 * they converge on the first render and no redirect is spent.
 */
describe('drift CONVERGENCE between a raw DB row and the session sealed from it', () => {
  const messyRows: readonly {
    readonly label: string;
    readonly row: { platformCapabilities: unknown };
  }[] = [
    {
      label: 'duplicates',
      row: {
        platformCapabilities: [
          PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN,
          PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN,
          PLATFORM_CAPABILITIES.MANAGE_PLATFORM_FEES,
        ],
      },
    },
    {
      label: 'an unknown token',
      row: {
        platformCapabilities: [
          'a_token_that_no_longer_exists',
          PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN,
        ],
      },
    },
    {
      label: 'a different ORDER plus a duplicate',
      row: {
        platformCapabilities: [
          PLATFORM_CAPABILITIES.MANAGE_PLATFORM_FEES,
          PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN,
          PLATFORM_CAPABILITIES.MANAGE_PLATFORM_FEES,
        ],
      },
    },
    { label: 'only unknown tokens', row: { platformCapabilities: ['retired_a', 'retired_b'] } },
    { label: 'non-string entries', row: { platformCapabilities: [1, null, {}] } },
  ];

  it('the messy-row table covers every normalisation hazard (non-vacuity for the loop below)', () => {
    expect(messyRows).toHaveLength(5);
  });

  it.each(messyRows)(
    'a row holding $label produces the SAME key as the session sealed from it — NO drift',
    ({ row }) => {
      const sessionUser = sealedPlatformCapabilities(row);

      // The two sides `checkSessionDrift` actually compares.
      expect(platformOverrideKeyOf(sessionUser)).toBe(platformOverrideKeyOf(row));
      // Non-vacuity: this is a REAL key comparison, not two nulls — the row IS an array, so
      // neither side may be the "no override" sentinel.
      expect(platformOverrideKeyOf(row)).not.toBeNull();
    }
  );

  it('re-sealing an already-sealed session is a FIXPOINT — one round converges, no storm', () => {
    const row = {
      platformCapabilities: [
        PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN,
        PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN,
        'a_token_that_no_longer_exists',
      ],
    };
    const once = sealedPlatformCapabilities(row);
    const twice = sealedPlatformCapabilities(once);

    expect(twice).toEqual(once);
    expect(platformOverrideKeyOf(twice)).toBe(platformOverrideKeyOf(row));
    expect(once.platformCapabilities).toHaveLength(1);
  });
});

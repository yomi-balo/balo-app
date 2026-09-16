import { describe, it, expect } from 'vitest';
import {
  PLATFORM_CAPABILITIES,
  encodeSealedPlatformCapabilities,
  type PlatformCapability,
} from '@balo/shared/authz';
import type { SessionUser } from './session';
import {
  applyPlatformCapabilitiesToSessionUser,
  sealedPlatformOverrideKeyOf,
  sealedPlatformCapabilities,
  storedPlatformOverrideKeyOf,
} from './session-platform-capabilities';

/**
 * BAL-560 / BAL-558 — the ONE writer/keyer PAIR for `SessionUser.platformCapabilities`. Every
 * seal point, the drift comparison and the sync patch route through here, so the encoding these
 * tests pin (absent ⇔ no override; sealed as seal-order INDEXES, never token strings) is the
 * encoding the whole app uses.
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

  it('BAL-558 — seals a populated override as SEAL-ORDER INDEXES, not token strings', () => {
    const stored = [
      PLATFORM_CAPABILITIES.MANAGE_PLATFORM_FEES,
      PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN,
    ];
    const sealed = sealedPlatformCapabilities({ platformCapabilities: stored });
    expect(sealed.platformCapabilities).toEqual([0, 5]);
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
   * ⚠ FIX ROUND 1, SECURITY F1 — THE LOCKOUT. Nothing bounded the array before this: the axis
   * has a small fixed set of distinct tokens, but a row could carry the same one any number of
   * times. `sealedPlatformCapabilities` de-duplicates AND encodes to indexes, which is now the
   * cookie-byte bound (see `session-cookie-size.test.ts` for the measured headroom).
   */
  it('DE-DUPLICATES — 40 copies of one token seal as exactly one index (the lockout fix)', () => {
    const duplicated = Array.from({ length: 40 }, () => PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN);
    expect(duplicated).toHaveLength(40);

    const sealed = sealedPlatformCapabilities({ platformCapabilities: duplicated });

    expect(sealed.platformCapabilities).toEqual([5]);
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

    expect(sealed.platformCapabilities).toEqual([5]);
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
    const AXIS = Object.values(PLATFORM_CAPABILITIES);
    const everyTokenTwice = [...AXIS, ...AXIS];
    expect(everyTokenTwice).toHaveLength(AXIS.length * 2);

    const sealed = sealedPlatformCapabilities({ platformCapabilities: everyTokenTwice });

    expect(sealed.platformCapabilities).toHaveLength(AXIS.length);
    expect(sealed.platformCapabilities).toEqual(encodeSealedPlatformCapabilities(AXIS));
    expect(AXIS.length).toBeGreaterThanOrEqual(19);
  });
});

describe('applyPlatformCapabilitiesToSessionUser', () => {
  it('ASSIGNS a fresh override onto a session user that had none', () => {
    const user: Pick<SessionUser, 'platformCapabilities'> = {};
    applyPlatformCapabilitiesToSessionUser(user, {
      platformCapabilities: [PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN],
    });
    expect(user.platformCapabilities).toEqual([5]);
  });

  /**
   * ⚠ THE LOAD-BEARING ARM. A REVOKED override has to LEAVE the cookie; an assign-only patch
   * would let it survive the full seven days on a session that passes every other drift check.
   */
  it('DELETES a revoked override — the column went back to NULL', () => {
    const user: Pick<SessionUser, 'platformCapabilities'> = {
      platformCapabilities: [5],
    };
    applyPlatformCapabilitiesToSessionUser(user, { platformCapabilities: null });
    expect(user).not.toHaveProperty('platformCapabilities');
    expect(user.platformCapabilities).toBeUndefined();
  });

  it('replaces an existing override with the fresh one', () => {
    const user: Pick<SessionUser, 'platformCapabilities'> = {
      platformCapabilities: [5],
    };
    applyPlatformCapabilitiesToSessionUser(user, {
      platformCapabilities: [PLATFORM_CAPABILITIES.MANAGE_PROMO_CODES],
    });
    expect(user.platformCapabilities).toEqual([1]);
  });

  it('patches an EMPTY override on, rather than deleting it ([] is a real state)', () => {
    const user: Pick<SessionUser, 'platformCapabilities'> = {
      platformCapabilities: [5],
    };
    applyPlatformCapabilitiesToSessionUser(user, { platformCapabilities: [] });
    expect(user).toHaveProperty('platformCapabilities');
    expect(user.platformCapabilities).toEqual([]);
  });

  it('applying the same row twice is idempotent', () => {
    const user: Pick<SessionUser, 'platformCapabilities'> = {};
    const row = { platformCapabilities: [PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN] };
    applyPlatformCapabilitiesToSessionUser(user, row);
    const once = [...(user.platformCapabilities ?? [])];
    applyPlatformCapabilitiesToSessionUser(user, row);
    expect(user.platformCapabilities).toEqual(once);
  });
});

describe('storedPlatformOverrideKeyOf — the RAW DB ROW side (token strings)', () => {
  it('yields null for an absent field, a SQL NULL and any non-array — ONE state', () => {
    expect(storedPlatformOverrideKeyOf({})).toBeNull();
    expect(storedPlatformOverrideKeyOf({ platformCapabilities: null })).toBeNull();
    expect(storedPlatformOverrideKeyOf({ platformCapabilities: undefined })).toBeNull();
    expect(storedPlatformOverrideKeyOf({ platformCapabilities: 'nonsense' })).toBeNull();
    expect(storedPlatformOverrideKeyOf({ platformCapabilities: 42 })).toBeNull();
  });

  it('a pre-BAL-560 row against a NULL column reports NO drift (null === null)', () => {
    expect(storedPlatformOverrideKeyOf({})).toBe(
      storedPlatformOverrideKeyOf({ platformCapabilities: null })
    );
  });

  it('distinguishes [] from absent — "holds nothing" IS drift against "inherit"', () => {
    expect(storedPlatformOverrideKeyOf({ platformCapabilities: [] })).not.toBeNull();
    expect(storedPlatformOverrideKeyOf({ platformCapabilities: [] })).toBe('[]');
  });

  it('is ORDER-INSENSITIVE — a pure reorder is not drift', () => {
    const a = storedPlatformOverrideKeyOf({
      platformCapabilities: [
        PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN,
        PLATFORM_CAPABILITIES.MANAGE_PLATFORM_FEES,
      ],
    });
    const b = storedPlatformOverrideKeyOf({
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
    storedPlatformOverrideKeyOf({ platformCapabilities: stored });
    expect(stored).toEqual([
      PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN,
      PLATFORM_CAPABILITIES.MANAGE_PLATFORM_FEES,
    ]);
  });

  it('a different member set IS drift', () => {
    expect(
      storedPlatformOverrideKeyOf({
        platformCapabilities: [PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN],
      })
    ).not.toBe(
      storedPlatformOverrideKeyOf({
        platformCapabilities: [
          PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN,
          PLATFORM_CAPABILITIES.MANAGE_PLATFORM_FEES,
        ],
      })
    );
  });

  it('a STORED NUMBER is never an index — `[5]` on the row side keys as "holds nothing"', () => {
    expect(storedPlatformOverrideKeyOf({ platformCapabilities: [5] } as never)).toBe('[]');
  });
});

describe('sealedPlatformOverrideKeyOf — the SEALED SESSION side (seal-order indexes)', () => {
  it('absent field ⇒ null', () => {
    expect(sealedPlatformOverrideKeyOf({})).toBeNull();
  });

  it('an empty index array ⇒ the "[]" key', () => {
    expect(sealedPlatformOverrideKeyOf({ platformCapabilities: [] })).toBe('[]');
  });

  it('`[5, 0]` and `[0, 5]` decode and key identically — order-insensitive', () => {
    const a = sealedPlatformOverrideKeyOf({ platformCapabilities: [5, 0] });
    const b = sealedPlatformOverrideKeyOf({ platformCapabilities: [0, 5] });
    expect(a).toBe(b);
    expect(a).toBe('["manage_platform_fees","view_platform_admin"]');
  });

  it('an unknown index `[99]` decodes to nothing — keys as "[]"', () => {
    expect(sealedPlatformOverrideKeyOf({ platformCapabilities: [99] })).toBe('[]');
  });

  it('a LEGACY token-string cookie decodes to nothing — keys as "[]", not the token', () => {
    expect(
      sealedPlatformOverrideKeyOf({
        platformCapabilities: ['view_platform_admin'] as never,
      })
    ).toBe('[]');
  });
});

describe('sealedPlatformOverrideKeyOf vs storedPlatformOverrideKeyOf — a legacy cookie self-repairs', () => {
  it('a legacy string-encoded session against the row it came from reports DRIFT (self-heals in one render)', () => {
    const sealedSide = sealedPlatformOverrideKeyOf({
      platformCapabilities: ['view_platform_admin'] as never,
    });
    const storedSide = storedPlatformOverrideKeyOf({
      platformCapabilities: ['view_platform_admin'],
    });
    expect(sealedSide).not.toBe(storedSide);
  });
});

/**
 * ⚠⚠ FIX ROUND 1, REVIEW FINDING 4 — **THE CONVERGENCE PIN.** This is the test that makes
 * filtering-then-encoding at seal time SAFE rather than a regression.
 *
 * `checkSessionDrift` compares `sealedPlatformOverrideKeyOf(session.user)` against
 * `storedPlatformOverrideKeyOf(dbUser)`. The session side has been sealed (normalised + encoded)
 * by the seal path; the DB side is the RAW jsonb row (strings). If a row carrying duplicates or
 * an unknown token could never match the session sealed from it, drift would fire on every
 * render — an infinite redirect storm traded for the cookie lockout. Both sides route through
 * the SAME source-appropriate normaliser, so they converge on the first render.
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
    'a row holding $label produces the SAME key sealed as it does stored — NO drift',
    ({ row }) => {
      const sessionUser = sealedPlatformCapabilities(row);

      // The two sides `checkSessionDrift` actually compares.
      expect(sealedPlatformOverrideKeyOf(sessionUser)).toBe(storedPlatformOverrideKeyOf(row));
      // Non-vacuity: this is a REAL key comparison, not two nulls — the row IS an array, so
      // neither side may be the "no override" sentinel.
      expect(storedPlatformOverrideKeyOf(row)).not.toBeNull();
    }
  );
});

/**
 * BAL-558 — the seal → decode round trip replaces the old "re-sealing is a fixpoint" test: the
 * new fixpoint claim is about DECODING what was sealed, not about re-feeding a sealed value back
 * into the encoder (a sealed value is `number[]`; `sealedPlatformCapabilities` takes token
 * arrays, so feeding it a sealed payload is now a type error, not a runtime no-op).
 */
describe('seal → decode is exact', () => {
  it('decoding what was sealed from a row equals the row, normalised', () => {
    const row = {
      platformCapabilities: [
        PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN,
        PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN,
        'a_token_that_no_longer_exists',
      ],
    };
    const sealed = sealedPlatformCapabilities(row);
    expect(sealed.platformCapabilities).toEqual([5]);

    const user: Pick<SessionUser, 'platformCapabilities'> = {};
    applyPlatformCapabilitiesToSessionUser(user, row);
    expect(user.platformCapabilities).toEqual(sealed.platformCapabilities);
  });
});

/** Sanity: `encodeSealedPlatformCapabilities` is the function `sealedPlatformCapabilities` delegates to. */
describe('sealedPlatformCapabilities delegates encoding to the shared encoder', () => {
  it('matches encodeSealedPlatformCapabilities for the same normalised input', () => {
    const tokens: readonly PlatformCapability[] = [
      PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN,
      PLATFORM_CAPABILITIES.MANAGE_PLATFORM_FEES,
    ];
    expect(
      sealedPlatformCapabilities({ platformCapabilities: tokens }).platformCapabilities
    ).toEqual(encodeSealedPlatformCapabilities(tokens));
  });
});

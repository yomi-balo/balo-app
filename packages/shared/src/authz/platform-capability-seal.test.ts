import { describe, it, expect } from 'vitest';
import {
  PLATFORM_CAPABILITIES,
  PLATFORM_CAPABILITY_SEAL_ORDER,
  decodeSealedPlatformCapabilities,
  encodeSealedPlatformCapabilities,
} from './platform';

/**
 * BAL-558 — pins the sealed-cookie wire format for `SessionUser.platformCapabilities`: an array
 * of INDEXES into `PLATFORM_CAPABILITY_SEAL_ORDER`, never token strings. This test exists because
 * the order is a WIRE FORMAT (append-only, never reordered) — a reorder or mid-insert silently
 * re-maps every already-sealed cookie to a different set of powers. The frozen-prefix check below
 * (`SEAL_ORDER_AS_SHIPPED`) catches that even if a future edit "helpfully" updates the whole
 * literal to match a reordered array.
 */

/**
 * NEVER EDIT A LINE OF THIS LIST. Appended tokens go in `APPENDED_SINCE_BAL_558`.
 *
 * ⚠⚠ FIX ROUND 1, REV-L1 — LITERAL WIRE STRINGS, NOT `PLATFORM_CAPABILITIES.X` REFERENCES. A
 * `PLATFORM_CAPABILITIES.X` reference tracks the CONSTANT's current value, so renaming the
 * constant OR silently changing its string value would rewrite this "frozen" list for free and
 * the frozen-prefix check below would compare the order against itself — passing regardless of
 * what actually shipped. The literal strings are what a sealed cookie from seven days ago
 * actually decodes against; pinning anything else is not pinning the wire format.
 */
const SEAL_ORDER_AS_SHIPPED: readonly string[] = [
  'manage_platform_fees',
  'manage_promo_codes',
  'cancel_any_meeting',
  'view_any_request_file',
  'close_any_request',
  'view_platform_admin',
  'assign_any_request_owner',
  'manage_internal_notes',
  'delete_any_internal_note',
  'impersonate_user',
  'resolve_admin_alerts',
  'review_expert_applications',
  'redrive_job',
  'cancel_any_engagement',
  'manage_any_engagement_action_item',
  'fast_forward_request',
  'manage_staff_capabilities',
  'manage_any_request_sourcing',
  'manage_any_kickoff_gate',
];

/** Tokens appended to `PLATFORM_CAPABILITY_SEAL_ORDER` after BAL-558 shipped. Empty today. */
const APPENDED_SINCE_BAL_558: readonly string[] = [];

const CAPABILITY_COMPARATOR = (a: string, b: string): number => a.localeCompare(b);

describe('PLATFORM_CAPABILITY_SEAL_ORDER — the frozen wire format', () => {
  it('the shipped prefix is exactly SEAL_ORDER_AS_SHIPPED, never reordered or mid-inserted', () => {
    expect(PLATFORM_CAPABILITY_SEAL_ORDER.slice(0, SEAL_ORDER_AS_SHIPPED.length)).toEqual(
      SEAL_ORDER_AS_SHIPPED
    );
  });

  it('the full order is exactly the shipped prefix plus recorded appends', () => {
    expect(PLATFORM_CAPABILITY_SEAL_ORDER).toEqual([
      ...SEAL_ORDER_AS_SHIPPED,
      ...APPENDED_SINCE_BAL_558,
    ]);
  });

  it('has exactly 19 entries (deliberate literal pin — adding a token is a conscious act)', () => {
    expect(PLATFORM_CAPABILITY_SEAL_ORDER).toHaveLength(19);
  });

  it('is exhaustive and unique over PLATFORM_CAPABILITIES', () => {
    expect(new Set(PLATFORM_CAPABILITY_SEAL_ORDER).size).toBe(
      PLATFORM_CAPABILITY_SEAL_ORDER.length
    );
    expect([...PLATFORM_CAPABILITY_SEAL_ORDER].sort(CAPABILITY_COMPARATOR)).toEqual(
      Object.values(PLATFORM_CAPABILITIES).sort(CAPABILITY_COMPARATOR)
    );
  });

  it('is frozen', () => {
    expect(Object.isFrozen(PLATFORM_CAPABILITY_SEAL_ORDER)).toBe(true);
  });
});

describe('encodeSealedPlatformCapabilities / decodeSealedPlatformCapabilities — round trip', () => {
  it.each(Object.values(PLATFORM_CAPABILITIES))('round-trips %s', (token) => {
    expect(decodeSealedPlatformCapabilities(encodeSealedPlatformCapabilities([token]))).toEqual([
      token,
    ]);
  });

  /**
   * ⚠⚠ FIX ROUND 1, REV-L1 — HARDCODED EXPECTATIONS, NOT RE-DERIVED `indexOf`. The previous
   * version of this test computed its expectation from `PLATFORM_CAPABILITY_SEAL_ORDER.indexOf`
   * — the SAME array under test — so a reorder changes both sides identically and the test can
   * never fail on one. These literal indexes are checked against the actual shipped order above
   * before being written down.
   */
  it('encodes named tokens to their hardcoded seal-order indexes', () => {
    expect(
      encodeSealedPlatformCapabilities(['manage_platform_fees', 'view_platform_admin'])
    ).toEqual([0, 5]);
    expect(encodeSealedPlatformCapabilities(['manage_any_request_sourcing'])).toEqual([17]);
    expect(encodeSealedPlatformCapabilities(['manage_any_kickoff_gate'])).toEqual([18]);
    expect(decodeSealedPlatformCapabilities([17, 18])).toEqual([
      'manage_any_request_sourcing',
      'manage_any_kickoff_gate',
    ]);
  });

  it('decodes the full encoded axis back to 19 tokens', () => {
    const all = Object.values(PLATFORM_CAPABILITIES);
    expect(decodeSealedPlatformCapabilities(encodeSealedPlatformCapabilities(all))).toHaveLength(
      19
    );
  });

  it('the encoder de-duplicates', () => {
    const token = PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN;
    expect(encodeSealedPlatformCapabilities([token, token, token])).toHaveLength(1);
  });
});

describe('decodeSealedPlatformCapabilities — tri-state and fail-closed', () => {
  it.each([undefined, null, 'x', 42, {}])('%s is not an array ⇒ null (inherit)', (value) => {
    expect(decodeSealedPlatformCapabilities(value)).toBeNull();
  });

  it('an empty array decodes to an empty array (holds nothing)', () => {
    expect(decodeSealedPlatformCapabilities([])).toEqual([]);
  });

  it('drops every malformed element and keeps only the valid index', () => {
    const result = decodeSealedPlatformCapabilities([
      0,
      19,
      -1,
      1.5,
      NaN,
      '5',
      'view_platform_admin',
      null,
      {},
      2 ** 31,
    ]);
    expect(result).toEqual([PLATFORM_CAPABILITY_SEAL_ORDER[0]]);
    expect(result).toHaveLength(1);
  });

  it('legacy token strings are DROPPED, not decoded', () => {
    expect(
      decodeSealedPlatformCapabilities(['manage_platform_fees', 'view_platform_admin'])
    ).toEqual([]);
  });

  it('the decoder de-duplicates', () => {
    expect(decodeSealedPlatformCapabilities([5, 5, 5])).toEqual([
      PLATFORM_CAPABILITY_SEAL_ORDER[5],
    ]);
  });
});

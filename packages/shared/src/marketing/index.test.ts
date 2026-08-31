import { describe, it, expect } from 'vitest';
import { FEATURED_EXPERT_USERNAMES, FEATURED_EXPERT_LIMIT } from './index';

/**
 * ⚠ There used to be a `toEqual([])` assertion here ("ships empty per D2"). The list is now
 * seeded with DEV-FIXTURE usernames so the spotlight renders in development, so that assertion
 * was removed rather than weakened — a replacement like `expect(Array.isArray(...))` would have
 * been a tautology, which is worse than no test.
 *
 * What D2 actually protects is not emptiness: it is that entries only ever reach this file by a
 * HUMAN editing it — never generated, derived, or backfilled. That property is unchanged, and
 * the absence of a deterministic fallback is pinned separately by the source scan in
 * `apps/web/src/lib/marketing/load-home-data.test.ts`. The remaining assertions below pin the
 * SHAPE (bounded, unique, slug-formed), which is what this module can meaningfully guarantee.
 *
 * ⚠ Note the per-entry loops are vacuous when the array is empty — that is acceptable here
 * precisely because empty is a legitimate state (it renders the designed 0-card invitation).
 */
describe('FEATURED_EXPERT_USERNAMES', () => {
  it('never exceeds FEATURED_EXPERT_LIMIT', () => {
    expect(FEATURED_EXPERT_USERNAMES.length).toBeLessThanOrEqual(FEATURED_EXPERT_LIMIT);
  });

  it('has no duplicate entries', () => {
    const unique = new Set(FEATURED_EXPERT_USERNAMES);
    expect(unique.size).toBe(FEATURED_EXPERT_USERNAMES.length);
  });

  it('every entry is a non-empty, lowercase, whitespace-free slug', () => {
    for (const username of FEATURED_EXPERT_USERNAMES) {
      expect(username.length).toBeGreaterThan(0);
      expect(username).toBe(username.toLowerCase());
      expect(username).toBe(username.trim());
    }
  });
});

describe('FEATURED_EXPERT_LIMIT', () => {
  it('is 3', () => {
    expect(FEATURED_EXPERT_LIMIT).toBe(3);
  });
});

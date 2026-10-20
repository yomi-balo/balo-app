import { describe, it, expect, beforeEach } from 'vitest';
import { ADMIN_LOOKUP_RECENT_STORAGE_KEY, clearStoredRecentLookups } from './recent-storage';

/**
 * BAL-551 fix round R4 — this module is the ONE definition of the admin-lookup Recent storage
 * key, hoisted out of the route-private `_lib` so `components/layout/use-logout.ts` no longer
 * reaches into it. See that file and `admin/lookup/_lib/use-recent-lookups.ts` for the two
 * consumers.
 */

beforeEach(() => {
  globalThis.localStorage.clear();
});

describe('recent-storage', () => {
  it('exports the shipped key value', () => {
    expect(ADMIN_LOOKUP_RECENT_STORAGE_KEY).toBe('balo:admin-lookup-recent');
  });

  it('clearStoredRecentLookups removes the key', () => {
    globalThis.localStorage.setItem(ADMIN_LOOKUP_RECENT_STORAGE_KEY, JSON.stringify([{ id: 1 }]));

    clearStoredRecentLookups();

    expect(globalThis.localStorage.getItem(ADMIN_LOOKUP_RECENT_STORAGE_KEY)).toBeNull();
  });

  it('is a no-op when nothing is stored', () => {
    expect(() => clearStoredRecentLookups()).not.toThrow();
    expect(globalThis.localStorage.getItem(ADMIN_LOOKUP_RECENT_STORAGE_KEY)).toBeNull();
  });
});

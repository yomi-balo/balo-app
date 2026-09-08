import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { LookupResult } from '@balo/shared/lookup';
import { useRecentLookups } from './use-recent-lookups';

const RECENT_KEY = 'balo:admin-lookup-recent';

function result(
  overrides: Partial<LookupResult> & Pick<LookupResult, 'id' | 'type'>
): LookupResult {
  return { title: 'Title', sub: 'Sub', publicExpertUsername: null, ...overrides };
}

beforeEach(() => {
  globalThis.localStorage.clear();
});

describe('useRecentLookups', () => {
  it('starts empty when nothing is stored', () => {
    const { result: hook } = renderHook(() => useRecentLookups());
    expect(hook.current.recent).toEqual([]);
  });

  it('remember() adds an entry to the front and persists it', () => {
    const { result: hook } = renderHook(() => useRecentLookups());
    act(() => {
      hook.current.remember(result({ id: 'u1', type: 'user', title: 'Dana', sub: 'Owner' }));
    });
    expect(hook.current.recent).toEqual([{ type: 'user', id: 'u1', title: 'Dana', sub: 'Owner' }]);
    const stored = JSON.parse(globalThis.localStorage.getItem(RECENT_KEY) ?? '[]');
    expect(stored).toEqual([{ type: 'user', id: 'u1', title: 'Dana', sub: 'Owner' }]);
  });

  it('moves an existing entry to the front instead of duplicating it', () => {
    const { result: hook } = renderHook(() => useRecentLookups());
    act(() => {
      hook.current.remember(result({ id: 'u1', type: 'user', title: 'Dana' }));
      hook.current.remember(result({ id: 'co1', type: 'company', title: 'Northwind' }));
      hook.current.remember(result({ id: 'u1', type: 'user', title: 'Dana' }));
    });
    expect(hook.current.recent.map((e) => e.id)).toEqual(['u1', 'co1']);
  });

  it('caps at 10 entries', () => {
    const { result: hook } = renderHook(() => useRecentLookups());
    act(() => {
      for (let i = 0; i < 12; i++) {
        hook.current.remember(result({ id: `u${i}`, type: 'user', title: `User ${i}` }));
      }
    });
    expect(hook.current.recent).toHaveLength(10);
    expect(hook.current.recent[0]?.id).toBe('u11');
  });

  it('tolerates corrupt JSON in storage — reads as empty, never throws', () => {
    globalThis.localStorage.setItem(RECENT_KEY, '{not json');
    expect(() => renderHook(() => useRecentLookups())).not.toThrow();
  });

  it('drops a malformed stored entry rather than throwing', () => {
    globalThis.localStorage.setItem(
      RECENT_KEY,
      JSON.stringify([
        { type: 'not_a_real_type', id: 'x' },
        { type: 'user', id: 'u1', title: 'Dana', sub: 'x' },
      ])
    );
    const { result: hook } = renderHook(() => useRecentLookups());
    expect(hook.current.recent).toEqual([{ type: 'user', id: 'u1', title: 'Dana', sub: 'x' }]);
  });
});

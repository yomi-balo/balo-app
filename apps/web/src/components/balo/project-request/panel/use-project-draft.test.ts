import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useProjectDraft } from './use-project-draft';

const EXPERT_ID = '99999999-9999-9999-9999-999999999999';
const KEY = `balo:project-draft:${EXPERT_ID}`;
const ENTRY = 'profile' as const;

function seed(value: unknown, key: string = KEY): void {
  globalThis.localStorage.setItem(key, JSON.stringify(value));
}

describe('useProjectDraft — hydration narrowing', () => {
  beforeEach(() => {
    globalThis.localStorage.clear();
  });

  it('starts from an empty draft when nothing is persisted', () => {
    const { result } = renderHook(() => useProjectDraft(EXPERT_ID, ENTRY));
    expect(result.current.draft.timeline).toBeNull();
    expect(result.current.draft.budgetMinCents).toBeNull();
    expect(result.current.draft.budgetMaxCents).toBeNull();
  });

  it('hydrates and trims a persisted free-text timeline', () => {
    seed({ timeline: '  Target go-live: end of Q3  ' });
    const { result } = renderHook(() => useProjectDraft(EXPERT_ID, ENTRY));
    expect(result.current.draft.timeline).toBe('Target go-live: end of Q3');
  });

  it('drops a whitespace-only timeline to null', () => {
    seed({ timeline: '   ' });
    const { result } = renderHook(() => useProjectDraft(EXPERT_ID, ENTRY));
    expect(result.current.draft.timeline).toBeNull();
  });

  it('drops a non-string timeline to null', () => {
    seed({ timeline: 42 });
    const { result } = renderHook(() => useProjectDraft(EXPERT_ID, ENTRY));
    expect(result.current.draft.timeline).toBeNull();
  });

  it('keeps only non-negative integer budget cents, else null', () => {
    seed({ budgetMinCents: 500000, budgetMaxCents: -1 });
    const { result } = renderHook(() => useProjectDraft(EXPERT_ID, ENTRY));
    expect(result.current.draft.budgetMinCents).toBe(500000);
    expect(result.current.draft.budgetMaxCents).toBeNull();
  });

  it('falls back to an empty draft on corrupt storage', () => {
    globalThis.localStorage.setItem(KEY, '{not json');
    const { result } = renderHook(() => useProjectDraft(EXPERT_ID, ENTRY));
    expect(result.current.draft.title).toBe('');
    expect(result.current.draft.timeline).toBeNull();
  });
});

describe('useProjectDraft — default routing + autosave key', () => {
  beforeEach(() => {
    globalThis.localStorage.clear();
  });

  it('defaults routing to direct when an expert is bound', () => {
    const { result } = renderHook(() => useProjectDraft(EXPERT_ID, ENTRY));
    expect(result.current.draft.routing).toBe('direct');
  });

  it('defaults routing to match when no expert is bound (context-free)', () => {
    const { result } = renderHook(() => useProjectDraft(undefined, 'direct'));
    expect(result.current.draft.routing).toBe('match');
  });

  it('honours a persisted routing over the computed default', () => {
    // Persisted match under an expert-bound key — should NOT be overridden by direct.
    seed({ routing: 'match', title: 'x' });
    const { result } = renderHook(() => useProjectDraft(EXPERT_ID, ENTRY));
    expect(result.current.draft.routing).toBe('match');
  });

  it('uses the byte-identical expert-bound key for an expert-bound mount', async () => {
    const { result } = renderHook(() => useProjectDraft(EXPERT_ID, ENTRY));
    act(() => result.current.setField('title', 'Expert-bound draft'));
    await waitFor(() =>
      expect(globalThis.localStorage.getItem(KEY)).toContain('Expert-bound draft')
    );
  });

  it('uses an entry-scoped key for a context-free mount', async () => {
    const { result } = renderHook(() => useProjectDraft(undefined, 'direct'));
    act(() => result.current.setField('title', 'Context-free draft'));
    await waitFor(() =>
      expect(globalThis.localStorage.getItem('balo:project-draft:entry:direct')).toContain(
        'Context-free draft'
      )
    );
  });

  it('hydrates a context-free draft from the entry-scoped key', () => {
    seed({ title: 'Restored' }, 'balo:project-draft:entry:search');
    const { result } = renderHook(() => useProjectDraft(undefined, 'search'));
    expect(result.current.draft.title).toBe('Restored');
    // Context-free still defaults routing to match when none persisted.
    expect(result.current.draft.routing).toBe('match');
  });

  it('clearDraft resets to the computed default routing (match) for context-free', () => {
    const { result } = renderHook(() => useProjectDraft(undefined, 'direct'));
    act(() => result.current.setField('routing', 'direct'));
    act(() => result.current.clearDraft());
    expect(result.current.draft.routing).toBe('match');
    expect(globalThis.localStorage.getItem('balo:project-draft:entry:direct')).toBeNull();
  });
});

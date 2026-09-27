import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

  // BAL-254 — `source` round-trip: without this an AI draft silently reverts to 'manual' on
  // reload and the review step's AI provenance banner vanishes.
  it('defaults source to manual when nothing is persisted', () => {
    const { result } = renderHook(() => useProjectDraft(EXPERT_ID, ENTRY));
    expect(result.current.draft.source).toBe('manual');
  });

  it('hydrates a persisted source of "ai"', () => {
    seed({ source: 'ai' });
    const { result } = renderHook(() => useProjectDraft(EXPERT_ID, ENTRY));
    expect(result.current.draft.source).toBe('ai');
  });

  it('round-trips a persisted "ai" source through setField + reload', async () => {
    const { result, unmount } = renderHook(() => useProjectDraft(EXPERT_ID, ENTRY));
    act(() => result.current.setField('source', 'ai'));
    await waitFor(() => expect(globalThis.localStorage.getItem(KEY)).toContain('"source":"ai"'));
    unmount();

    const { result: reloaded } = renderHook(() => useProjectDraft(EXPERT_ID, ENTRY));
    expect(reloaded.current.draft.source).toBe('ai');
  });

  it('a corrupt/unrecognised source value falls back to manual', () => {
    seed({ source: 'not-a-real-source' });
    const { result } = renderHook(() => useProjectDraft(EXPERT_ID, ENTRY));
    expect(result.current.draft.source).toBe('manual');
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

describe('useProjectDraft — 24h expiry on the home draft only', () => {
  const HOME_KEY = 'balo:project-draft:entry:home';
  const DAY_MS = 24 * 60 * 60 * 1000;

  beforeEach(() => {
    globalThis.localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('hydrates a home draft saved just under 24h ago', () => {
    const now = Date.parse('2026-09-27T12:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    seed({ title: 'Still fresh', savedAt: now - (DAY_MS - 1000) }, HOME_KEY);
    const { result } = renderHook(() => useProjectDraft(undefined, 'home'));
    expect(result.current.draft.title).toBe('Still fresh');
  });

  it('hydrates a home draft saved exactly 24h ago (inclusive boundary)', () => {
    const now = Date.parse('2026-09-27T12:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    seed({ title: 'Exactly 24h', savedAt: now - DAY_MS }, HOME_KEY);
    const { result } = renderHook(() => useProjectDraft(undefined, 'home'));
    expect(result.current.draft.title).toBe('Exactly 24h');
  });

  it('discards and removes a home draft saved exactly 24h + 1ms ago', () => {
    const now = Date.parse('2026-09-27T12:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    seed({ title: 'Expired', savedAt: now - (DAY_MS + 1) }, HOME_KEY);
    const { result } = renderHook(() => useProjectDraft(undefined, 'home'));
    expect(result.current.draft.title).toBe('');
    expect(globalThis.localStorage.getItem(HOME_KEY)).toBeNull();
  });

  it('discards a home draft with no savedAt at all', () => {
    seed({ title: 'No timestamp' }, HOME_KEY);
    const { result } = renderHook(() => useProjectDraft(undefined, 'home'));
    expect(result.current.draft.title).toBe('');
    expect(globalThis.localStorage.getItem(HOME_KEY)).toBeNull();
  });

  it('discards a home draft with a non-finite savedAt', () => {
    seed({ title: 'Bad timestamp', savedAt: Number.NaN }, HOME_KEY);
    const { result } = renderHook(() => useProjectDraft(undefined, 'home'));
    expect(result.current.draft.title).toBe('');
  });

  it('discards a home draft whose savedAt is in the future', () => {
    const now = Date.parse('2026-09-27T12:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    seed({ title: 'From the future', savedAt: now + 1000 }, HOME_KEY);
    const { result } = renderHook(() => useProjectDraft(undefined, 'home'));
    expect(result.current.draft.title).toBe('');
  });

  it('stamps savedAt on write for the home entry point', async () => {
    const now = Date.parse('2026-09-27T12:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { result } = renderHook(() => useProjectDraft(undefined, 'home'));
    act(() => result.current.setField('title', 'Home draft'));
    await vi.advanceTimersByTimeAsync(500);
    const stored = globalThis.localStorage.getItem(HOME_KEY);
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored as string) as { savedAt: number };
    expect(parsed.savedAt).toBeGreaterThanOrEqual(now);
    expect(parsed.savedAt).toBeLessThan(now + 1000);
  });

  it('does not stamp savedAt for a non-home context-free entry point', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useProjectDraft(undefined, 'search'));
    act(() => result.current.setField('title', 'Search draft'));
    await vi.advanceTimersByTimeAsync(500);
    const stored = globalThis.localStorage.getItem('balo:project-draft:entry:search');
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored as string)).not.toHaveProperty('savedAt');
  });

  it('never expires the profile (expert-bound) draft, which carries no savedAt', () => {
    seed({ title: 'Expert-bound, no savedAt' }); // KEY defaults to the expert-bound key
    const { result } = renderHook(() => useProjectDraft(EXPERT_ID, ENTRY));
    expect(result.current.draft.title).toBe('Expert-bound, no savedAt');
  });
});

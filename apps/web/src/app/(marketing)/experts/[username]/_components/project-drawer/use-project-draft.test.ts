import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useProjectDraft } from './use-project-draft';

const EXPERT_ID = '99999999-9999-9999-9999-999999999999';
const KEY = `balo:project-draft:${EXPERT_ID}`;

function seed(value: unknown): void {
  window.localStorage.setItem(KEY, JSON.stringify(value));
}

describe('useProjectDraft — hydration narrowing', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('starts from an empty draft when nothing is persisted', () => {
    const { result } = renderHook(() => useProjectDraft(EXPERT_ID));
    expect(result.current.draft.timeline).toBeNull();
    expect(result.current.draft.budgetMinCents).toBeNull();
    expect(result.current.draft.budgetMaxCents).toBeNull();
  });

  it('hydrates and trims a persisted free-text timeline', () => {
    seed({ timeline: '  Target go-live: end of Q3  ' });
    const { result } = renderHook(() => useProjectDraft(EXPERT_ID));
    expect(result.current.draft.timeline).toBe('Target go-live: end of Q3');
  });

  it('drops a whitespace-only timeline to null', () => {
    seed({ timeline: '   ' });
    const { result } = renderHook(() => useProjectDraft(EXPERT_ID));
    expect(result.current.draft.timeline).toBeNull();
  });

  it('drops a non-string timeline to null', () => {
    seed({ timeline: 42 });
    const { result } = renderHook(() => useProjectDraft(EXPERT_ID));
    expect(result.current.draft.timeline).toBeNull();
  });

  it('keeps only non-negative integer budget cents, else null', () => {
    seed({ budgetMinCents: 500000, budgetMaxCents: -1 });
    const { result } = renderHook(() => useProjectDraft(EXPERT_ID));
    expect(result.current.draft.budgetMinCents).toBe(500000);
    expect(result.current.draft.budgetMaxCents).toBeNull();
  });

  it('falls back to an empty draft on corrupt storage', () => {
    window.localStorage.setItem(KEY, '{not json');
    const { result } = renderHook(() => useProjectDraft(EXPERT_ID));
    expect(result.current.draft.title).toBe('');
    expect(result.current.draft.timeline).toBeNull();
  });
});

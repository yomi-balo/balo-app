'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export interface ProjectDraft {
  title: string;
  description: string;
  focusArea: string | null;
  budget: string | null;
  timeline: string | null;
}

const EMPTY_DRAFT: ProjectDraft = {
  title: '',
  description: '',
  focusArea: null,
  budget: null,
  timeline: null,
};

const DEBOUNCE_MS = 400;

/** Per-expert localStorage key so drafts never bleed across profiles. */
function draftKey(expertProfileId: string): string {
  return `balo:project-draft:${expertProfileId}`;
}

/**
 * Reads + narrows a persisted draft. Corrupt / legacy shapes silently fall back
 * to an empty draft — no throw, no `console.*` (per the plan).
 */
function readDraft(expertProfileId: string): ProjectDraft {
  if (typeof window === 'undefined') return EMPTY_DRAFT;
  try {
    const raw = window.localStorage.getItem(draftKey(expertProfileId));
    if (raw === null) return EMPTY_DRAFT;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return EMPTY_DRAFT;
    const record = parsed as Record<string, unknown>;
    return {
      title: typeof record.title === 'string' ? record.title : '',
      description: typeof record.description === 'string' ? record.description : '',
      focusArea: typeof record.focusArea === 'string' ? record.focusArea : null,
      budget: typeof record.budget === 'string' ? record.budget : null,
      timeline: typeof record.timeline === 'string' ? record.timeline : null,
    };
  } catch {
    // Corrupt or inaccessible storage — start fresh.
    return EMPTY_DRAFT;
  }
}

interface UseProjectDraftResult {
  draft: ProjectDraft;
  setField: <K extends keyof ProjectDraft>(key: K, value: ProjectDraft[K]) => void;
  clearDraft: () => void;
}

/**
 * localStorage autosave for the project-request form. Lazy-inits from storage,
 * debounces writes (~400ms), and exposes `clearDraft()` (called on a successful
 * submit) which removes the key entirely.
 */
export function useProjectDraft(expertProfileId: string): UseProjectDraftResult {
  const [draft, setDraft] = useState<ProjectDraft>(() => readDraft(expertProfileId));
  const writeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearedRef = useRef(false);

  const setField = useCallback(<K extends keyof ProjectDraft>(key: K, value: ProjectDraft[K]) => {
    clearedRef.current = false;
    setDraft((prev) => ({ ...prev, [key]: value }));
  }, []);

  const clearDraft = useCallback(() => {
    clearedRef.current = true;
    if (writeTimer.current) {
      clearTimeout(writeTimer.current);
      writeTimer.current = null;
    }
    setDraft(EMPTY_DRAFT);
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.removeItem(draftKey(expertProfileId));
    } catch {
      // Ignore — nothing actionable if storage is unavailable.
    }
  }, [expertProfileId]);

  // Debounced persist on change. Skipped immediately after a clear so we don't
  // re-write an empty draft over the removed key.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (clearedRef.current) return;
    if (writeTimer.current) clearTimeout(writeTimer.current);
    writeTimer.current = setTimeout(() => {
      try {
        window.localStorage.setItem(draftKey(expertProfileId), JSON.stringify(draft));
      } catch {
        // Ignore — quota / private-mode failures are non-fatal.
      }
    }, DEBOUNCE_MS);
    return () => {
      if (writeTimer.current) clearTimeout(writeTimer.current);
    };
  }, [draft, expertProfileId]);

  return { draft, setField, clearDraft };
}

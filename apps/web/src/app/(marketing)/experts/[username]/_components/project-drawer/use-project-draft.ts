'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProjectRouting } from './send-to-selector';
import type { ProjectDocumentRef } from '../../_actions/schemas';

export interface ProjectDraft {
  routing: ProjectRouting;
  title: string;
  /** Sanitisable TipTap HTML for the brief. */
  descriptionHtml: string;
  tagIds: string[];
  productIds: string[];
  /** Only CONFIRMED R2 refs are persisted — in-flight/failed uploads never are. */
  documents: ProjectDocumentRef[];
}

const EMPTY_DRAFT: ProjectDraft = {
  routing: 'direct',
  title: '',
  descriptionHtml: '',
  tagIds: [],
  productIds: [],
  documents: [],
};

const DEBOUNCE_MS = 400;

const DOCUMENT_CONTENT_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
]);

/** Per-expert localStorage key so drafts never bleed across profiles. */
function draftKey(expertProfileId: string): string {
  return `balo:project-draft:${expertProfileId}`;
}

/** Narrow an unknown array to a `string[]` (drops non-strings). */
function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

/** Narrow an unknown array to validated `ProjectDocumentRef[]`. */
function readDocuments(value: unknown): ProjectDocumentRef[] {
  if (!Array.isArray(value)) return [];
  const docs: ProjectDocumentRef[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    const { r2Key, fileName, contentType, sizeBytes } = record;
    if (
      typeof r2Key === 'string' &&
      typeof fileName === 'string' &&
      typeof contentType === 'string' &&
      DOCUMENT_CONTENT_TYPES.has(contentType) &&
      typeof sizeBytes === 'number'
    ) {
      docs.push({
        r2Key,
        fileName,
        contentType: contentType as ProjectDocumentRef['contentType'],
        sizeBytes,
      });
    }
  }
  return docs;
}

/**
 * Reads + narrows a persisted draft. Corrupt / legacy shapes silently fall back
 * to defaults — no throw, no `console.*`. Legacy keys (focusArea/budget/timeline,
 * the old `description`) are silently dropped: we only read the new field set.
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
      routing: record.routing === 'match' ? 'match' : 'direct',
      title: typeof record.title === 'string' ? record.title : '',
      descriptionHtml: typeof record.descriptionHtml === 'string' ? record.descriptionHtml : '',
      tagIds: readStringArray(record.tagIds),
      productIds: readStringArray(record.productIds),
      documents: readDocuments(record.documents),
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

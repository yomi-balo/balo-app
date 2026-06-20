'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProjectRouting } from './send-to-selector';
import type { ProjectDocumentRef } from '@/lib/project-request/actions/schemas';

/** Where the panel was opened from — drives the context-free autosave key. */
export type ProjectRequestEntryPoint = 'profile' | 'search' | 'card' | 'direct';

export interface ProjectDraft {
  routing: ProjectRouting;
  title: string;
  /** Sanitisable TipTap HTML for the brief. */
  descriptionHtml: string;
  tagIds: string[];
  productIds: string[];
  /** Only CONFIRMED R2 refs are persisted — in-flight/failed uploads never are. */
  documents: ProjectDocumentRef[];
  /** Optional budget range in integer minor units (cents). Null = not specified. */
  budgetMinCents: number | null;
  budgetMaxCents: number | null;
  /** Optional free-text timeline. Null = not specified. */
  timeline: string | null;
}

/** Draft shape minus its routing — routing is computed from the bound expert. */
type DraftWithoutRouting = Omit<ProjectDraft, 'routing'>;

const EMPTY_DRAFT_WITHOUT_ROUTING: DraftWithoutRouting = {
  title: '',
  descriptionHtml: '',
  tagIds: [],
  productIds: [],
  documents: [],
  budgetMinCents: null,
  budgetMaxCents: null,
  timeline: null,
};

const DEBOUNCE_MS = 400;

const DOCUMENT_CONTENT_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
]);

/**
 * Default routing for a fresh draft: expert-bound mounts default to Direct (the
 * bound expert); context-free mounts default to Match ("find me an expert").
 */
function defaultRoutingFor(expertProfileId: string | undefined): ProjectRouting {
  return expertProfileId ? 'direct' : 'match';
}

/**
 * localStorage key. Expert-bound keeps the BYTE-IDENTICAL key from before this
 * relocation (`balo:project-draft:{id}`) so in-flight drafts survive. Context-free
 * mounts (no expert) namespace by entry point so different entry surfaces don't
 * collide.
 */
function draftKey(
  expertProfileId: string | undefined,
  entryPoint: ProjectRequestEntryPoint
): string {
  return expertProfileId
    ? `balo:project-draft:${expertProfileId}`
    : `balo:project-draft:entry:${entryPoint}`;
}

/** Narrow an unknown array to a `string[]` (drops non-strings). */
function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

/** Narrow an unknown to a non-negative integer, else null. */
function readNullableCents(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/** Narrow an unknown to a non-empty trimmed string, else null. */
function readNullableTimeline(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
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
 * Narrow a persisted `routing` value. A stored `'direct'`/`'match'` is honoured
 * as-is; anything else (missing/corrupt) falls back to the computed default
 * (expert-bound → direct, context-free → match).
 */
function readRouting(value: unknown, defaultRouting: ProjectRouting): ProjectRouting {
  if (value === 'match') return 'match';
  if (value === 'direct') return 'direct';
  return defaultRouting;
}

/**
 * Reads + narrows a persisted draft. Corrupt / legacy shapes silently fall back
 * to defaults — no throw, no `console.*`. The legacy `focusArea` key and the old
 * free-text `budget` string are silently dropped (we only read the new field
 * set). Budget is now re-introduced under explicit typed keys — `budgetMinCents`
 * / `budgetMaxCents` (numbers) and `timeline` (string) — so any legacy free-text
 * `budget` value is ignored without collision.
 */
function readDraft(
  expertProfileId: string | undefined,
  entryPoint: ProjectRequestEntryPoint,
  defaultRouting: ProjectRouting
): ProjectDraft {
  const emptyDraft: ProjectDraft = { routing: defaultRouting, ...EMPTY_DRAFT_WITHOUT_ROUTING };
  if (typeof globalThis.window === 'undefined') return emptyDraft;
  try {
    const raw = globalThis.localStorage.getItem(draftKey(expertProfileId, entryPoint));
    if (raw === null) return emptyDraft;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return emptyDraft;
    const record = parsed as Record<string, unknown>;
    return {
      routing: readRouting(record.routing, defaultRouting),
      title: typeof record.title === 'string' ? record.title : '',
      descriptionHtml: typeof record.descriptionHtml === 'string' ? record.descriptionHtml : '',
      tagIds: readStringArray(record.tagIds),
      productIds: readStringArray(record.productIds),
      documents: readDocuments(record.documents),
      budgetMinCents: readNullableCents(record.budgetMinCents),
      budgetMaxCents: readNullableCents(record.budgetMaxCents),
      timeline: readNullableTimeline(record.timeline),
    };
  } catch {
    // Corrupt or inaccessible storage — start fresh.
    return emptyDraft;
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
 * submit) which removes the key entirely and resets to the computed default
 * routing. The key + default routing both derive from whether an expert is bound
 * (`expertProfileId`) — expert-bound defaults to Direct, context-free to Match.
 */
export function useProjectDraft(
  expertProfileId: string | undefined,
  entryPoint: ProjectRequestEntryPoint
): UseProjectDraftResult {
  const defaultRouting = defaultRoutingFor(expertProfileId);
  const [draft, setDraft] = useState<ProjectDraft>(() =>
    readDraft(expertProfileId, entryPoint, defaultRouting)
  );
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
    setDraft({ routing: defaultRouting, ...EMPTY_DRAFT_WITHOUT_ROUTING });
    if (typeof globalThis.window === 'undefined') return;
    try {
      globalThis.localStorage.removeItem(draftKey(expertProfileId, entryPoint));
    } catch {
      // Ignore — nothing actionable if storage is unavailable.
    }
  }, [expertProfileId, entryPoint, defaultRouting]);

  // Debounced persist on change. Skipped immediately after a clear so we don't
  // re-write an empty draft over the removed key.
  useEffect(() => {
    if (typeof globalThis.window === 'undefined') return;
    if (clearedRef.current) return;
    if (writeTimer.current) clearTimeout(writeTimer.current);
    writeTimer.current = setTimeout(() => {
      try {
        globalThis.localStorage.setItem(
          draftKey(expertProfileId, entryPoint),
          JSON.stringify(draft)
        );
      } catch {
        // Ignore — quota / private-mode failures are non-fatal.
      }
    }, DEBOUNCE_MS);
    return () => {
      if (writeTimer.current) clearTimeout(writeTimer.current);
    };
  }, [draft, expertProfileId, entryPoint]);

  return { draft, setField, clearDraft };
}

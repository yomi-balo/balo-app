'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProjectRouting } from './send-to-selector';
import type { ProjectDocumentRef } from '@/lib/project-request/actions/schemas';
import type { ProjectRequestEntryPoint } from '@balo/shared/project-requests';
import type { AiFieldSnapshot } from './use-ai-brief-flow';

/**
 * Defined once in `@balo/shared/project-requests` and re-exported here so every existing import
 * of this type from this module keeps working unchanged.
 */
export type { ProjectRequestEntryPoint };

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
  /**
   * BAL-589 — case files the client has selected in `CaseFilePicker`, keyed by
   * `` `${origin}:${id}` `` (the case file's own identity, origin-qualified since
   * `meeting_files.id`/`conversation_files.id` are unique only within their own table) and
   * mapped to the FULL {@link ProjectDocumentRef} the copy landed at in `project-documents/`.
   * Lets the picker show a selection as already-copied across a reopen, and lets deselecting
   * find the exact key to remove. Empty `{}` for every non-case mount and for a case mount with
   * no selections.
   *
   * ⚠ Kept OUT of `documents`. `DocumentUploader` is uncontrolled (seeded once
   * from `initialDocuments`, and `onDocumentsChange` REPLACES its caller's list wholesale from
   * its own internal row state alone); a case copy added to `documents` from here was silently
   * dropped the next time the uploader published its own rows — e.g. the first time the client
   * also uploaded a file. Every consumer of "all the request's documents" combines the two
   * through {@link allDraftDocuments} rather than reading `documents` alone.
   */
  caseFileSelections: Record<string, ProjectDocumentRef>;
  /**
   * BAL-589 — the snapshot taken right after `useCaseBriefFlow`'s last successful
   * generation, persisted so `hasAiDraft`/`hasEditsSinceGenerate` survive a reload instead of
   * resetting to "no AI draft" on every mount (they otherwise lived only in that hook's own,
   * mount-scoped state). `null` whenever no case brief has ever landed, a new run has just
   * started, or the last run failed.
   */
  caseBriefSnapshot: AiFieldSnapshot | null;
  /**
   * BAL-254 — which entry path produced this draft; threaded into
   * `submitProjectRequestAction`'s payload (replacing the old hardcoded `'manual'` literal at
   * submit) and drives the `review` step's AI provenance banner. Persisted through the same
   * localStorage autosave as every other field, so a page refresh mid-AI-flow doesn't silently
   * forget it came from AI. ⚠ The AI-owned unmatched-tag/product labels are NOT part of this
   * draft — they live in `ProjectRequestPanel` component state only (never persisted).
   */
  source: 'manual' | 'ai';
  /**
   * The home hero search this draft was started from (`useProjectSeed`) — `null` for a draft no
   * search started. Persisted, so the SAME search on a later visit continues this draft even after
   * its title was edited in the panel, while a different search starts a fresh one.
   */
  seededFrom: DraftSeedOrigin | null;
}

/** What a hero search seeded into a draft: its text (if any) and its product chips. */
export interface DraftSeedOrigin {
  text: string | null;
  productIds: string[];
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
  caseFileSelections: {},
  caseBriefSnapshot: null,
  source: 'manual',
  seededFrom: null,
};

/**
 * BAL-589 — every document the request actually carries: the uploader-owned
 * `documents` plus every case-file copy the client has selected. ONE helper so the submit
 * payload, the review summary, the analytics `document_count`, and `useCaseBriefFlow`'s own
 * resume check never drift from one another.
 */
export function allDraftDocuments(
  draft: Pick<ProjectDraft, 'documents' | 'caseFileSelections'>
): ProjectDocumentRef[] {
  return [...draft.documents, ...Object.values(draft.caseFileSelections)];
}

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
 * localStorage key. BAL-589 — a case mount's `caseId` wins over everything else: checked
 * BEFORE the expert branch, so a case-bound mount never collides with (or falls back to) the
 * SAME expert's profile draft. Expert-bound (no `caseId`) keeps the BYTE-IDENTICAL key from
 * before this relocation (`balo:project-draft:{id}`) so in-flight drafts survive. Context-free
 * mounts (no expert, no case) namespace by entry point so different entry surfaces don't
 * collide.
 */
function draftKey(
  expertProfileId: string | undefined,
  entryPoint: ProjectRequestEntryPoint,
  caseId?: string
): string {
  if (caseId !== undefined) return `balo:project-draft:case:${caseId}`;
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

/**
 * Narrow a persisted `source` value. BAL-254 — without this an AI-generated draft silently
 * reverts to `'manual'` on reload and the `review` step's AI provenance banner vanishes.
 */
function readSource(value: unknown): 'manual' | 'ai' {
  return value === 'ai' ? 'ai' : 'manual';
}

/** Narrow a persisted `seededFrom` — anything malformed reads as "no search started this draft". */
function readSeededFrom(value: unknown): DraftSeedOrigin | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const text = typeof record.text === 'string' ? record.text : null;
  return { text, productIds: readStringArray(record.productIds) };
}

/** Narrow an unknown to a non-empty trimmed string, else null. */
function readNullableTimeline(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Narrow one unknown value to a `ProjectDocumentRef`, else `null`. Shared by `readDocuments`
 *  (an array of these) and `readCaseFileSelections` (a record of these) so the two never drift
 *  on what counts as a valid persisted document ref. */
function readDocumentRef(value: unknown): ProjectDocumentRef | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const { r2Key, fileName, contentType, sizeBytes } = record;
  if (
    typeof r2Key === 'string' &&
    typeof fileName === 'string' &&
    typeof contentType === 'string' &&
    DOCUMENT_CONTENT_TYPES.has(contentType) &&
    typeof sizeBytes === 'number'
  ) {
    return {
      r2Key,
      fileName,
      contentType: contentType as ProjectDocumentRef['contentType'],
      sizeBytes,
    };
  }
  return null;
}

/** Narrow a persisted `caseFileSelections` to a `string`→`ProjectDocumentRef` record, dropping
 *  any entry whose value isn't a valid document ref. `{}` for anything that isn't a plain
 *  object. */
function readCaseFileSelections(value: unknown): Record<string, ProjectDocumentRef> {
  if (typeof value !== 'object' || value === null) return {};
  const result: Record<string, ProjectDocumentRef> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const doc = readDocumentRef(entry);
    if (doc !== null) result[key] = doc;
  }
  return result;
}

/** Narrow a persisted `caseBriefSnapshot` — anything malformed reads as "no AI case draft". */
function readCaseBriefSnapshot(value: unknown): AiFieldSnapshot | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const { title, descriptionHtml } = record;
  if (typeof title !== 'string' || typeof descriptionHtml !== 'string') return null;
  return {
    title,
    descriptionHtml,
    tagIds: readStringArray(record.tagIds),
    productIds: readStringArray(record.productIds),
  };
}

/** Narrow an unknown array to validated `ProjectDocumentRef[]`. */
function readDocuments(value: unknown): ProjectDocumentRef[] {
  if (!Array.isArray(value)) return [];
  const docs: ProjectDocumentRef[] = [];
  for (const item of value) {
    const doc = readDocumentRef(item);
    if (doc !== null) docs.push(doc);
  }
  return docs;
}

/**
 * Narrow a persisted `routing` value. A `defaultRouting` of `'match'` means no expert is bound
 * (`defaultRoutingFor`): a context-free mount is always Match, so a stored `'direct'` reads back as
 * `'match'`. For an expert-bound mount a stored
 * `'direct'`/`'match'` is honoured as-is; anything else (missing/corrupt) falls back to the
 * computed default.
 */
function readRouting(value: unknown, defaultRouting: ProjectRouting): ProjectRouting {
  if (defaultRouting === 'match') return 'match';
  if (value === 'match') return 'match';
  if (value === 'direct') return 'direct';
  return defaultRouting;
}

/** BAL-582 — the sliding expiry window for the unauthenticated home draft only. */
const HOME_DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * True only for the context-free `entry:home` draft — the sole key that expires. An
 * expert-bound mount never reaches this: even if it were passed `entryPoint: 'home'`, a
 * defined `expertProfileId` routes it to the byte-identical expert key instead (`draftKey`).
 */
function isHomeEntry(
  expertProfileId: string | undefined,
  entryPoint: ProjectRequestEntryPoint
): boolean {
  return expertProfileId === undefined && entryPoint === 'home';
}

/**
 * A home draft is fresh when `savedAt` is a finite epoch-ms timestamp no more than 24h in the
 * past and not in the future (a clock skew or tampered value is treated as expired, not trusted).
 */
function isFreshHomeDraft(savedAt: unknown, now: number): boolean {
  if (typeof savedAt !== 'number' || !Number.isFinite(savedAt)) return false;
  const age = now - savedAt;
  return age >= 0 && age <= HOME_DRAFT_TTL_MS;
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
  defaultRouting: ProjectRouting,
  caseId?: string
): ProjectDraft {
  const emptyDraft: ProjectDraft = { routing: defaultRouting, ...EMPTY_DRAFT_WITHOUT_ROUTING };
  if (globalThis.window === undefined) return emptyDraft;
  const key = draftKey(expertProfileId, entryPoint, caseId);
  try {
    const raw = globalThis.localStorage.getItem(key);
    if (raw === null) return emptyDraft;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return emptyDraft;
    const record = parsed as Record<string, unknown>;
    if (isHomeEntry(expertProfileId, entryPoint) && !isFreshHomeDraft(record.savedAt, Date.now())) {
      globalThis.localStorage.removeItem(key);
      return emptyDraft;
    }
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
      caseFileSelections: readCaseFileSelections(record.caseFileSelections),
      caseBriefSnapshot: readCaseBriefSnapshot(record.caseBriefSnapshot),
      source: readSource(record.source),
      seededFrom: readSeededFrom(record.seededFrom),
    };
  } catch {
    // Corrupt or inaccessible storage — start fresh.
    return emptyDraft;
  }
}

/**
 * BAL-582 — guarded removal of a context-free entry point's draft key (which can hold a title, a
 * brief and document refs). `useLogout` calls this for `'home'` synchronously, but only on an
 * EXPLICIT sign-out: a visitor who never signs in leaves the draft in localStorage, where the
 * `entry:home` key alone self-expires 24h after its last save (`readDraft`'s home-only check) —
 * every other context-free key keeps no TTL. No expert-bound draft key is user-scoped either; the
 * difference is that the profile mount gates on sign-in before it ever opens the panel, where the
 * home mount opens for signed-out visitors by design (D1). The key literal has one definition
 * (`draftKey`), so this and `useProjectDraft` can never drift apart.
 */
export function clearEntryPointDraft(entryPoint: ProjectRequestEntryPoint): void {
  if (globalThis.window === undefined) return;
  try {
    globalThis.localStorage.removeItem(draftKey(undefined, entryPoint));
  } catch {
    // Ignore — nothing actionable if storage is unavailable.
  }
}

/** The fields a fresh request can be started with. */
export type FreshDraftFields = Partial<
  Pick<ProjectDraft, 'title' | 'descriptionHtml' | 'seededFrom'>
>;

/**
 * BAL-589 — `setField` also accepts an UPDATER, exactly like React's own `setState`
 * overload: `(key, (prev) => next)` applies against the LATEST draft value for that field, even
 * when another `setField` call for the same key is still in flight (e.g. two case-file
 * selections resolving back-to-back). A plain `value` is applied as before.
 */
export type SetProjectDraftField = <K extends keyof ProjectDraft>(
  key: K,
  value: ProjectDraft[K] | ((prev: ProjectDraft[K]) => ProjectDraft[K])
) => void;

interface UseProjectDraftResult {
  draft: ProjectDraft;
  setField: SetProjectDraftField;
  clearDraft: () => void;
  /** Replaces the whole draft with an empty one (default routing) carrying only `fields`. Unlike
   *  `clearDraft`, the result is autosaved like any edit. */
  resetDraft: (fields: FreshDraftFields) => void;
  /** Replaces the whole draft with `next` — an earlier snapshot, e.g. an Undo. Autosaved. */
  replaceDraft: (next: ProjectDraft) => void;
  /**
   * Bumps each time `resetDraft` / `replaceDraft` replaces the draft wholesale while the form may
   * be on screen (`clearDraft` runs on submit, when it no longer is). ⚠ `DocumentUploader` reads
   * `initialDocuments` ONCE, on mount, so a mounted uploader would keep showing the replaced
   * draft's files — key it on this to remount it.
   */
  revision: number;
}

/** @see SetProjectDraftField */
function resolveFieldValue<T>(prev: T, value: T | ((prev: T) => T)): T {
  if (typeof value === 'function') return (value as (prev: T) => T)(prev);
  return value as T;
}

/**
 * localStorage autosave for the project-request form. Lazy-inits from storage,
 * debounces writes (~400ms), and exposes `clearDraft()` (called on a successful
 * submit) which removes the key entirely and resets to the computed default
 * routing. The key + default routing both derive from whether an expert is bound
 * (`expertProfileId`) — expert-bound defaults to Direct, context-free to Match.
 *
 * BAL-589 — `caseId`, present only for a "Convert to project" mount, overrides the key
 * (`draftKey`'s case branch runs first), never the default routing — a case mount is always
 * expert-bound too, so `defaultRoutingFor` already resolves to Direct.
 */
export function useProjectDraft(
  expertProfileId: string | undefined,
  entryPoint: ProjectRequestEntryPoint,
  caseId?: string
): UseProjectDraftResult {
  const defaultRouting = defaultRoutingFor(expertProfileId);
  const [draft, setDraft] = useState<ProjectDraft>(() =>
    readDraft(expertProfileId, entryPoint, defaultRouting, caseId)
  );
  const [revision, setRevision] = useState(0);
  const writeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearedRef = useRef(false);

  const setField = useCallback(
    <K extends keyof ProjectDraft>(
      key: K,
      value: ProjectDraft[K] | ((prev: ProjectDraft[K]) => ProjectDraft[K])
    ) => {
      clearedRef.current = false;
      setDraft((prev) => ({ ...prev, [key]: resolveFieldValue(prev[key], value) }));
    },
    []
  );

  const clearDraft = useCallback(() => {
    clearedRef.current = true;
    if (writeTimer.current) {
      clearTimeout(writeTimer.current);
      writeTimer.current = null;
    }
    setDraft({ routing: defaultRouting, ...EMPTY_DRAFT_WITHOUT_ROUTING });
    if (globalThis.window === undefined) return;
    try {
      globalThis.localStorage.removeItem(draftKey(expertProfileId, entryPoint, caseId));
    } catch {
      // Ignore — nothing actionable if storage is unavailable.
    }
  }, [expertProfileId, entryPoint, caseId, defaultRouting]);

  const resetDraft = useCallback(
    (fields: FreshDraftFields) => {
      clearedRef.current = false;
      setDraft({ routing: defaultRouting, ...EMPTY_DRAFT_WITHOUT_ROUTING, ...fields });
      setRevision((r) => r + 1);
    },
    [defaultRouting]
  );

  const replaceDraft = useCallback((next: ProjectDraft) => {
    clearedRef.current = false;
    setDraft(next);
    setRevision((r) => r + 1);
  }, []);

  // Debounced persist on change. Skipped immediately after a clear so we don't
  // re-write an empty draft over the removed key.
  useEffect(() => {
    if (globalThis.window === undefined) return;
    if (clearedRef.current) return;
    if (writeTimer.current) clearTimeout(writeTimer.current);
    writeTimer.current = setTimeout(() => {
      try {
        // The home draft alone carries `savedAt`, re-stamped on every write so the 24h
        // expiry window slides forward while the visitor keeps editing.
        const payload = isHomeEntry(expertProfileId, entryPoint)
          ? { ...draft, savedAt: Date.now() }
          : draft;
        globalThis.localStorage.setItem(
          draftKey(expertProfileId, entryPoint, caseId),
          JSON.stringify(payload)
        );
      } catch {
        // Ignore — quota / private-mode failures are non-fatal.
      }
    }, DEBOUNCE_MS);
    return () => {
      if (writeTimer.current) clearTimeout(writeTimer.current);
    };
  }, [draft, expertProfileId, entryPoint, caseId]);

  return { draft, setField, clearDraft, resetDraft, replaceDraft, revision };
}

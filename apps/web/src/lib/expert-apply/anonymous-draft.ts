import { z } from 'zod';
import { STEP_CONFIG, type StepKey } from '@/app/(apply)/expert/apply/_actions/schemas';

/**
 * BAL-502 §22.3 — anonymous draft storage for `/expert/apply`.
 *
 * `sessionStorage`, not `localStorage`: the payload is a professional CV (LinkedIn
 * slug, years of experience, employers, free-text responsibilities, certifications).
 * `localStorage` would leave all of it on a shared/kiosk browser indefinitely for a
 * visitor who never created an account and has no way to clear it from our side.
 * `sessionStorage` is tab-scoped and dies with the tab — the correct lifetime for
 * data belonging to nobody yet. It is sufficient because the auth transition never
 * closes the tab: the modal is same-tab, and the WorkOS OAuth round-trip is a
 * same-tab full-page navigation (sessionStorage is keyed to the tab, not the
 * document, so it survives that).
 *
 * No directive here on purpose — pure and client-safe, imported by both the wizard
 * context ('use client') and its unit tests.
 */

export const ANON_DRAFT_KEY = 'balo.expert-apply.anon-draft.v1';
export const ANON_DRAFT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** The SERIALIZED artifact, not the in-memory wizard state. Validated on every read. */
export interface AnonymousApplicationDraftV1 {
  v: 1;
  savedAt: string; // ISO
  currentStep: number;
  maxReachedStep: number;
  steps: Partial<Record<StepKey, unknown>>;
  /**
   * BAL-502 FIX round (WARNING 6) — ISO timestamp stamped ONLY at the submit gate
   * (`saveAnonymousDraftNow`, the sole caller), never by the 800ms background
   * debounce. The envelope carries no identity of its own — any session that shows
   * up in this tab can claim it (shared/kiosk browser: person A's CV attributed to
   * person B). `authGateAt` doesn't fix that on its own, but it bounds the blast
   * radius: the post-auth flush only trusts an envelope stamped within a short
   * window of "now", so a draft that has sat untouched for hours can't be silently
   * adopted by whoever happens to sign in next. Optional for forward/back
   * compatibility with an envelope written before this field existed — a missing
   * stamp is treated as untrusted (fails the freshness check), never as trusted.
   */
  authGateAt?: string;
}

const STEP_KEYS = STEP_CONFIG.map((step) => step.key) as [StepKey, ...StepKey[]];

const envelopeSchema = z.object({
  v: z.literal(1),
  savedAt: z.string(),
  currentStep: z.number().int().min(0),
  maxReachedStep: z.number().int().min(0),
  steps: z.record(z.enum(STEP_KEYS), z.unknown()),
  authGateAt: z.string().optional(),
});

function resolveStore(store: Storage | undefined): Storage | null {
  if (store) return store;
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    // Some hosts throw merely on ACCESSING the property (private-mode Safari,
    // historically). Degrade to "no store" rather than let the throw escape.
    return null;
  }
}

/**
 * Reads and validates the envelope. Every failure mode — absent key, storage access
 * throwing (private-window), truncated/invalid JSON, wrong `v`, wrong shape, or an
 * envelope older than `ANON_DRAFT_MAX_AGE_MS` — returns `null` rather than a
 * half-hydrated wizard. An expired envelope is also cleared so it never re-triggers
 * this check on the next read (same class of hazard as the `balo_session` 4KB
 * ceiling: assert on the real serialized artifact, not the in-memory object).
 */
export function readAnonymousDraft(store?: Storage): AnonymousApplicationDraftV1 | null {
  const resolved = resolveStore(store);
  if (!resolved) return null;

  let raw: string | null;
  try {
    raw = resolved.getItem(ANON_DRAFT_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const result = envelopeSchema.safeParse(parsed);
  if (!result.success) return null;

  const draft = result.data as AnonymousApplicationDraftV1;
  const ageMs = Date.now() - Date.parse(draft.savedAt);
  if (!Number.isFinite(ageMs) || ageMs > ANON_DRAFT_MAX_AGE_MS) {
    clearAnonymousDraft(resolved);
    return null;
  }

  return draft;
}

/**
 * Writes the envelope. Returns `false` (never throws) on any failure — `setItem`
 * throws `QuotaExceededError` near the ~5MB origin cap (work-history
 * `responsibilities` is unbounded free text), and Safari private mode has
 * historically thrown on `setItem` outright. The caller shows no error and simply
 * stops persisting; the wizard must remain fully usable with nothing stored.
 */
export function writeAnonymousDraft(draft: AnonymousApplicationDraftV1, store?: Storage): boolean {
  const resolved = resolveStore(store);
  if (!resolved) return false;

  try {
    resolved.setItem(ANON_DRAFT_KEY, JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

/** Best-effort clear. Never throws. */
export function clearAnonymousDraft(store?: Storage): void {
  const resolved = resolveStore(store);
  if (!resolved) return;
  try {
    resolved.removeItem(ANON_DRAFT_KEY);
  } catch {
    // Best-effort — nothing further to do if even removal throws.
  }
}

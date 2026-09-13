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

/**
 * Per-step progress marker, mirrored from the wizard's own rail. Declared HERE
 * rather than in the provider because this module owns the serialized contract —
 * the provider imports it, so there is exactly one definition of the union that
 * ever reaches storage.
 */
export type StepStatus = 'pending' | 'completed' | 'skipped';

/** The SERIALIZED artifact, not the in-memory wizard state. Validated on every read. */
export interface AnonymousApplicationDraftV1 {
  v: 1;
  savedAt: string; // ISO
  currentStep: number;
  maxReachedStep: number;
  steps: Partial<Record<StepKey, unknown>>;
  /**
   * BAL-562 — per-step progress, positionally parallel to `STEP_CONFIG`. Persisted
   * so an anonymous reload restores the progress rail and not merely the field
   * values: these statuses are produced by NAVIGATION (`goNext` / `skipStep`), so
   * unlike the authenticated path there is no server draft to re-derive them from
   * and nothing else in the envelope implies them. Optional, so an envelope written
   * before this field existed still validates and simply restores without markers.
   */
  stepStatuses?: StepStatus[];
  /**
   * BAL-502 FIX round (WARNING 6) — ISO timestamp stamped only where the visitor
   * deliberately crosses an auth boundary, never by the 800ms background debounce.
   * BAL-562 added the second such place, so there are now exactly TWO stampers and
   * they are the two auth entry points: the Terms submit gate
   * (`saveAnonymousDraftNow`) and the apply header's "Log in" (`stampAuthGate`, used
   * by `ApplyHeaderActions`). Nothing else may stamp — a stamp asserts intent, not
   * activity. The envelope carries no identity of its own — any session that shows
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
  stepStatuses: z.array(z.enum(['pending', 'completed', 'skipped'])).optional(),
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
 * Minimal, side-effect-FREE read of just the stored stamp.
 *
 * Deliberately not `readAnonymousDraft`: that one CLEARS an over-age envelope as a
 * side effect, and a write must never mutate storage as a consequence of looking
 * something up. No age check either — freshness is the post-auth flush's decision to
 * make (`AUTH_GATE_FLUSH_WINDOW_MS`), not this carry-forward's.
 */
function readStoredAuthGateAt(store: Storage): string | undefined {
  let raw: string | null;
  try {
    raw = store.getItem(ANON_DRAFT_KEY);
  } catch {
    return undefined;
  }
  if (raw === null) return undefined;

  try {
    const parsed: unknown = JSON.parse(raw);
    // A non-object payload (`null`, a bare number) either throws on the property
    // access or yields a non-string — both land on `undefined`, never a bad stamp.
    const stamp = (parsed as { authGateAt?: unknown }).authGateAt;
    return typeof stamp === 'string' ? stamp : undefined;
  } catch {
    return undefined;
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

  // BAL-562 — the stamp is STICKY. `authGateAt` is set once, at an auth gate, but the
  // envelope is rebuilt WHOLESALE from live wizard state by the 800ms debounce, which
  // has no way to know a gate was ever crossed. Without this carry-forward a single
  // field change within 800ms of hitting the gate silently strips the stamp; the
  // post-auth flush then fails its freshness check and discards the visitor's entire
  // application with no toast. Carrying it here rather than at each call site makes
  // the invariant hold for EVERY writer — including `ApplyHeaderActions`, which is
  // rendered by `(apply)/layout.tsx`, outside the wizard provider, and can reach
  // nothing but storage. An explicit `authGateAt` on the incoming draft still wins,
  // so a fresh stamp always moves the window forward.
  const merged: AnonymousApplicationDraftV1 =
    draft.authGateAt === undefined
      ? { ...draft, authGateAt: readStoredAuthGateAt(resolved) }
      : draft;

  try {
    // `JSON.stringify` drops an `undefined` value, so the no-prior-stamp case
    // serializes identically to an envelope that never carried the field.
    resolved.setItem(ANON_DRAFT_KEY, JSON.stringify(merged));
    return true;
  } catch {
    return false;
  }
}

/**
 * Stamps "whoever is at this tab deliberately asked to authenticate" onto the stored
 * envelope.
 *
 * Separate from `writeAnonymousDraft` because the two call sites that cross an auth
 * boundary sit on OPPOSITE sides of the wizard provider: the Terms submit gate holds
 * live state and writes a whole fresh envelope, while the apply header's "Log in"
 * control can only reach storage. Both are a deliberate act by the person sitting at
 * this tab, which is exactly the thing the flush's freshness window is defined
 * against (WARNING 6) — so both must stamp, and neither widens the kiosk hazard.
 *
 * Returns `false` when there is nothing to stamp (no envelope — the ordinary case on
 * every `(apply)` route except the wizard) or the write failed.
 */
export function stampAuthGate(store?: Storage): boolean {
  const resolved = resolveStore(store);
  if (!resolved) return false;

  const existing = readAnonymousDraft(resolved);
  if (!existing) return false;

  return writeAnonymousDraft({ ...existing, authGateAt: new Date().toISOString() }, resolved);
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

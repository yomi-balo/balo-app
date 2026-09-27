/**
 * BAL-582 D1 — the post-sign-up return-to-home marker.
 *
 * The home hero opens the project panel for signed-out visitors too; auth is requested only at
 * Submit or document upload. A visitor who signs up there leaves `/` entirely for `/onboarding`
 * (a brand-new account is never onboarded), so an in-memory flag would not survive the trip.
 * sessionStorage does — it is tab-scoped and outlives the `/onboarding` push — and the marker
 * written here is read once the wizard completes, to send the user back to `/` with the panel
 * reopened on their saved draft.
 *
 * Pure, React-free, no `server-only` guard (imported from client modules and from the onboarding
 * wizard). Follows the `setup-intent-return.ts` guarded-storage precedent: every accessor
 * swallows a throw (private-mode Safari, a locked-down profile) and degrades to "no marker"
 * rather than escaping to the caller.
 */

const PENDING_HOME_PROJECT_STORAGE_KEY = 'balo:pending-intent:home';
const PENDING_HOME_PROJECT_TTL_MS = 30 * 60 * 1000;

interface PendingHomeProjectMarker {
  readonly intent: 'project';
  readonly createdAt: number;
}

function resolveStore(): Storage | null {
  // `globalThis.window === undefined`, not a `typeof` guard — see `setup-intent-return.ts`.
  if (globalThis.window === undefined) return null;
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function isPendingHomeProjectMarker(value: unknown): value is PendingHomeProjectMarker {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.intent === 'project' && typeof record.createdAt === 'number';
}

/** `null` for an absent key, unreadable storage, malformed JSON, or the wrong shape. */
function readMarker(store: Storage): PendingHomeProjectMarker | null {
  let raw: string | null;
  try {
    raw = store.getItem(PENDING_HOME_PROJECT_STORAGE_KEY);
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
  return isPendingHomeProjectMarker(parsed) ? parsed : null;
}

function isFresh(marker: PendingHomeProjectMarker, now: number): boolean {
  const age = now - marker.createdAt;
  return age >= 0 && age <= PENDING_HOME_PROJECT_TTL_MS;
}

/** Best-effort write. Never throws. */
export function rememberPendingHomeProject(now: number = Date.now()): void {
  const store = resolveStore();
  if (store === null) return;
  const marker: PendingHomeProjectMarker = { intent: 'project', createdAt: now };
  try {
    store.setItem(PENDING_HOME_PROJECT_STORAGE_KEY, JSON.stringify(marker));
  } catch {
    // Storage unavailable or full — the visitor simply won't be returned to the panel.
  }
}

/** Best-effort clear. Never throws. Idempotent — safe to call on a path that already cleared. */
export function forgetPendingHomeProject(): void {
  const store = resolveStore();
  if (store === null) return;
  try {
    store.removeItem(PENDING_HOME_PROJECT_STORAGE_KEY);
  } catch {
    // Nothing to clean up, or nothing we are allowed to clean up.
  }
}

/**
 * `false` for an absent, malformed, wrong-intent, expired or inaccessible marker. Read-only —
 * unlike `consumePendingHomeProject`, it never removes the key.
 */
export function hasPendingHomeProject(now: number = Date.now()): boolean {
  const store = resolveStore();
  if (store === null) return false;
  const marker = readMarker(store);
  return marker !== null && isFresh(marker, now);
}

/**
 * Reads the marker and ALWAYS removes the key afterwards — even when it was absent, malformed
 * or expired — so a stale or spent marker can never be read twice.
 */
export function consumePendingHomeProject(now: number = Date.now()): boolean {
  const store = resolveStore();
  if (store === null) return false;
  const marker = readMarker(store);
  forgetPendingHomeProject();
  return marker !== null && isFresh(marker, now);
}

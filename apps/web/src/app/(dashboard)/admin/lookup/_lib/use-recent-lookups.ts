'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { LOOKUP_ENTITY_TYPES, type LookupEntityType, type LookupResult } from '@balo/shared/lookup';
import { ADMIN_LOOKUP_RECENT_STORAGE_KEY } from '@/lib/admin-lookup/recent-storage';

/**
 * BAL-551 — "Recent · opened by you", shown on an empty query. Client-side ONLY.
 *
 * ⚠ PER BROWSER, NOT PER ACCOUNT. Recent is kept in this browser's localStorage, NOT in
 * `audit_events` and NOT in a new table — "reads write nothing" (PR #273 D3) is the whole point
 * of this surface, and a server-side Recent is explicitly out of scope (BAL-551 scope ruling).
 * The consequence, accepted: a staff member who switches machine or profile starts with an
 * empty Recent, and two people sharing a browser profile share a Recent. A server-side,
 * per-account Recent is a separate ticket if it is ever wanted.
 *
 * ⚠ BAL-551 fix round F7 — titles fall back to EMAIL ADDRESSES and company sub-lines carry
 * WALLET BALANCES, so on a shared support machine these used to outlive the session
 * indefinitely. `clearStoredRecentLookups()` (`@/lib/admin-lookup/recent-storage`) is wired
 * into `useLogout` (the app's one client sign-out sequence), synchronously alongside
 * `forgetSetupIntent()`, so an explicit sign-out clears this key.
 *
 * ⚠ BAL-551 fix round R4 — the storage key and `clearStoredRecentLookups` used to be DEFINED
 * here and imported by `use-logout.ts` reaching into this route-private `_lib` — a layering
 * inversion (a shared layout module depending on one route's private implementation detail).
 * Both now live in `@/lib/admin-lookup/recent-storage`; this file imports the key from there,
 * ONE definition, no second literal.
 *
 * ⚠ RESIDUAL EXPOSURE, STATED RATHER THAN CLAIMED CLOSED: the sign-out clear only fires on an
 * EXPLICIT sign-out. A tab left open past the 7-day session cookie, a browser force-closed or
 * crashed, or `clearMiddlewareSession`'s server-side teardown on decode failure/expiry (no
 * client code runs on that path — see `use-logout.ts`'s own FIX ROUND 1 F5 note for the
 * identical gap on the SetupIntent binding) all leave this key populated in that browser's
 * storage. This is the same exposure `balo:project-draft:*` already accepts for draft briefs;
 * it stores NO money figure beyond what was already rendered on screen.
 */

const RECENT_KEY = ADMIN_LOOKUP_RECENT_STORAGE_KEY;
const RECENT_LIMIT = 10;

export interface RecentLookupEntry {
  readonly type: LookupEntityType;
  readonly id: string;
  readonly title: string;
  readonly sub: string;
}

function isLookupEntityType(value: unknown): value is LookupEntityType {
  return typeof value === 'string' && (LOOKUP_ENTITY_TYPES as readonly string[]).includes(value);
}

/** Narrow an unknown value to one valid entry, dropping anything malformed rather than throwing. */
function readEntry(value: unknown): RecentLookupEntry | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const { type, id, title, sub } = record;
  if (
    !isLookupEntityType(type) ||
    typeof id !== 'string' ||
    typeof title !== 'string' ||
    typeof sub !== 'string'
  ) {
    return null;
  }
  return { type, id, title, sub };
}

function readStoredRecent(): RecentLookupEntry[] {
  if (typeof globalThis.window === 'undefined') return [];
  try {
    const raw = globalThis.localStorage.getItem(RECENT_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const entries: RecentLookupEntry[] = [];
    for (const item of parsed) {
      const entry = readEntry(item);
      if (entry !== null) entries.push(entry);
    }
    return entries.slice(0, RECENT_LIMIT);
  } catch {
    // Corrupt JSON, a disabled store, or a private-browsing throw — treated as empty, never
    // thrown, so a bad payload cannot break the page.
    return [];
  }
}

function writeStoredRecent(entries: readonly RecentLookupEntry[]): void {
  if (typeof globalThis.window === 'undefined') return;
  try {
    globalThis.localStorage.setItem(RECENT_KEY, JSON.stringify(entries));
  } catch {
    // Storage full, disabled, or a private-browsing throw — Recent degrading silently is
    // acceptable; it is a convenience list, never a source of truth.
  }
}

export interface UseRecentLookupsResult {
  readonly recent: readonly RecentLookupEntry[];
  /** Moves an existing entry to the front rather than duplicating it, then truncates to 10. */
  remember(result: LookupResult): void;
}

export function useRecentLookups(): UseRecentLookupsResult {
  const [recent, setRecent] = useState<RecentLookupEntry[]>([]);
  // BAL-551 fix round F11 — the persist effect below must NOT fire on the very first mount:
  // that render's `recent` is still `[]` (the hydration read below hasn't landed yet, since it
  // is itself an effect), and both effects fire in the SAME flush after mount — so an
  // unguarded persist effect would write `[]` over real stored data before the hydrated read
  // ever reaches the DOM. Skipped once, here; every subsequent change persists normally.
  const isInitialRenderRef = useRef(true);

  useEffect(() => {
    setRecent(readStoredRecent());
  }, []);

  // BAL-551 fix round F11 — the persist WRITE used to run INSIDE the `setRecent` functional
  // updater, which React (StrictMode, concurrent features) may invoke more than once per
  // commit; a `setState` updater must be a pure function of its previous state, and a
  // `localStorage` write is a side effect. Moved here, keyed on `recent`, so the write happens
  // exactly once per actual state change.
  useEffect(() => {
    if (isInitialRenderRef.current) {
      isInitialRenderRef.current = false;
      return;
    }
    writeStoredRecent(recent);
  }, [recent]);

  const remember = useCallback((result: LookupResult) => {
    setRecent((current) => {
      const withoutExisting = current.filter(
        (entry) => !(entry.type === result.type && entry.id === result.id)
      );
      return [
        { type: result.type, id: result.id, title: result.title, sub: result.sub },
        ...withoutExisting,
      ].slice(0, RECENT_LIMIT);
    });
  }, []);

  return { recent, remember };
}

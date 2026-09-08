/**
 * BAL-551 fix round R4 — the admin-lookup "Recent" storage key and its clear function,
 * hoisted OUT of the route-private `app/(dashboard)/admin/lookup/_lib/use-recent-lookups.ts`.
 *
 * The layering was inverted: `components/layout/use-logout.ts` — a SHARED layout module used
 * across the whole app — was reaching into one route's private `_lib` directory to clear this
 * key on sign-out. Acknowledged in-code at the time (see the original fix round F7 comments),
 * but it is a real inversion: a shared module must not import a route-private implementation
 * detail.
 *
 * This file is now the ONE definition of the storage key. Both `use-logout.ts` and
 * `admin/lookup/_lib/use-recent-lookups.ts` import it from here — no second literal.
 */

export const ADMIN_LOOKUP_RECENT_STORAGE_KEY = 'balo:admin-lookup-recent';

/**
 * Wired into `useLogout` (`components/layout/use-logout.ts`) so an explicit sign-out clears
 * the names, emails and wallet-balance sub-lines Recent carries. See
 * `admin/lookup/_lib/use-recent-lookups.ts`'s header comment for the residual exposure this
 * does NOT close (a crash, a force-closed tab, or the server-side middleware teardown all run
 * no client code and leave this key populated).
 */
export function clearStoredRecentLookups(): void {
  if (typeof globalThis.window === 'undefined') return;
  try {
    globalThis.localStorage.removeItem(ADMIN_LOOKUP_RECENT_STORAGE_KEY);
  } catch {
    // A disabled store or a private-browsing throw — nothing to clear either way.
  }
}

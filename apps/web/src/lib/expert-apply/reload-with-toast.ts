/**
 * BAL-502 FIX round (CRITICAL 1 / HIGH 2) — forces a REAL document reload instead
 * of `router.refresh()`.
 *
 * `expert-application-context.tsx`'s post-auth flush effect used to call
 * `router.refresh()` after a successful flush or a server-wins supersede. That
 * cannot rehydrate the wizard: the provider's state comes from
 * `useState(() => hydrate*(draft))` LAZY initializers that only run once at
 * mount, and nothing puts a `key` on the provider to force a remount when its
 * `draft`/`user` props change. A soft refresh therefore left stale anonymous data
 * on screen (the "server wins" toast lied) with `expertProfileId` stuck at
 * `null` (`submitApplication` then permanently returned "No application to
 * submit"). A REAL reload is the only fix — it forces a fresh mount that
 * re-derives every field from the server draft the flush just wrote.
 *
 * sessionStorage survives a full navigation (it's tab-scoped, not
 * document-scoped — §22.3), so the toast that would have been shown by the old
 * soft refresh is stashed here immediately before the reload, and replayed by
 * `consumePendingToast` once the fresh mount comes up.
 *
 * `navigate` and `store` are injectable (mirrors `anonymous-draft.ts`'s `store`
 * param) so this module is unit-testable without touching `globalThis.location`:
 * jsdom defines `Location.prototype.assign` as non-configurable, so
 * `vi.spyOn(location, 'assign')` throws "Cannot redefine property" (the same
 * trap documented in `files-panel.test.tsx`'s download-suite comment).
 */

export const PENDING_TOAST_KEY = 'balo.expert-apply.pending-toast.v1';

export interface ReloadWithToastOptions {
  navigate?: (url: string) => void;
  store?: Storage;
}

/** Stashes `message` for replay after reload, then navigates to `/expert/apply`. */
export function reloadWithToast(message: string, options?: ReloadWithToastOptions): void {
  const navigate = options?.navigate ?? ((url: string) => globalThis.location.assign(url));
  try {
    const store = options?.store ?? globalThis.sessionStorage;
    store?.setItem(PENDING_TOAST_KEY, message);
  } catch {
    // Best-effort — the reload must happen regardless; the visitor just won't see
    // this particular toast a second time.
  }
  navigate('/expert/apply');
}

/** Reads and clears any toast stashed by `reloadWithToast`. Never throws. */
export function consumePendingToast(store?: Storage): string | null {
  const resolved = store ?? globalThis.sessionStorage;
  try {
    const pending = resolved?.getItem(PENDING_TOAST_KEY) ?? null;
    if (pending) resolved.removeItem(PENDING_TOAST_KEY);
    return pending;
  } catch {
    return null;
  }
}

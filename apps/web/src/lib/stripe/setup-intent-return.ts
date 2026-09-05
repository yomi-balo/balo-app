/**
 * BAL-526 — the SetupIntent redirect-return binding.
 *
 * ⚠⚠ SECURITY (LOW). A crafted link can carry an ATTACKER's own succeeded SetupIntent id as
 * `?setup_intent=` — Stripe genuinely returns `succeeded` for it (same Balo Stripe account), so a
 * page that trusted the URL alone would paint "Card saved" on a victim who never did anything.
 * This module closes that: the browser records the SetupIntent id it just minted, in THIS tab, at
 * capture-start, and a return only counts when the URL's id matches what this tab recorded.
 *
 * Pure, React-free, no `server-only` guard (must be importable from `'use client'` modules), no
 * `@balo/db` value import (the bundle footgun — see `reference_balo_db_client_bundle_footgun`).
 */

/** The single slot. `.v1` carries the shape version — bump it to invalidate every old entry. */
export const SETUP_INTENT_BINDING_STORAGE_KEY = 'balo.stripe.setup-intent.v1';

/** What Stripe appends to `return_url` on a SetupIntent redirect return. */
export interface SetupIntentReturnParams {
  readonly clientSecret: string;
  readonly setupIntentId: string;
}

/**
 * ⚠ Storage can THROW on merely ACCESSING the property (private-mode Safari, a locked-down
 * profile) — not just on `getItem`/`setItem`. Every accessor below routes through this so a
 * throw anywhere degrades to "no store" rather than escaping to the caller.
 */
function resolveStore(): Storage | null {
  // ⚠ `globalThis.window === undefined`, NOT `typeof … === 'undefined'` (SonarJS
  // no-typeof-undefined — the `typeof` guard only matters for a bare, possibly-undeclared
  // identifier; `globalThis.window` is a safe property access).
  if (globalThis.window === undefined) return null;
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Best-effort write. Never throws. A blank id is refused (it could never match a return).
 *
 * B1 — `postInternal`'s `as T` cast (`api-client.ts`) hands this a value TYPED `string` with ZERO
 * runtime validation behind it; an API rollback that drops `setupIntentId` from a 2xx body would
 * otherwise dereference `.length` on a non-string and throw INSIDE the caller's `.then()`, hard-
 * failing the whole capture start rather than degrading to "no binding" as this function's own
 * docblock promises.
 */
export function rememberSetupIntent(setupIntentId: string): void {
  if (typeof setupIntentId !== 'string' || setupIntentId.length === 0) return;
  const store = resolveStore();
  if (store === null) return;
  try {
    store.setItem(SETUP_INTENT_BINDING_STORAGE_KEY, setupIntentId);
  } catch {
    // Storage unavailable or full — the capture still works, it just cannot bind a return.
  }
}

/** Best-effort clear. Never throws. Idempotent — safe to call on a path that already cleared. */
export function forgetSetupIntent(): void {
  const store = resolveStore();
  if (store === null) return;
  try {
    store.removeItem(SETUP_INTENT_BINDING_STORAGE_KEY);
  } catch {
    // Nothing to clean up, or nothing we are allowed to clean up.
  }
}

/** `null` for an absent key, a blank value, or storage that throws on access. */
export function readRememberedSetupIntent(): string | null {
  const store = resolveStore();
  if (store === null) return null;
  let raw: string | null;
  try {
    raw = store.getItem(SETUP_INTENT_BINDING_STORAGE_KEY);
  } catch {
    return null;
  }
  if (raw === null || raw.length === 0) return null;
  return raw;
}

/**
 * BOTH params or nothing. `redirect_status` is deliberately not read — the retrieved SetupIntent
 * status is the truth, and `redirect_status` is as forgeable as the rest of the URL.
 */
export function readSetupIntentReturnParams(): SetupIntentReturnParams | null {
  const raw = globalThis.window === undefined ? '' : globalThis.location.search;
  const params = new URLSearchParams(raw);
  // A2 (security, defensive) — a return with the return_url `location.href` (pre-fix, or any
  // future regression) bakes an already-present pair into the redirect, and Stripe appends a
  // SECOND, genuine pair after it. Rather than silently taking the first (the attacker's, in the
  // poisoning scenario) or the last, fail closed on ANY duplicate — an honest return never has
  // more than one of either param.
  if (params.getAll('setup_intent').length > 1) return null;
  if (params.getAll('setup_intent_client_secret').length > 1) return null;
  const setupIntentId = params.get('setup_intent');
  const clientSecret = params.get('setup_intent_client_secret');
  if (setupIntentId === null || setupIntentId.length === 0) return null;
  if (clientSecret === null || clientSecret.length === 0) return null;
  return { clientSecret, setupIntentId };
}

/**
 * ⚠⚠ THE SECURITY PREDICATE. THE ONE DEFINITION OF "THIS RETURN IS OURS" — never write a second.
 * Returns the params only when `setup_intent` strictly equals the id this tab recorded at
 * capture-start. Reads only; clears nothing — clearing on a mismatch would let a crafted link
 * destroy a victim's live binding (turning a spoof into a denial of their own genuine return).
 */
export function matchSetupIntentReturn(): SetupIntentReturnParams | null {
  const params = readSetupIntentReturnParams();
  if (params === null) return null;
  const remembered = readRememberedSetupIntent();
  if (remembered === null) return null;
  if (remembered !== params.setupIntentId) return null;
  return params;
}

/** `matchSetupIntentReturn() !== null`, for a caller that only needs the yes/no (D5). */
export function isSetupIntentReturnBound(): boolean {
  return matchSetupIntentReturn() !== null;
}

/**
 * ⚠ Replaces the URL with `location.pathname` ONLY — this DROPS EVERY QUERY PARAM, not just
 * Stripe's. That is the shipped behaviour of both `clearRedirectParams()` copies, preserved
 * verbatim: this is a security ticket and it must not smuggle in a semantic change. It is safe
 * today because neither `/settings/billing` nor `/redeem` carries any other query state. A THIRD
 * surface with query state must not adopt this as-is — switch to targeted `URLSearchParams.delete`
 * at that point (out-of-scope follow-up).
 *
 * B4 — Best-effort. Never throws. Firefox throttles rapid `replaceState` calls and raises
 * `SecurityError`; every OTHER exported mutator in this module already degrades silently on a
 * throw, so this one must too, or the caller's binding-clear-then-callback sequence stops partway
 * and the component is stuck on its "finishing" state forever — the exact bundled defect this
 * ticket exists to close.
 */
export function clearSetupIntentReturnParams(): void {
  if (globalThis.window === undefined) return;
  try {
    globalThis.history.replaceState(null, '', globalThis.location.pathname);
  } catch {
    // Throttled or otherwise refused — the params linger, but the binding clear and the
    // caller's callback must still run (see `use-setup-intent-redirect-return.ts`).
  }
}

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
 *
 * ⚠ BAL-529 §B — THE RETURN URL IS NOT A SAFE PLACE TO PARK A SECRET, AND THIS MODULE DOES NOT
 * ASSUME OTHERWISE. Stripe appends `?setup_intent=` and `?setup_intent_client_secret=` to the
 * return URL and they linger there (deliberately, for an unbound return — clearing on a mismatch
 * would let a crafted link destroy a victim's genuine binding). Every URL that leaves this
 * process now routes those params through `redactSensitivePath`
 * (`@balo/shared/redaction`, `STRIPE_SETUP_INTENT_RETURN_QUERY_PARAMS`), so PostHog autocapture
 * and Sentry breadcrumbs / Session Replay never see the id or the secret. Storing the id in
 * `sessionStorage` here is therefore justified by the A1 spoof defence ALONE — never by "it is
 * already in the URL anyway", which is no longer true of anything that leaves the browser.
 *
 * ⚠⚠ CORRECTED, FIX ROUND 1 F4 (security S1) — "PostHog autocapture never sees the id or the
 * secret" above named `$current_url`/`$pathname`/`$referrer` only. Two MORE PostHog-assembled
 * properties independently carry `location.href` verbatim and were NOT covered when that
 * sentence was first written: `$session_entry_url` (`sessionPropsManager`, re-stamped on every
 * event of a session, not just the landing pageview — a session that rolls over mid-3DS-wait
 * picks up the secret) and `$set_once.$initial_current_url` (`persistence.get_initial_props()`).
 * Both are now closed the same way `packages/analytics/src/client/client.ts`'s
 * `sanitizeAnalyticsEvent` closes the other three — PLUS `posthog.init`'s own
 * `mask_personal_data_properties` / `custom_personal_data_properties`, which mask these
 * specific param VALUES at the SDK's own source. Verified against posthog-js@1.335.3's shipped
 * dist for the properties named here; NOT a blanket guarantee against a property this module has
 * not enumerated, including one a future posthog-js version might add.
 */

import {
  STRIPE_SETUP_INTENT_PARAM,
  STRIPE_SETUP_INTENT_CLIENT_SECRET_PARAM,
  STRIPE_SETUP_INTENT_RETURN_QUERY_PARAMS,
} from '@balo/shared/redaction';
// BAL-529 §D — TYPE-ONLY. This module stays pure (no analytics runtime, no `server-only`,
// importable from `'use client'` modules) — only the vocabulary TYPE crosses the boundary.
import type { StripeRedirectUnboundReason } from '@balo/analytics/client';

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
 * ⚠ THE A2 DEFENCE, NAMED. A `return_url` of `location.href` (pre-fix, or a future regression)
 * bakes an already-present pair into the redirect and Stripe appends a SECOND, genuine pair
 * after it. Rather than silently taking the first (the attacker's) or the last, fail closed on
 * ANY duplicate — an honest return never has more than one of either param. Called by
 * `readSetupIntentReturnParams` (fails closed) and `diagnoseUnboundSetupIntentReturn` (reports
 * it) — never re-implemented.
 */
function hasDuplicateSetupIntentParams(params: URLSearchParams): boolean {
  return (
    params.getAll(STRIPE_SETUP_INTENT_PARAM).length > 1 ||
    params.getAll(STRIPE_SETUP_INTENT_CLIENT_SECRET_PARAM).length > 1
  );
}

/**
 * BOTH params or nothing. `redirect_status` is deliberately not read — the retrieved SetupIntent
 * status is the truth, and `redirect_status` is as forgeable as the rest of the URL.
 */
export function readSetupIntentReturnParams(): SetupIntentReturnParams | null {
  const raw = globalThis.window === undefined ? '' : globalThis.location.search;
  const params = new URLSearchParams(raw);
  // A2 (security, defensive) — see `hasDuplicateSetupIntentParams` for the rationale.
  if (hasDuplicateSetupIntentParams(params)) return null;
  const setupIntentId = params.get(STRIPE_SETUP_INTENT_PARAM);
  const clientSecret = params.get(STRIPE_SETUP_INTENT_CLIENT_SECRET_PARAM);
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
 * BAL-529 §D — WHY a return in the URL is not ours, for observability only. READ-ONLY: touches
 * no storage, no URL, no callback. `null` means "nothing to report" — either there is no return
 * in the URL at all, or the return IS bound (in which case the caller never gets here).
 */
export function diagnoseUnboundSetupIntentReturn(): StripeRedirectUnboundReason | null {
  const raw = globalThis.window === undefined ? '' : globalThis.location.search;
  if (hasDuplicateSetupIntentParams(new URLSearchParams(raw))) return 'duplicate_params';
  const params = readSetupIntentReturnParams();
  if (params === null) return null;
  const remembered = readRememberedSetupIntent();
  if (remembered === null) return 'no_binding';
  return remembered === params.setupIntentId ? null : 'id_mismatch';
}

/**
 * BAL-529 §F — TARGETED DELETION. This used to replace the URL with `location.pathname` only,
 * dropping EVERY query param. That was safe while only `/settings/billing` and `/redeem` used
 * the hook and neither carries other query state — but it made the hook un-adoptable by any
 * surface that does, which is a trap rather than a design. Now: delete exactly Stripe's three
 * params ({@link STRIPE_SETUP_INTENT_RETURN_QUERY_PARAMS}) and keep everything else, including
 * the fragment. `URLSearchParams.delete` removes ALL occurrences, so an A2-poisoned return with
 * a duplicated pair is fully cleared too.
 *
 * B4 — Best-effort. Never throws. Firefox throttles rapid `replaceState` and raises
 * `SecurityError`; every other exported mutator degrades silently on a throw, so this must too,
 * or the caller's binding-clear-then-callback sequence stops partway and the component is stuck
 * on "finishing" forever.
 */
export function clearSetupIntentReturnParams(): void {
  if (globalThis.window === undefined) return;
  try {
    const url = new URL(globalThis.location.href);
    for (const param of STRIPE_SETUP_INTENT_RETURN_QUERY_PARAMS) url.searchParams.delete(param);
    const query = url.searchParams.toString();
    // FIX ROUND 1 (SonarCloud sonarjs/no-nested-template-literals) — the `?${query}` template
    // hoisted out to its own `search` variable rather than nested inside the outer one.
    const search = query === '' ? '' : `?${query}`;
    globalThis.history.replaceState(null, '', `${url.pathname}${search}${url.hash}`);
  } catch {
    // Throttled or otherwise refused — the params linger, but the binding clear and the
    // caller's callback must still run (see `use-setup-intent-redirect-return.ts`).
  }
}

'use client';

import { useEffect, useRef } from 'react';
import { getStripe } from '@/lib/stripe-loader';
import {
  clearSetupIntentReturnParams,
  forgetSetupIntent,
  matchSetupIntentReturn,
} from './setup-intent-return';

export interface UseSetupIntentRedirectReturnOptions {
  /**
   * D1 — the surface's own retry copy, handed back through `onFailed`. NOT hoisted: the two
   * pages say different things and neither may change.
   *   settings → "That card couldn't be confirmed. You can try again."
   *   redeem   → "That card couldn't be confirmed. You can add another to keep going."
   */
  readonly retryMessage: string;
  /** A BOUND return was detected and the retrieve is in flight — enter your "finishing" state. */
  readonly onStarted: () => void;
  /** `succeeded`. Params AND binding are ALREADY cleared when this fires. */
  readonly onSucceeded: () => void;
  /** `processing`. Params AND binding are deliberately KEPT so a refresh re-checks. */
  readonly onProcessing: () => void;
  /** Every non-success exit. Params + binding already cleared; `message` is `retryMessage`. */
  readonly onFailed: (message: string) => void;
}

/**
 * BAL-526 — the shared 3DS/SCA redirect-return effect, extracted from
 * `payment-method-manager.tsx` and `continue-to-mandate.tsx` (near-verbatim duplicates) and
 * BOUND to a SetupIntent this browser tab actually started — see `setup-intent-return.ts` for
 * the security rationale.
 *
 * Runs exactly once per mount. `matchSetupIntentReturn() === null` (no return here, OR a return
 * that is not ours — these are deliberately indistinguishable from the outside) means the hook is
 * COMPLETELY INERT: no callback fires, no state changes, the URL is not touched, and CRUCIALLY
 * the binding is not cleared (clearing on a mismatch would let a crafted link destroy a victim's
 * own live binding).
 */
export function useSetupIntentRedirectReturn(options: UseSetupIntentRedirectReturnOptions): void {
  // The callbacks ref — declared FIRST so it is populated (post-render) before the mount effect
  // below ever runs. Reading only `latest.current` inside the mount effect means it has no
  // dependency on callback identity, so `[]` is a correct, not a suppressed, dependency array —
  // no `eslint-disable-next-line react-hooks/exhaustive-deps` needed.
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });

  useEffect(() => {
    const matched = matchSetupIntentReturn();
    if (matched === null) {
      return;
    }
    const publishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
    if (!publishableKey) {
      // Unconfigured (e.g. a preview env): skip the retrieve rather than crash the page. This
      // preserves the shipped behaviour both pages have today.
      return;
    }

    let cancelled = false;

    /**
     * B3 — a discriminated outcome, resolved INSIDE the retrieve's own try/catch chain.
     * The callbacks themselves are dispatched from a SEPARATE `.then()` below, attached AFTER
     * the `.catch()`, so an exception a callback throws (e.g. an unguarded `posthog.capture`
     * inside a caller's `onSucceeded`) can no longer be caught by this chain's `.catch()` and
     * misread as a retrieve failure — which would repaint a genuine, already-persisted capture
     * as "couldn't be confirmed".
     *
     * F-E — that throw is deliberately left to escape as an unhandled rejection (so Sentry's
     * `unhandledrejection` listener still sees the analytics failure); this hook does not, and
     * must not, grow a swallowing `.catch()` around the callback dispatch below. A caller's
     * callback is expected to run its own state-setting (e.g. `setPhase`) BEFORE anything that
     * can throw, precisely so this escape is safe rather than stranding the caller's UI.
     */
    type Outcome =
      | 'succeeded'
      | 'processing'
      | 'failed'
      | 'unresolved'
      | 'id_mismatch'
      | 'cancelled';

    latest.current.onStarted();
    getStripe(publishableKey)
      .then(async (stripe): Promise<Outcome> => {
        if (stripe === null) {
          // NOT 'failed' — we learned NOTHING about the bound intent, so the binding must
          // survive (see the `unresolved` rule below).
          return 'unresolved';
        }
        if (cancelled) {
          return 'cancelled';
        }
        const { setupIntent } = await stripe.retrieveSetupIntent(matched.clientSecret);
        if (cancelled) {
          return 'cancelled';
        }
        // A1 (security) — the BINDING constrains `?setup_intent=`, but `clientSecret` comes
        // straight off the URL and is NEVER checked to belong to that id. Without this, an
        // attacker who learns a victim's bound SetupIntent id crafts
        // `?setup_intent=<victim_id>&setup_intent_client_secret=<attacker's own succeeded seti
        // secret>` — the binding matches on id, but `retrieveSetupIntent` returns the
        // ATTACKER's own succeeded intent. Comparing the RETRIEVED object's own `id` (never
        // parsed out of the `seti_..._secret_...` string) closes that off.
        //
        // ⚠⚠ THE BINDING-LIFETIME RULE — "deny on evidence, not absence" (the same rule
        // `relationshipDeniesHosting` follows in `@balo/shared/authz`). ONLY a positively
        // RETRIEVED, positively TERMINAL intent may clear the binding. Everything else is
        // `unresolved`: we learned nothing, so we destroy nothing.
        //
        // This is deliberately STRONGER than `plan.md`'s original line 365 ("anything else,
        // including `setupIntent` undefined → fail"). That plan text predates the discovery
        // below and would reopen F-A; the code is right and the plan row is corrected.
        //
        // ⚠ `retrieveSetupIntent` RESOLVES `{ setupIntent: undefined, error }` — it does NOT
        // reject — on any API error (`api_connection_error`, 429, 5xx, `resource_missing`, a
        // consumed secret). See `@stripe/stripe-js`'s `SetupIntentResult` union. So an HONEST
        // return during a Stripe blip arrives here with `setupIntent === undefined`. Treating
        // that as a mismatch-or-failure would let a transient 500 wipe a real user's binding.
        if (setupIntent === undefined) {
          return 'unresolved';
        }
        // A crafted link CAN reach this branch (that is the A1 attack), and a genuine return
        // cannot — Stripe returns the intent belonging to the secret it was given. Either way
        // the binding survives, so the crafted link cannot also destroy the victim's ability to
        // complete their own still-pending genuine return (Edge case 2).
        if (setupIntent.id !== matched.setupIntentId) {
          return 'id_mismatch';
        }
        if (setupIntent.status === 'succeeded') {
          return 'succeeded';
        }
        if (setupIntent.status === 'processing') {
          return 'processing';
        }
        return 'failed';
      })
      // A rejection tells us nothing about the bound intent — and an attacker CHOOSES this
      // branch (a malformed `setup_intent_client_secret` rejects deterministically), so it must
      // never be allowed to clear a victim's binding.
      .catch((): Outcome => 'unresolved')
      .then((outcome) => {
        if (cancelled || outcome === 'cancelled') {
          return;
        }
        if (outcome === 'processing') {
          // Leave both the params AND the binding in place so a refresh re-checks while the
          // webhook finalises. Do not "tidy" this — it is load-bearing.
          latest.current.onProcessing();
          return;
        }
        if (outcome === 'id_mismatch' || outcome === 'unresolved') {
          // F-A — clear the PARAMS (so a refresh doesn't re-run this same doomed retrieve) but
          // deliberately do NOT call `forgetSetupIntent()`: nothing here proved the bound intent
          // is dead, so the binding must survive for a genuine return that may still be coming.
          // Cost is nil — an orphan binding is inert and the next capture start overwrites the
          // single slot (Edge case 8).
          clearSetupIntentReturnParams();
          latest.current.onFailed(latest.current.retryMessage);
          return;
        }
        // Only 'succeeded' and 'failed' reach here — both mean we RETRIEVED the bound intent
        // and it is positively terminal, which is the one condition that licenses forgetting.
        //
        // B4 — `forgetSetupIntent()` FIRST, then the URL rewrite, then the callback. `clearSetupIntentReturnParams()` can throw in Firefox under rapid
        // `replaceState` calls (degraded to a no-op by its own try/catch); ordering the binding
        // clear BEFORE it means that throw can no longer skip the clear, and the callback below
        // still runs regardless — so the component can never get stuck on "finishing" forever.
        forgetSetupIntent();
        clearSetupIntentReturnParams();
        if (outcome === 'succeeded') {
          latest.current.onSucceeded();
          return;
        }
        latest.current.onFailed(latest.current.retryMessage);
      });

    return (): void => {
      cancelled = true;
    };
  }, []);
}

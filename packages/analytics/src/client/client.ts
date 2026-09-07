import posthog from 'posthog-js';
import type { CaptureResult } from 'posthog-js';
import {
  redactSensitivePath,
  STRIPE_SETUP_INTENT_RETURN_QUERY_PARAMS,
} from '@balo/shared/redaction';
import { reportAnalyticsError } from './error-reporter';

let initialized = false;

/** URL-shaped autocapture properties that may carry a secret-bearing path. */
const URL_PROPERTY_KEYS = [
  '$current_url',
  '$pathname',
  '$referrer',
  /**
   * FIX ROUND 1 F4 (security S1) — `sessionPropsManager.getSessionProps()` (posthog-js@1.335.3)
   * snapshots `location.href` into these THREE top-level properties EVERY time the session id
   * changes, and merges them into EVERY subsequent event of that session — independently of
   * `$current_url`/`$pathname`/`$referrer` above, which are per-EVENT autocapture properties.
   * A 3DS/bank round trip that outlasts PostHog's 30-minute session idle timeout (a slow SMS OTP)
   * starts a fresh session on the return pageview, so `$session_entry_url` becomes the FULL
   * return URL — including `setup_intent_client_secret` — and then rides every event of that
   * session, not just the one pageview. Verified against the shipped bundle: `getSessionProps`
   * derives these from `getSetOnceProps()`, the SAME snapshot `$set_once.$initial_*` below reads.
   */
  '$session_entry_url',
  '$session_entry_pathname',
  '$session_entry_referrer',
] as const;

/**
 * FIX ROUND 1 F4 (security S1) — the `$set_once` keys carrying the SAME shape, one level down.
 * `persistence.get_initial_props()` (posthog-js@1.335.3) snapshots the landing URL ONCE per
 * browser (first pageview, or right after `posthog.reset()` — which BAL-529 §C's sign-out
 * triggers) and re-attaches it under `$set_once` on every event thereafter. `$set_once` is a
 * BAG `sanitizeAnalyticsEvent`'s top-level walk never reached before this fix.
 */
const INITIAL_URL_PROPERTY_KEYS = [
  '$initial_current_url',
  '$initial_pathname',
  '$initial_referrer',
] as const;

/**
 * PostHog `before_send` hook (BAL-386, extended BAL-529 §B/F4). Autocapture ($pageview /
 * $pageleave and the rest) stamps the current URL onto every event; on the public
 * `/shared/proposals/{token}` page that URL carries the raw magic-link token, and on a
 * `/settings/billing` or `/redeem` Stripe redirect return it can carry `setup_intent_client_secret`.
 * Rewrite the URL-shaped properties — both the top-level ones and the `$set_once` bag — through
 * the SAME redaction used by the Edge middleware so neither ever leaves the browser. Returns the
 * (possibly mutated) event; never drops it.
 *
 * ⚠⚠ FIX ROUND 2 G7 — A KNOWN, NOT HYPOTHETICAL, RESIDUAL: this walk only reaches TOP-LEVEL
 * event properties and the `$set_once` bag. PostHog's own Session Replay recorder (rrweb)
 * emits `$snapshot` events whose payload lives at `properties.$snapshot_data[]`, and a `Meta`
 * frame in that array carries `href` — the full URL — independently of both this walk and
 * `mask_personal_data_properties` above (neither reaches inside `$snapshot_data`).
 *
 * ⚠⚠ CLOSED, FIX ROUND 3 R2 — this residual is now closed for PostHog, the same way FIX ROUND 1
 * F12 already closed the equivalent gap for Sentry Replay on the same landings (see below):
 * `initAnalytics` sets `disable_session_recording: true` whenever the landing URL is one
 * `redactSensitivePath` would rewrite, refusing Session Replay outright rather than trying to
 * scrub it. The reasoning is identical to F12's — stated once here and not duplicated:
 * Session Replay is a THIRD-PARTY SINK with no equivalent to `before_send`'s per-field
 * redaction (there is no callback here at all, unlike Sentry's `beforeAddRecordingEvent`, so
 * even F12's "cannot scrub, can only refuse" fallback has no hook to reach for on the PostHog
 * side), so refusing the whole recording is the only sound option on a page that may carry a
 * live `setup_intent_client_secret` in its URL. `client.test.ts`'s
 * "BAL-529 fix-round-3 R2" suite pins exactly which landings pay it.
 *
 * Symmetric with a DIFFERENT sink: `apps/web/instrumentation-client.ts`'s FIX ROUND 1 F12
 * refuses SENTRY's OWN, separate Replay integration outright (never starts it) on exactly the
 * Stripe-return / token-bearing landings this residual matters most on, via `isSensitiveUrl`.
 * The two are independent SDKs with independent recorders, so this is two separate fixes on the
 * SAME predicate (`redactSensitivePath(url) !== url`) rather than one shared implementation —
 * `isSensitiveUrl` itself lives in `apps/web/src/lib/observability/sentry-scrub.ts`, out of
 * reach of this framework-agnostic package (see the module-scope note above on why
 * `@sentry/nextjs` cannot be a dependency here), so the predicate is replicated, not imported.
 */
export function sanitizeAnalyticsEvent(cr: CaptureResult | null): CaptureResult | null {
  if (cr === null) return null;
  const { properties } = cr;
  if (properties === undefined || properties === null) return cr;

  for (const key of URL_PROPERTY_KEYS) {
    const value = properties[key];
    if (typeof value === 'string') {
      properties[key] = redactSensitivePath(value);
    }
  }

  const setOnce: unknown = properties.$set_once;
  if (typeof setOnce === 'object' && setOnce !== null) {
    const setOnceBag = setOnce as Record<string, unknown>;
    for (const key of INITIAL_URL_PROPERTY_KEYS) {
      const value = setOnceBag[key];
      if (typeof value === 'string') {
        setOnceBag[key] = redactSensitivePath(value);
      }
    }
  }

  return cr;
}

/**
 * The landing URL, or `''` off-browser. `globalThis.*` over bare `window.*` (SonarCloud
 * S7764), and the same defensive `?? ''` shape `apps/web/instrumentation-client.ts` uses for
 * its own `currentHref()` — this function's `disable_session_recording` gate is the PostHog
 * twin of that file's Sentry Replay gate (FIX ROUND 3 R2, see `sanitizeAnalyticsEvent`'s G7
 * docblock above).
 */
function currentHref(): string {
  return globalThis.location?.href ?? '';
}

/**
 * FIX ROUND 3 R2 — replicates `apps/web/src/lib/observability/sentry-scrub.ts`'s
 * `isSensitiveUrl` predicate rather than importing it: that module is `apps/web`-only (it sits
 * behind no export this framework-agnostic, also-`apps/api`-consumed package may depend on —
 * see the module docblock on why `@sentry/nextjs` itself cannot be a dependency here), while
 * `@balo/shared/redaction` is already a dependency of this package. "Sensitive" is DERIVED,
 * never a second registry: a URL is sensitive exactly when redaction would change it, so this
 * cannot drift from `SENSITIVE_PATH_PREFIXES` / the Stripe query-param registry the way a
 * hand-copied prefix list would — identical reasoning to `isSensitiveUrl`'s own docblock.
 */
function isOnSensitiveLanding(): boolean {
  const href = currentHref();
  return redactSensitivePath(href) !== href;
}

export function initAnalytics(): void {
  if (globalThis.window === undefined || initialized) return;

  if (process.env.NEXT_PUBLIC_POSTHOG_KEY) {
    try {
      posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY, {
        api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST || 'https://app.posthog.com',
        capture_pageview: true,
        capture_pageleave: true,
        // Redact secret-bearing URLs (magic-link tokens, Stripe redirect-return params) before
        // any event is sent.
        before_send: sanitizeAnalyticsEvent,
        // FIX ROUND 1 F4 (security S1) — belt-and-braces WITH the `before_send` walk above, at
        // the SDK's own source rather than after the fact. Verified against posthog-js@1.335.3's
        // shipped dist: `mask_personal_data_properties` + `custom_personal_data_properties` gate
        // `ds()` (`ph_person_props.ts`'s initial-person-info builder), whose masked `u` (URL)
        // field feeds BOTH `set_initial_person_info` (→ `$set_once.$initial_current_url`) and
        // `sessionPropsManager.getSetOnceProps()` (→ `$session_entry_url`) — i.e. the SAME two
        // sinks the walk above targets, masked at the SOURCE before either bag is even assembled.
        // This means a future posthog-js upgrade that adds a THIRD "landing URL" property
        // derived from the same masked snapshot is covered by this ONE allowlist, not a fourth
        // hand-copied sink here.
        //
        // ⚠⚠ FIX ROUND 2 G4 — `mask_personal_data_properties: true` is NOT scoped to the five
        // custom params in `custom_personal_data_properties` below; per the shipped dist it ALSO
        // masks posthog-js's own DEFAULT list of 17 ad-click-id params (`gclid`, `gclsrc`,
        // `dclid`, `gbraid`, `wbraid`, `fbclid`, `msclkid`, `twclid`, `li_fat_id`, `igshid`,
        // `ttclid`, `rdt_cid`, `epik`, `qclid`, `sccid`, `irclid`, `_kx`) out of
        // `update_campaign_params()` / `set_initial_person_info()`, for EVERY user, on EVERY page
        // — so `$initial_gclid`, `$initial_fbclid`, etc. read `<masked>` platform-wide from this
        // PR onward. `utm_*` params are NOT affected (a different, unmasked code path). This is a
        // real, if narrow, ad-attribution behaviour change riding along with a Stripe-secret fix
        // — stated here so it is not a surprise to whoever next looks at attribution data. The
        // option is correct defence in depth and is NOT being removed for that reason.
        mask_personal_data_properties: true,
        custom_personal_data_properties: [
          ...STRIPE_SETUP_INTENT_RETURN_QUERY_PARAMS,
          'payment_intent',
          'payment_intent_client_secret',
        ],
        // FIX ROUND 3 R2 — refuse Session Replay outright (never start it) on a landing whose
        // URL `redactSensitivePath` would rewrite. See `sanitizeAnalyticsEvent`'s G7 docblock
        // above for why scrubbing is not an option for this sink.
        disable_session_recording: isOnSensitiveLanding(),
      });
    } catch (error) {
      // FIX ROUND 3 R1 — `posthog.init` is the one call in this module that used to be
      // unguarded. At MODULE SCOPE (`apps/web/src/components/providers/posthog-provider.tsx`'s
      // FIX ROUND 1 F3), a throw here would fail evaluation of a root-layout CLIENT BUNDLE —
      // every route, before first paint — which is a strictly worse blast radius than the
      // `useEffect` this replaced. Guarded the same shape as `track`/`identify`/`page`/`reset`
      // below, reported to the SAME reporter with `method: 'init'`.
      reportAnalyticsError(error, 'init');
    }
    initialized = true;
  }
}

export const analytics = {
  identify: (userId: string, traits?: Record<string, unknown>) => {
    // BAL-529 §A — analytics is a fire-and-forget side effect. The near-universal call shape is
    // `track(…); setPhase(…)`, so an escaping throw skips the state transition after it and
    // strands the user; in an async callback it escapes as an unhandled rejection with no
    // visible error at all. Found twice in BAL-526 on a payments surface.
    try {
      posthog.identify(userId, traits);
    } catch (error) {
      reportAnalyticsError(error, 'identify');
    }
  },

  track: (event: string, properties?: Record<string, unknown>) => {
    try {
      posthog.capture(event, properties);
    } catch (error) {
      reportAnalyticsError(error, 'track');
    }
  },

  page: (name?: string, properties?: Record<string, unknown>) => {
    try {
      posthog.capture('$pageview', { ...properties, page_name: name });
    } catch (error) {
      reportAnalyticsError(error, 'page');
    }
  },

  reset: () => {
    try {
      posthog.reset();
    } catch (error) {
      reportAnalyticsError(error, 'reset');
    }
  },
};

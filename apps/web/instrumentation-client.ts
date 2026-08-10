// This file configures the initialization of Sentry on the client.
// The added config here will be used whenever a users loads a page in their browser.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from '@sentry/nextjs';
// Relative, not the `@/` alias — see the note in `sentry.server.config.ts`.
import {
  isSensitiveUrl,
  scrubReplayRecordingEvent,
  scrubSentryEvent,
  sentryScrubbingOptions,
} from './src/lib/observability/sentry-scrub';

/** The landing URL, or `''` off-browser. `globalThis.*` over bare `window.*` (SonarCloud S7764). */
function currentHref(): string {
  return globalThis.location?.href ?? '';
}

/**
 * ⚠ SESSION REPLAY IS REFUSED OUTRIGHT ON A TOKEN-BEARING LANDING, rather than scrubbed.
 *
 * Scrubbing is not sufficient here and the reason is structural, verified against the SDK
 * rather than assumed. `beforeAddRecordingEvent` is applied by `maybeApplyCallback` only
 * `if (typeof callback === 'function' && isCustomEvent(event))` — custom (type 5) frames
 * ONLY. The rrweb META frame is type 4 and carries `data.href`, the full URL, past every
 * exposed callback. There is no hook that can reach it.
 *
 * Nor can we start and then stop: the integration's public `stop()` calls
 * `this._replay.stop({ forceFlush: this._replay.recordingMode === 'session' })`, so in
 * session mode stopping SENDS the buffered recording — actively transmitting the very token
 * we are trying to withhold. Never starting is the only airtight option.
 *
 * ⚠ AN INIT-TIME CHECK IS COMPLETE ONLY BECAUSE THESE PAGES ARE ENTERED BY DOCUMENT LOAD.
 * All three sensitive landings are emailed magic links and the raw token exists ONLY in
 * that email — `POST /meetings/:id/guests` deliberately never returns it (see that route's
 * contract point 4), so no UI can build one. A guest therefore arrives by hard navigation,
 * which is exactly when this module runs.
 *
 * For `/join/` that is ENFORCED, not merely true today: the existing invariant
 * `src/invariants/join-link-never-writes.test.ts` → "no <Link> anywhere in the app router
 * points at /join/…" scans the whole app router and fails on any in-app join URL. It was
 * written for the prefetch/Referer hazard, and this exclusion now leans on the same
 * property.
 *
 * ⚠ RESIDUAL, stated rather than papered over: `/review/` and `/shared/proposals/` have no
 * equivalent app-router scan (their invariant only covers their own route tree). Neither
 * has an in-app link today — verified — so the guarantee holds; but if one is ever added,
 * a client-side navigation into that page could let a later rrweb full-snapshot meta frame
 * record the URL. Extending that invariant's app-router scan to all of
 * `SENSITIVE_PATH_PREFIXES` is the fix if it comes up.
 */
const onSensitiveLanding = isSensitiveUrl(currentHref());

Sentry.init({
  dsn: process.env.SENTRY_DSN,

  // Add optional integrations for additional features
  integrations: onSensitiveLanding
    ? []
    : [Sentry.replayIntegration({ beforeAddRecordingEvent: scrubReplayRecordingEvent })],

  // Define how likely traces are sampled. Adjust this value in production, or use tracesSampler for greater control.
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1,

  // Define how likely Replay events are sampled.
  // This sets the sample rate to be 10%. You may want this to be 100% while
  // in development and sample at a lower rate in production
  replaysSessionSampleRate: 0.1,

  // Define how likely Replay events are sampled when an error occurs.
  replaysOnErrorSampleRate: 1.0,

  sendDefaultPii: process.env.NODE_ENV !== 'production',

  // ⚠ THE TOKEN-IN-URL SCRUBBERS (BAL-386 / BAL-390 / BAL-408). On the browser side the
  // always-on channels are `request.url` (filled from `location.href`) and the pageload
  // transaction's span attributes — neither of which needs an error to fire, and neither of
  // which is gated by `sendDefaultPii: false`.
  ...sentryScrubbingOptions,
});

// Catches event types the `beforeSend*` hooks never see — notably `replay_event`, whose
// `urls` array is assembled outside the `beforeSend` pipeline. See the helper's docblock.
Sentry.addEventProcessor(scrubSentryEvent);

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;

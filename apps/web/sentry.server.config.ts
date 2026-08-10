// This file configures the initialization of Sentry on the server.
// The config you add here will be used whenever the server handles a request.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from '@sentry/nextjs';
// Relative, not the `@/` alias: this file sits OUTSIDE `src/`, and the Sentry configs are
// loaded by Next's own bootstrap rather than through the app's module graph.
import { scrubSentryEvent, sentryScrubbingOptions } from './src/lib/observability/sentry-scrub';

Sentry.init({
  dsn: process.env.SENTRY_DSN,

  release: `balo-web@${process.env.NEXT_PUBLIC_APP_VERSION || '0.0.0'}-${process.env.NEXT_PUBLIC_COMMIT_SHA || 'dev'}`,

  // Define how likely traces are sampled. Adjust this value in production, or use tracesSampler for greater control.
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1,

  sendDefaultPii: process.env.NODE_ENV !== 'production',

  // ⚠ THE TOKEN-IN-URL SCRUBBERS (BAL-386 / BAL-390 / BAL-408). This runtime is where the
  // worst channel lives: `onRequestError` → `captureRequestError` sets
  // `contexts.nextjs.request_path` to the RESOLVED path, so any server-side throw inside
  // `/join/[token]/page.tsx` would otherwise ship the raw guest credential to Sentry.
  ...sentryScrubbingOptions,
});

// Catches event types the `beforeSend*` hooks never see. See the helper's docblock.
Sentry.addEventProcessor(scrubSentryEvent);

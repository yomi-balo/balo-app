// This file configures the initialization of Sentry for edge features (middleware, edge routes, and so on).
// The config you add here will be used whenever one of the edge features is loaded.
// Note that this config is unrelated to the Vercel Edge Runtime and is also required when running locally.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from '@sentry/nextjs';
// Relative, not the `@/` alias — see the note in `sentry.server.config.ts`.
import { scrubSentryEvent, sentryScrubbingOptions } from './src/lib/observability/sentry-scrub';

Sentry.init({
  dsn: process.env.SENTRY_DSN,

  release: `balo-web@${process.env.NEXT_PUBLIC_APP_VERSION || '0.0.0'}-${process.env.NEXT_PUBLIC_COMMIT_SHA || 'dev'}`,

  // Define how likely traces are sampled. Adjust this value in production, or use tracesSampler for greater control.
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1,

  sendDefaultPii: process.env.NODE_ENV !== 'production',

  // ⚠ THE TOKEN-IN-URL SCRUBBERS (BAL-386 / BAL-390 / BAL-408). The Edge runtime is what
  // executes `middleware.ts`, which sees EVERY request to `/join/{token}` — including the
  // ones it redirects — so an unscrubbed throw here leaks as readily as the Node runtime.
  ...sentryScrubbingOptions,
});

// Catches event types the `beforeSend*` hooks never see. See the helper's docblock.
Sentry.addEventProcessor(scrubSentryEvent);

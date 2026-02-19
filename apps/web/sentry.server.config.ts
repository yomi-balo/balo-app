// This file configures the initialization of Sentry on the server.
// The config you add here will be used whenever the server handles a request.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from '@sentry/nextjs';

Sentry.init({
  dsn: process.env.SENTRY_DSN,

  release: `balo-web@${process.env.NEXT_PUBLIC_APP_VERSION || '0.0.0'}-${process.env.NEXT_PUBLIC_COMMIT_SHA || 'dev'}`,

  // Define how likely traces are sampled. Adjust this value in production, or use tracesSampler for greater control.
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1,

  sendDefaultPii: process.env.NODE_ENV !== 'production',
});

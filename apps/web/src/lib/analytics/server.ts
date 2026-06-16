import 'server-only';

// Server-side analytics seam for the web app (RSC / Server Actions). Kept SEPARATE
// from the client `@/lib/analytics` barrel: `@balo/analytics/server` pulls in
// `posthog-node`, which must never reach a client bundle. The `server-only` guard
// turns an accidental client import into a build-time error. trackServer is a
// no-op when POSTHOG_API_KEY is unset (dev/CI/test).
export { trackServer, PROJECT_SERVER_EVENTS } from '@balo/analytics/server';

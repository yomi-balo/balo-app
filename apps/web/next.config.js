// next.config.js - balo-web
import { withSentryConfig } from '@sentry/nextjs';

/** @type {import('next').NextConfig} */
const nextConfig = {
  devIndicators: {
    position: 'bottom-right',
  },
  // BAL-385: the proposal-PDF Route Handler embeds Geist from disk at render time
  // (react-pdf can only use fonts it reads). These .ttf assets aren't statically
  // analyzable by file tracing, so include them explicitly in the function bundle.
  // BAL-441 reuses the same font files for the session receipt/payout PDFs — same landmine,
  // same fix: omitting a route here ships a PDF route that 500s on Vercel only (every local
  // gate passes without this).
  outputFileTracingIncludes: {
    '/projects/[requestId]/proposal/[relationshipId]/pdf': [
      './src/lib/project-request/proposal/pdf/fonts/*.ttf',
    ],
    '/sessions/[sessionId]/receipt/pdf': ['./src/lib/project-request/proposal/pdf/fonts/*.ttf'],
    '/sessions/[sessionId]/payout/pdf': ['./src/lib/project-request/proposal/pdf/fonts/*.ttf'],
  },
  /**
   * BAL-567 — THE FIRST `redirects()` BLOCK IN THIS FILE.
   *
   * `/consultations` was the "Coming soon" stub the Cases nav entry pointed at; `/cases` replaces
   * it. The old path survives as a PERMANENT (308) redirect because it is reachable from places
   * we do not control: bookmarks, a crumb still in someone's browser history, and any cached page
   * that still names it.
   *
   * ⚠ CONFIG-LEVEL, NOT A PAGE-LEVEL `permanentRedirect()`. Next runs `redirects()` BEFORE
   * middleware, so an unauthenticated hit is answered with a 308 without paying for the
   * auth/onboarding round trip, and without the chain a page-level version would produce
   * (`/consultations` → `/login?returnTo=/consultations` → `/consultations` → `/cases`).
   *
   * ⚠ `permanent: true` IS DELIBERATE. `/consultations` is not coming back — this ticket retires
   * the noun platform-wide — so telling caches and crawlers as much is the honest answer.
   */
  async redirects() {
    return [{ source: '/consultations', destination: '/cases', permanent: true }];
  },
  env: {
    NEXT_PUBLIC_APP_VERSION: process.env.npm_package_version || '0.0.0',
    NEXT_PUBLIC_COMMIT_SHA: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || 'dev',
    NEXT_PUBLIC_GIT_BRANCH: process.env.VERCEL_GIT_COMMIT_REF || 'local',
    NEXT_PUBLIC_BUILD_TIME: new Date().toISOString(),
  },
};

export default withSentryConfig(nextConfig, {
  // For all available options, see:
  // https://www.npmjs.com/package/@sentry/webpack-plugin#options
  org: 'balo-tecnologies',
  project: 'balo-web',

  // Only print logs for uploading source maps in CI
  silent: !process.env.CI && process.env.NODE_ENV === 'production',

  // For all available options, see:
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/

  // Upload a larger set of source maps for prettier stack traces (increases build time)
  widenClientFileUpload: true,

  // Uncomment to route browser requests to Sentry through a Next.js rewrite to circumvent ad-blockers.
  // This can increase your server load as well as your hosting bill.
  // Note: Check that the configured route will not match with your Next.js middleware, otherwise reporting of client-
  // side errors will fail.
  // tunnelRoute: "/monitoring",

  // Automatically instrument Vercel Cron Monitors
  automaticVercelMonitors: true,
});

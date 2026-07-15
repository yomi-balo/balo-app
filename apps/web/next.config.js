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
  outputFileTracingIncludes: {
    '/projects/[requestId]/proposal/[relationshipId]/pdf': [
      './src/lib/project-request/proposal/pdf/fonts/*.ttf',
    ],
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

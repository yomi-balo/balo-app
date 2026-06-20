import { PostHog } from 'posthog-node';

let instance: PostHog | null = null;

/**
 * Returns a PostHog Node SDK singleton.
 * Returns null when POSTHOG_API_KEY is not set (dev environments, CI).
 */
export function getServerAnalytics(): PostHog | null {
  if (instance) return instance;

  const apiKey = process.env.POSTHOG_API_KEY;
  if (!apiKey) return null;

  instance = new PostHog(apiKey, {
    host: process.env.POSTHOG_HOST || 'https://app.posthog.com',
    flushAt: 1,
    flushInterval: 0,
  });

  return instance;
}

/**
 * Gracefully shuts down the PostHog client, flushing pending events.
 * Call this on process SIGTERM / SIGINT.
 */
export async function shutdownServerAnalytics(): Promise<void> {
  if (instance) {
    await instance.shutdown();
    instance = null;
  }
}

/**
 * Flushes queued events WITHOUT closing the client (unlike shutdown()). Use in a
 * serverless / short-lived request context (e.g. a Next.js RSC via next/server
 * `after()`) so batched events are delivered before the function suspends — the
 * singleton is preserved for the next invocation. No-op when analytics is
 * disabled (no POSTHOG_API_KEY → no instance).
 */
export async function flushServerAnalytics(): Promise<void> {
  if (instance) {
    await instance.flush();
  }
}

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

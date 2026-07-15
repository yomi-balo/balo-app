import posthog from 'posthog-js';
import type { CaptureResult } from 'posthog-js';
import { redactSensitivePath } from '@balo/shared/redaction';

let initialized = false;

/** URL-shaped autocapture properties that may carry a secret-bearing path. */
const URL_PROPERTY_KEYS = ['$current_url', '$pathname', '$referrer'] as const;

/**
 * PostHog `before_send` hook (BAL-386). Autocapture ($pageview / $pageleave and the
 * rest) stamps the current URL onto every event; on the public `/shared/proposals/
 * {token}` page that URL carries the raw magic-link token. Rewrite the URL-shaped
 * properties through the SAME redaction used by the Edge middleware so the token
 * never leaves the browser. Returns the (possibly mutated) event; never drops it.
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
  return cr;
}

export function initAnalytics(): void {
  if (globalThis.window === undefined || initialized) return;

  if (process.env.NEXT_PUBLIC_POSTHOG_KEY) {
    posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY, {
      api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST || 'https://app.posthog.com',
      capture_pageview: true,
      capture_pageleave: true,
      // Redact secret-bearing URLs (magic-link tokens) before any event is sent.
      before_send: sanitizeAnalyticsEvent,
    });
    initialized = true;
  }
}

export const analytics = {
  identify: (userId: string, traits?: Record<string, unknown>) => {
    posthog.identify(userId, traits);
  },

  track: (event: string, properties?: Record<string, unknown>) => {
    posthog.capture(event, properties);
  },

  page: (name?: string, properties?: Record<string, unknown>) => {
    posthog.capture('$pageview', { ...properties, page_name: name });
  },

  reset: () => {
    posthog.reset();
  },
};

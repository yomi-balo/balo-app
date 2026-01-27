import posthog from 'posthog-js';

let initialized = false;

export function initAnalytics() {
  if (typeof window === 'undefined' || initialized) return;

  if (process.env.NEXT_PUBLIC_POSTHOG_KEY) {
    posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY, {
      api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST || 'https://app.posthog.com',
      capture_pageview: true,
      capture_pageleave: true,
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

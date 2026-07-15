import { describe, it, expect } from 'vitest';
import type { CaptureResult } from 'posthog-js';
import { sanitizeAnalyticsEvent } from './client';

function makeEvent(properties: Record<string, unknown>): CaptureResult {
  return {
    uuid: 'evt-1',
    event: '$pageview',
    properties: properties as CaptureResult['properties'],
  };
}

describe('sanitizeAnalyticsEvent', () => {
  it('redacts the token in $current_url, $pathname, and $referrer', () => {
    const result = sanitizeAnalyticsEvent(
      makeEvent({
        $current_url: 'https://balo.expert/shared/proposals/secretTok?x=1',
        $pathname: '/shared/proposals/secretTok',
        $referrer: 'https://balo.expert/shared/proposals/secretTok',
      })
    );

    expect(result?.properties.$current_url).toBe(
      'https://balo.expert/shared/proposals/[redacted]?x=1'
    );
    expect(result?.properties.$pathname).toBe('/shared/proposals/[redacted]');
    expect(result?.properties.$referrer).toBe('https://balo.expert/shared/proposals/[redacted]');
  });

  it('leaves a normal (non-secret) URL untouched', () => {
    const result = sanitizeAnalyticsEvent(
      makeEvent({ $current_url: 'https://balo.expert/experts/dana', $pathname: '/experts/dana' })
    );
    expect(result?.properties.$current_url).toBe('https://balo.expert/experts/dana');
    expect(result?.properties.$pathname).toBe('/experts/dana');
  });

  it('returns null when the event is null (never throws)', () => {
    expect(sanitizeAnalyticsEvent(null)).toBeNull();
  });

  it('ignores non-string URL properties', () => {
    const result = sanitizeAnalyticsEvent(makeEvent({ $current_url: undefined, other: 42 }));
    expect(result?.properties.other).toBe(42);
  });
});

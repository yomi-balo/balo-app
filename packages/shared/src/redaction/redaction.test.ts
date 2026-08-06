import { describe, it, expect } from 'vitest';
import { redactSensitivePath, SENSITIVE_PATH_PREFIXES } from './index';

describe('redactSensitivePath', () => {
  it('redacts the token segment after a sensitive prefix', () => {
    expect(redactSensitivePath('/shared/proposals/abc123DEF')).toBe('/shared/proposals/[redacted]');
  });

  it('redacts inside a full URL and preserves the query string', () => {
    expect(redactSensitivePath('https://balo.expert/shared/proposals/tok_9f?ref=email')).toBe(
      'https://balo.expert/shared/proposals/[redacted]?ref=email'
    );
  });

  it('preserves a trailing path segment after the token', () => {
    expect(redactSensitivePath('/shared/proposals/tok/extra')).toBe(
      '/shared/proposals/[redacted]/extra'
    );
  });

  it('preserves a fragment after the token', () => {
    expect(redactSensitivePath('/shared/proposals/tok#section')).toBe(
      '/shared/proposals/[redacted]#section'
    );
  });

  it('leaves the bare prefix (no token) untouched', () => {
    expect(redactSensitivePath('/shared/proposals/')).toBe('/shared/proposals/');
  });

  it('does not match the prefix without its trailing slash', () => {
    expect(redactSensitivePath('/shared/proposals')).toBe('/shared/proposals');
  });

  it('passes normal paths through unchanged', () => {
    expect(redactSensitivePath('/dashboard')).toBe('/dashboard');
    expect(redactSensitivePath('/projects/123/proposal/456')).toBe('/projects/123/proposal/456');
    expect(redactSensitivePath('https://balo.expert/experts/dana')).toBe(
      'https://balo.expert/experts/dana'
    );
  });

  it('handles an empty string', () => {
    expect(redactSensitivePath('')).toBe('');
  });

  describe('BAL-390 — the review landing token', () => {
    it('redacts the token segment', () => {
      expect(redactSensitivePath('/review/abc123DEF')).toBe('/review/[redacted]');
    });

    it('preserves the ?r= prefill while redacting the token', () => {
      // The whole point of segment-only redaction: the emailed-star funnel stays
      // legible in Axiom/PostHog without the token ever being written down.
      expect(redactSensitivePath('/review/tok_9f?r=3')).toBe('/review/[redacted]?r=3');
    });

    it('redacts inside a full URL (the PostHog $current_url / $referrer shape)', () => {
      expect(redactSensitivePath('https://balo.expert/review/tok_9f?r=5')).toBe(
        'https://balo.expert/review/[redacted]?r=5'
      );
    });

    it('leaves the bare prefix (no token) untouched', () => {
      expect(redactSensitivePath('/review/')).toBe('/review/');
    });

    it('does not touch look-alike paths', () => {
      expect(redactSensitivePath('/review')).toBe('/review');
      expect(redactSensitivePath('/reviews/123')).toBe('/reviews/123');
      expect(redactSensitivePath('/engagements/123')).toBe('/engagements/123');
    });
  });
});

describe('SENSITIVE_PATH_PREFIXES', () => {
  it('lists exactly the two token-bearing landings', () => {
    expect([...SENSITIVE_PATH_PREFIXES].sort((a, b) => a.localeCompare(b))).toEqual([
      '/review/',
      '/shared/proposals/',
    ]);
  });

  it('every prefix ends in a slash so a look-alike route cannot match', () => {
    for (const prefix of SENSITIVE_PATH_PREFIXES) {
      expect(prefix.startsWith('/')).toBe(true);
      expect(prefix.endsWith('/')).toBe(true);
    }
  });
});

import { describe, it, expect } from 'vitest';
import { redactSensitivePath } from './index';

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
});

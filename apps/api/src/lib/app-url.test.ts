import { describe, it, expect, afterEach } from 'vitest';
import { resolveAppUrl } from './app-url.js';

describe('resolveAppUrl', () => {
  const original = process.env.APP_URL;
  afterEach(() => {
    if (original === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = original;
  });

  it('joins APP_URL with the requested path', () => {
    process.env.APP_URL = 'https://app.balo.test';
    expect(resolveAppUrl('/billing/top-up')).toBe('https://app.balo.test/billing/top-up');
  });

  it('does not double the slash when APP_URL has a trailing one', () => {
    process.env.APP_URL = 'https://app.balo.test/';
    expect(resolveAppUrl('/billing/top-up')).toBe('https://app.balo.test/billing/top-up');
  });

  it('returns the bare origin when no path is asked for', () => {
    process.env.APP_URL = 'https://app.balo.test';
    expect(resolveAppUrl()).toBe('https://app.balo.test');
  });

  it('falls back to localhost:3000 when APP_URL is unset (local dev)', () => {
    delete process.env.APP_URL;
    expect(resolveAppUrl('/billing/top-up')).toBe('http://localhost:3000/billing/top-up');
  });
});

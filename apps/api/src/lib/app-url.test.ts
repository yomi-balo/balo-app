import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { assertAppUrlSetInProduction, resolveAppUrl } from './app-url.js';

const originalAppUrl = process.env.APP_URL;
const originalNodeEnv = process.env.NODE_ENV;

function restoreEnv(): void {
  if (originalAppUrl === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = originalAppUrl;
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
}

describe('resolveAppUrl', () => {
  afterEach(restoreEnv);

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

  it('falls back to localhost:3000 when APP_URL is unset in DEVELOPMENT', () => {
    delete process.env.APP_URL;
    process.env.NODE_ENV = 'development';
    expect(resolveAppUrl('/billing/top-up')).toBe('http://localhost:3000/billing/top-up');
  });

  it('THROWS in production when APP_URL is unset', () => {
    // ⚠ This value is the Stripe `return_url` on the money path. Falling back to localhost there
    // sends a buyer whose card has ALREADY been charged to a dead address, and nothing
    // server-side ever learns it happened.
    delete process.env.APP_URL;
    process.env.NODE_ENV = 'production';
    expect(() => resolveAppUrl('/billing/top-up')).toThrow(/APP_URL is not set/);
  });

  it('THROWS in production when APP_URL is BLANK (Railway shape for an unset var)', () => {
    // `??` is NULLISH, so a blank string did NOT trip the localhost fallback — it produced the
    // bare relative `return_url: "/billing/top-up"`, which Stripe rejects. A naive
    // "throw when undefined" fix would still pass the test above and fail this one.
    process.env.APP_URL = '   ';
    process.env.NODE_ENV = 'production';
    expect(() => resolveAppUrl('/billing/top-up')).toThrow(/APP_URL is not set/);
  });

  it('trims a padded APP_URL rather than folding the padding into the origin', () => {
    process.env.APP_URL = '  https://app.balo.test  ';
    expect(resolveAppUrl('/billing/top-up')).toBe('https://app.balo.test/billing/top-up');
  });
});

describe('resolveAppUrl — the PATH cannot move the origin (BAL-515 / security MEDIUM-3)', () => {
  afterEach(restoreEnv);

  beforeEach(() => {
    process.env.APP_URL = 'https://app.balo.test';
  });

  // ⚠ EACH OF THESE PRODUCED A LIVE OPEN REDIRECT BEFORE THE GUARD, on a value that is a Stripe
  // `return_url`. Without the guard every one of them RESOLVES to a string rather than throwing,
  // and the expected host below shows where a browser would actually land.
  it.each([
    ['//evil.com', 'protocol-relative — the browser goes to evil.com'],
    ['/\\evil.com', 'backslash variant — browsers normalise it to //'],
    ['@evil.com', 'userinfo trick — everything before the @ is discarded as credentials'],
    ['https://evil.com', 'a whole replacement origin'],
    ['billing/top-up', 'relative — silently glues onto the host with no separator'],
  ])('REFUSES the path %j (%s)', (path) => {
    expect(() => resolveAppUrl(path)).toThrow(/must be empty or a same-origin path/);
  });

  it('still accepts an ordinary same-origin path, with a query string', () => {
    expect(resolveAppUrl('/billing/top-up?status=done')).toBe(
      'https://app.balo.test/billing/top-up?status=done'
    );
  });

  it('still accepts the empty path (the bare origin)', () => {
    expect(resolveAppUrl('')).toBe('https://app.balo.test');
  });
});

describe('assertAppUrlSetInProduction', () => {
  afterEach(restoreEnv);

  it('throws at boot in production when APP_URL is unset', () => {
    delete process.env.APP_URL;
    process.env.NODE_ENV = 'production';
    expect(() => assertAppUrlSetInProduction()).toThrow(/APP_URL must be set in production/);
  });

  it('throws at boot in production when APP_URL is blank', () => {
    process.env.APP_URL = '';
    process.env.NODE_ENV = 'production';
    expect(() => assertAppUrlSetInProduction()).toThrow(/APP_URL must be set in production/);
  });

  it('is a no-op in production when APP_URL is set', () => {
    process.env.APP_URL = 'https://app.balo.test';
    process.env.NODE_ENV = 'production';
    expect(() => assertAppUrlSetInProduction()).not.toThrow();
  });

  // ⚠ PRESENCE IS NOT SHAPE. Each of these is a NON-EMPTY `APP_URL` that satisfied the old
  // presence check and then produced a `return_url` Stripe rejects — a config typo surfacing as a
  // 400 the moment a buyer clicks Pay, instead of a refusal to boot.
  it.each([
    ['app.balo.test', 'a bare host with no scheme'],
    ['//app.balo.test', 'protocol-relative, not absolute'],
    ['/billing', 'a path, not an origin'],
    ['javascript:alert(1)', 'parseable by URL, but not an http(s) origin'],
    ['file:///etc/passwd', 'ditto — the protocol check is what rejects it'],
  ])('THROWS at boot in production when APP_URL is %j (%s)', (value) => {
    process.env.APP_URL = value;
    process.env.NODE_ENV = 'production';
    expect(() => assertAppUrlSetInProduction()).toThrow(/must be an absolute http\(s\) URL/);
  });

  it('accepts a plain http origin (local/staging deployments are not https)', () => {
    process.env.APP_URL = 'http://localhost:3000';
    process.env.NODE_ENV = 'production';
    expect(() => assertAppUrlSetInProduction()).not.toThrow();
  });

  it('is a no-op in development even with APP_URL unset (local dev must still boot)', () => {
    delete process.env.APP_URL;
    process.env.NODE_ENV = 'development';
    expect(() => assertAppUrlSetInProduction()).not.toThrow();
  });
});

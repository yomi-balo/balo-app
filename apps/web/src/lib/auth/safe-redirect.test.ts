import { describe, it, expect, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { getSafeRedirectPath } from './safe-redirect';

const BASE_URL = 'http://localhost:3000/api/auth/session-sync';

describe('getSafeRedirectPath', () => {
  it('defaults to /dashboard when returnTo is null', () => {
    expect(getSafeRedirectPath(null, BASE_URL)).toBe('/dashboard');
  });

  it('defaults to /dashboard when returnTo is empty string', () => {
    expect(getSafeRedirectPath('', BASE_URL)).toBe('/dashboard');
  });

  it('rejects an absolute URL to another origin (open redirect)', () => {
    expect(getSafeRedirectPath('https://evil.com', BASE_URL)).toBe('/dashboard');
  });

  it('rejects a protocol-relative URL', () => {
    expect(getSafeRedirectPath('//evil.com', BASE_URL)).toBe('/dashboard');
  });

  // ── Dot-segment smuggling — the VERIFIED bypass ───────────────────────────────────────
  // `https://evil.com` was never the bypass; it fails the origin check. These DID pass it:
  // WHATWG dot-segment removal makes `new URL(x, base)` SAME-ORIGIN with a `pathname` of
  // `//evil.com`, which the caller then re-parses as protocol-relative → attacker origin.
  describe.each([
    ['/.//evil.com'],
    ['/..//evil.com'],
    ['/x/..//evil.com'],
    ['/a/b/../..//evil.com'],
    ['/././/evil.com'],
  ])('dot-segment smuggling %j', (payload) => {
    it('resolves to the default redirect, never a protocol-relative path', () => {
      const result = getSafeRedirectPath(payload, BASE_URL);
      expect(result).toBe('/dashboard');
      expect(result.startsWith('//')).toBe(false);
    });
  });

  // Forms that were ALREADY blocked — pinned so the new guard cannot regress them.
  describe.each([
    ['///evil.com'],
    ['/\\evil.com'],
    ['\\\\evil.com'],
    ['https:/evil.com'],
    ['%2F%2Fevil.com'],
    ['%2f%2fevil.com'],
    ['\t//evil.com'],
    ['\n//evil.com'],
    [' //evil.com'],
    ['\u0000//evil.com'],
  ])('already-blocked form %j', (payload) => {
    it('still resolves to the default redirect', () => {
      const result = getSafeRedirectPath(payload, BASE_URL);
      expect(result).toBe('/dashboard');
      expect(result.startsWith('//')).toBe(false);
    });
  });

  it('never returns a value that re-parses to a foreign origin', () => {
    const payloads = [
      '/.//evil.com',
      '/..//evil.com',
      '/x/..//evil.com',
      '//evil.com',
      '///evil.com',
      'https://evil.com',
      ' //evil.com',
      '/%2F%2Fevil.com',
      '/projects/123',
    ];
    for (const payload of payloads) {
      const safe = getSafeRedirectPath(payload, BASE_URL);
      expect(new URL(safe, BASE_URL).origin).toBe('http://localhost:3000');
    }
  });

  it('rejects a path pointing to /login', () => {
    expect(getSafeRedirectPath('/login', BASE_URL)).toBe('/dashboard');
  });

  it('rejects a path pointing to /signup', () => {
    expect(getSafeRedirectPath('/signup', BASE_URL)).toBe('/dashboard');
  });

  it('rejects a path pointing to /api/auth (prevents a switch/sync redirect loop)', () => {
    expect(getSafeRedirectPath('/api/auth/switch-workspace', BASE_URL)).toBe('/dashboard');
  });

  it('accepts a normal same-origin relative path', () => {
    expect(getSafeRedirectPath('/projects/123', BASE_URL)).toBe('/projects/123');
  });

  it('normalizes a backslash to a forward slash (still same-origin)', () => {
    expect(getSafeRedirectPath('/foo\\bar', BASE_URL)).toBe('/foo/bar');
  });

  it('falls back to /dashboard on an unparseable value', () => {
    // A leading space is enough to make `new URL(returnTo, baseUrl)` behave unexpectedly for
    // some inputs; this pins the try/catch fallback regardless of the exact failure mode.
    expect(getSafeRedirectPath('http://[invalid', BASE_URL)).toBe('/dashboard');
  });
});

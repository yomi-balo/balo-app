import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  signConnectState,
  verifyConnectState,
  readStatePayloadUnverified,
  extractCookieValue,
  buildClearConnectNonceCookieHeader,
  buildClearAllConnectNonceCookieHeaders,
  calendarConnectNonceCookieName,
  calendarConnectCookieDomain,
} from './connect-state.js';

const CONNECT_NONCE_COOKIE_NAME = calendarConnectNonceCookieName('google');

const ORIGINAL_ENV = { ...process.env };

describe('connect-state (BAL-396 §10.3)', () => {
  beforeEach(() => {
    process.env.INTERNAL_API_SECRET = 'test-secret';
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.useRealTimers();
  });

  it('round-trips expertProfileId and provider', () => {
    const state = signConnectState('expert-1', 'exp-provider-a');
    const payload = verifyConnectState(state);
    expect(payload.expertProfileId).toBe('expert-1');
    expect(payload.provider).toBe('exp-provider-a');
    expect(typeof payload.nonce).toBe('string');
    expect(payload.nonce.length).toBeGreaterThan(0);
  });

  it('two states for the same (expert, provider) carry different nonces', () => {
    const a = signConnectState('expert-1', 'exp-provider-a');
    const b = signConnectState('expert-1', 'exp-provider-a');
    expect(a).not.toBe(b);
  });

  it('rejects a tampered payload', () => {
    const state = signConnectState('expert-1', 'exp-provider-a');
    const [, hmac] = state.split('.');
    const tamperedPayload = Buffer.from(
      JSON.stringify({
        expertProfileId: 'attacker',
        provider: 'exp-provider-a',
        nonce: 'x',
        ts: Date.now(),
      })
    ).toString('base64url');
    expect(() => verifyConnectState(`${tamperedPayload}.${hmac}`)).toThrow(
      'Invalid state signature'
    );
  });

  it('rejects a malformed state (wrong part count)', () => {
    expect(() => verifyConnectState('only-one-part')).toThrow('Invalid state format');
  });

  it('rejects an expired state', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const state = signConnectState('expert-1', 'exp-provider-a');
    vi.setSystemTime(new Date('2026-01-01T00:11:00Z')); // 11 minutes later, past the 10-min TTL
    expect(() => verifyConnectState(state)).toThrow('State has expired');
  });

  it('throws when INTERNAL_API_SECRET is unset', () => {
    delete process.env.INTERNAL_API_SECRET;
    expect(() => signConnectState('expert-1', 'exp-provider-a')).toThrow(
      'INTERNAL_API_SECRET is not configured'
    );
  });

  describe('readStatePayloadUnverified', () => {
    it('extracts expertProfileId and provider WITHOUT verifying the signature (even from a tampered state)', () => {
      const state = signConnectState('expert-1', 'exp-provider-a');
      const [payloadB64] = state.split('.');
      const tampered = `${payloadB64}.not-a-real-signature`;
      expect(readStatePayloadUnverified(tampered)).toEqual({
        expertProfileId: 'expert-1',
        provider: 'exp-provider-a',
      });
    });

    it('returns an empty object for a garbage string', () => {
      expect(readStatePayloadUnverified('not-base64-at-all!!')).toEqual({});
    });

    it('returns partial fields when the payload only has one of them', () => {
      const payloadB64 = Buffer.from(JSON.stringify({ expertProfileId: 'e' })).toString(
        'base64url'
      );
      expect(readStatePayloadUnverified(`${payloadB64}.sig`)).toEqual({
        expertProfileId: 'e',
        provider: undefined,
      });
    });
  });

  // ── BAL-396 fix round, Finding 1 — the CSRF binding cookie helpers ─────────────────────

  describe('extractCookieValue', () => {
    it('extracts the named cookie from a multi-cookie header', () => {
      const header = `foo=bar; ${CONNECT_NONCE_COOKIE_NAME}=abc-123; other=xyz`;
      expect(extractCookieValue(header, CONNECT_NONCE_COOKIE_NAME)).toBe('abc-123');
    });

    it('returns undefined when the header is undefined', () => {
      expect(extractCookieValue(undefined, CONNECT_NONCE_COOKIE_NAME)).toBeUndefined();
    });

    it('returns undefined when the named cookie is absent', () => {
      expect(extractCookieValue('foo=bar; other=xyz', CONNECT_NONCE_COOKIE_NAME)).toBeUndefined();
    });

    it('returns undefined for an empty value', () => {
      expect(
        extractCookieValue(`${CONNECT_NONCE_COOKIE_NAME}=`, CONNECT_NONCE_COOKIE_NAME)
      ).toBeUndefined();
    });

    it(
      '⚠ BAL-396 fix round 2, Finding 4 — returns the RAW value, no decoding. The nonce is ' +
        'always a crypto.randomUUID(), which needs no percent-decoding; decoding was pure ' +
        'liability, since this cookie is attacker-writable text on a public route (INVERTS the ' +
        'prior "decodes a URI-encoded value" test, which pinned the defect)',
      () => {
        const header = `${CONNECT_NONCE_COOKIE_NAME}=${encodeURIComponent('a b')}`;
        expect(extractCookieValue(header, CONNECT_NONCE_COOKIE_NAME)).toBe('a%20b');
      }
    );

    it(
      '⚠ BAL-396 fix round 2, Finding 4 — a malformed percent-sequence never throws. Before ' +
        'this fix, `decodeURIComponent` on this exact value threw an unhandled URIError on a ' +
        "public, unauthenticated route (`GET /auth/apiroc/callback`'s cookie read sat outside " +
        "that route's own try/catch), so a victim's legitimate callback failed as an opaque " +
        '500 instead of the clean state_csrf_mismatch redirect a genuine mismatch produces',
      () => {
        const header = `${CONNECT_NONCE_COOKIE_NAME}=%E0%A4%A`;
        expect(() => extractCookieValue(header, CONNECT_NONCE_COOKIE_NAME)).not.toThrow();
        expect(extractCookieValue(header, CONNECT_NONCE_COOKIE_NAME)).toBe('%E0%A4%A');
      }
    );

    it('handles a single-cookie header with no surrounding entries', () => {
      expect(
        extractCookieValue(`${CONNECT_NONCE_COOKIE_NAME}=solo`, CONNECT_NONCE_COOKIE_NAME)
      ).toBe('solo');
    });
  });

  describe('buildClearConnectNonceCookieHeader', () => {
    it('clears with Max-Age=0, HttpOnly, and SameSite=Lax', () => {
      const header = buildClearConnectNonceCookieHeader(undefined, 'google');
      expect(header).toContain(`${CONNECT_NONCE_COOKIE_NAME}=;`);
      expect(header).toContain('Max-Age=0');
      expect(header).toContain('HttpOnly');
      expect(header).toContain('SameSite=Lax');
    });

    it(
      'BAL-396 fix round 2, Finding 5 — scopes the cleared cookie by provider, so clearing ' +
        "google's cookie never touches microsoft's",
      () => {
        const googleHeader = buildClearConnectNonceCookieHeader(undefined, 'google');
        const microsoftHeader = buildClearConnectNonceCookieHeader(undefined, 'microsoft');
        expect(googleHeader).toContain(`${calendarConnectNonceCookieName('google')}=;`);
        expect(microsoftHeader).toContain(`${calendarConnectNonceCookieName('microsoft')}=;`);
        expect(googleHeader).not.toContain(calendarConnectNonceCookieName('microsoft'));
      }
    );

    it('omits Domain when no hostname is given (dev fallback)', () => {
      expect(buildClearConnectNonceCookieHeader(undefined, 'google')).not.toContain('Domain=');
    });

    it('sets Domain to the given hostname so apps/api can clear a cookie apps/web set', () => {
      expect(buildClearConnectNonceCookieHeader('balo.expert', 'google')).toContain(
        'Domain=balo.expert'
      );
    });

    it(
      'is a dumb builder — it no longer special-cases "localhost" itself. That exclusion now ' +
        'lives ONCE in calendarConnectCookieDomain() (@balo/shared/calendar), which every ' +
        "caller (including this file's callers in routes/calendar/auth.ts) must go through; " +
        'a caller that hands this function "localhost" directly gets a literal Domain=localhost.',
      () => {
        expect(buildClearConnectNonceCookieHeader('localhost', 'google')).toContain(
          'Domain=localhost'
        );
      }
    );
  });

  describe('buildClearAllConnectNonceCookieHeaders', () => {
    it(
      'BAL-396 fix round 2, Finding 5 — returns one header per provider, used whenever the ' +
        'callback cannot trust which provider is in flight',
      () => {
        const headers = buildClearAllConnectNonceCookieHeaders(undefined);
        expect(headers).toHaveLength(2);
        expect(headers.some((h) => h.includes(calendarConnectNonceCookieName('google')))).toBe(
          true
        );
        expect(headers.some((h) => h.includes(calendarConnectNonceCookieName('microsoft')))).toBe(
          true
        );
      }
    );
  });

  describe('calendarConnectCookieDomain (re-exported from @balo/shared/calendar)', () => {
    it(
      'BAL-396 fix round 2, Finding 1(c) — is the SAME function apps/web imports, not a ' +
        're-derivation, so the two sides cannot disagree the way the hand-duplicated versions did',
      () => {
        process.env.APP_URL = 'https://api.balo.expert';
        expect(calendarConnectCookieDomain()).toBe('api.balo.expert');
        delete process.env.APP_URL;
      }
    );
  });
});

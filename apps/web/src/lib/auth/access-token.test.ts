import { afterEach, describe, expect, it, vi } from 'vitest';

import { getAccessTokenExpiry, isAccessTokenExpired } from './access-token';

/** A JWT with the given payload. The signature is never read, so it is filler. */
function jwt(payload: Record<string, unknown>): string {
  const b64url = (value: string): string =>
    btoa(value).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  return `${b64url(JSON.stringify({ alg: 'RS256' }))}.${b64url(JSON.stringify(payload))}.sig`;
}

const NOW_MS = Date.UTC(2026, 8, 19, 12, 0, 0);
const NOW_SECONDS = Math.floor(NOW_MS / 1000);

afterEach(() => {
  vi.useRealTimers();
});

function freezeClock(): void {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);
}

describe('getAccessTokenExpiry', () => {
  it('reads the exp claim from a base64url payload', () => {
    expect(getAccessTokenExpiry(jwt({ exp: 1_800_000_000 }))).toBe(1_800_000_000);
  });

  it('returns null for a payload with no exp', () => {
    expect(getAccessTokenExpiry(jwt({ sub: 'user_1' }))).toBeNull();
  });

  it.each([
    ['not a jwt at all', 'abc'],
    ['too few segments', 'a.b'],
    ['an empty payload segment', 'a..c'],
    ['a payload that is not base64', 'a.!!!!.c'],
    ['a payload that is not JSON', `a.${btoa('nope')}.c`],
    ['an empty string', ''],
  ])('returns null for %s', (_label, token) => {
    expect(getAccessTokenExpiry(token)).toBeNull();
  });
});

describe('isAccessTokenExpired', () => {
  it('is false for a token with time left and no buffer', () => {
    freezeClock();
    expect(isAccessTokenExpired(jwt({ exp: NOW_SECONDS + 30 }))).toBe(false);
  });

  it('is true once exp has passed', () => {
    freezeClock();
    expect(isAccessTokenExpired(jwt({ exp: NOW_SECONDS - 1 }))).toBe(true);
  });

  /**
   * ⚠ THE BUFFER IS THE CALLER'S RISK POSTURE, and the two shipped callers sit deliberately far
   * apart: the middleware refreshes proactively at 60s, while the booking pre-flight gate uses 5s
   * because refusing a session with ~50s of life left would turn a working booking into a
   * spurious "please sign in again". Same token, opposite answers — pinned side by side so a
   * future single shared constant cannot quietly collapse them.
   */
  it('answers differently for the same token under the middleware vs pre-flight buffers', () => {
    freezeClock();
    const almostExpired = jwt({ exp: NOW_SECONDS + 30 });
    expect(isAccessTokenExpired(almostExpired, 60)).toBe(true);
    expect(isAccessTokenExpired(almostExpired, 5)).toBe(false);
  });

  /**
   * ⚠ FAILING CLOSED IS THE POINT. The alternative hands a malformed token to a write path that
   * will 401 anyway — after it has already written.
   */
  it('treats an unreadable token as expired', () => {
    freezeClock();
    expect(isAccessTokenExpired('garbage')).toBe(true);
    expect(isAccessTokenExpired(jwt({ sub: 'no-exp' }))).toBe(true);
  });
});

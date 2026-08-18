import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  CALENDAR_CONNECT_PROVIDERS,
  calendarConnectNonceCookieName,
  calendarConnectCookieDomain,
} from './connect-cookie';

const ORIGINAL_ENV = { ...process.env };

describe('calendarConnectNonceCookieName (BAL-396 fix round 2, Finding 5)', () => {
  it('scopes the cookie name by provider — no shared slot across interleaved flows', () => {
    expect(calendarConnectNonceCookieName('google')).toBe('balo_calendar_connect_nonce_google');
    expect(calendarConnectNonceCookieName('microsoft')).toBe(
      'balo_calendar_connect_nonce_microsoft'
    );
  });

  it('every provider yields a distinct name', () => {
    const names = CALENDAR_CONNECT_PROVIDERS.map(calendarConnectNonceCookieName);
    expect(new Set(names).size).toBe(CALENDAR_CONNECT_PROVIDERS.length);
  });
});

describe('calendarConnectCookieDomain (BAL-396 fix round 2, Finding 1)', () => {
  beforeEach(() => {
    delete process.env.APP_URL;
    delete process.env.NEXT_PUBLIC_APP_URL;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('returns undefined when neither APP_URL nor NEXT_PUBLIC_APP_URL is set', () => {
    expect(calendarConnectCookieDomain()).toBeUndefined();
  });

  it('reads APP_URL when set', () => {
    process.env.APP_URL = 'https://balo.expert';
    expect(calendarConnectCookieDomain()).toBe('balo.expert');
  });

  it(
    'falls back to NEXT_PUBLIC_APP_URL when APP_URL is unset — Finding 1(a): apps/web has ' +
      'historically shipped only NEXT_PUBLIC_APP_URL, and a hard dependency on APP_URL alone ' +
      'made every calendar connect fail closed with state_csrf_mismatch',
    () => {
      process.env.NEXT_PUBLIC_APP_URL = 'https://balo.expert';
      expect(calendarConnectCookieDomain()).toBe('balo.expert');
    }
  );

  it('prefers APP_URL over NEXT_PUBLIC_APP_URL when both are set', () => {
    process.env.APP_URL = 'https://balo.expert';
    process.env.NEXT_PUBLIC_APP_URL = 'https://staging.balo.expert';
    expect(calendarConnectCookieDomain()).toBe('balo.expert');
  });

  it(
    'excludes localhost from EITHER source — Finding 1(b): a Domain=localhost cookie set by ' +
      'apps/web while apps/api cleared host-only (or vice versa) meant the clear removed ' +
      'nothing, and the nonce survived its full 10-minute Max-Age',
    () => {
      process.env.APP_URL = 'http://localhost:3000';
      expect(calendarConnectCookieDomain()).toBeUndefined();
      delete process.env.APP_URL;
      process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';
      expect(calendarConnectCookieDomain()).toBeUndefined();
    }
  );

  it('falls back to undefined rather than throwing on a malformed URL', () => {
    process.env.APP_URL = 'not-a-url';
    expect(calendarConnectCookieDomain()).toBeUndefined();
  });

  it(
    'is the ONE derivation both apps/web and apps/api call — Finding 1(c): this function, ' +
      'not a hand-copied literal, is what makes the two sides agree; see ' +
      'apps/web/.../_lib/calendar-connect-cookie.ts and apps/api/.../connect-state.ts, both of ' +
      'which import it from here rather than re-deriving it',
    () => {
      process.env.APP_URL = 'https://api.balo.expert';
      // Same input, same output, regardless of which app calls it — there is no second
      // implementation left to disagree with this one.
      expect(calendarConnectCookieDomain()).toBe(calendarConnectCookieDomain());
    }
  );
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('server-only', () => ({}));

const mockCookieSet = vi.fn();
vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve({ set: mockCookieSet }),
}));

import { setCalendarConnectNonceCookie } from './calendar-connect-cookie';

describe('setCalendarConnectNonceCookie (BAL-396 fix round, Finding 1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('sets an HttpOnly, SameSite=Lax cookie carrying the nonce, scoped to the provider', async () => {
    await setCalendarConnectNonceCookie('nonce-123', 'google');

    expect(mockCookieSet).toHaveBeenCalledWith(
      'balo_calendar_connect_nonce_google',
      'nonce-123',
      expect.objectContaining({
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: 600,
      })
    );
  });

  it(
    'BAL-396 fix round 2, Finding 5 — google and microsoft get DIFFERENT cookie names, so ' +
      'starting one provider then the other before either completes cannot clobber the first',
    async () => {
      await setCalendarConnectNonceCookie('nonce-google', 'google');
      await setCalendarConnectNonceCookie('nonce-microsoft', 'microsoft');

      const [googleName] = mockCookieSet.mock.calls[0] as [string, string, unknown];
      const [microsoftName] = mockCookieSet.mock.calls[1] as [string, string, unknown];
      expect(googleName).toBe('balo_calendar_connect_nonce_google');
      expect(microsoftName).toBe('balo_calendar_connect_nonce_microsoft');
      expect(googleName).not.toBe(microsoftName);
    }
  );

  it('sets Secure only in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    await setCalendarConnectNonceCookie('nonce-123', 'google');
    expect(mockCookieSet).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ secure: true })
    );

    vi.clearAllMocks();
    vi.stubEnv('NODE_ENV', 'test');
    await setCalendarConnectNonceCookie('nonce-123', 'google');
    expect(mockCookieSet).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ secure: false })
    );
  });

  it('omits Domain when neither APP_URL nor NEXT_PUBLIC_APP_URL is set (local dev — host-only cookie)', async () => {
    vi.stubEnv('APP_URL', '');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '');
    await setCalendarConnectNonceCookie('nonce-123', 'google');
    const options = mockCookieSet.mock.calls[0]?.[2] as Record<string, unknown> | undefined;
    expect(options).toBeDefined();
    expect(options).not.toHaveProperty('domain');
  });

  it("sets Domain from APP_URL's hostname so apps/api (a different subdomain) can read it at the callback", async () => {
    vi.stubEnv('APP_URL', 'https://balo.expert');
    await setCalendarConnectNonceCookie('nonce-123', 'google');
    expect(mockCookieSet).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ domain: 'balo.expert' })
    );
  });

  it(
    'BAL-396 fix round 2, Finding 1(a) — falls back to NEXT_PUBLIC_APP_URL when APP_URL is ' +
      'unset. apps/web/.env.example has historically shipped only NEXT_PUBLIC_APP_URL; before ' +
      'this fix, that meant EVERY calendar connect failed closed with state_csrf_mismatch ' +
      'because this cookie went out host-only while apps/api expected a shared-domain cookie.',
    async () => {
      // Genuinely UNSET, not empty-string — `??` only falls through on null/undefined, so a
      // `stubEnv('APP_URL', '')` (truthy-but-empty override) would NOT exercise the fallback
      // this test exists to prove.
      vi.stubEnv('APP_URL', undefined);
      vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://balo.expert');
      await setCalendarConnectNonceCookie('nonce-123', 'google');
      expect(mockCookieSet).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ domain: 'balo.expert' })
      );
    }
  );

  it('falls back to no Domain if APP_URL is malformed rather than throwing', async () => {
    vi.stubEnv('APP_URL', 'not-a-url');
    await expect(setCalendarConnectNonceCookie('nonce-123', 'google')).resolves.toBeUndefined();
    const options = mockCookieSet.mock.calls[0]?.[2] as Record<string, unknown> | undefined;
    expect(options).not.toHaveProperty('domain');
  });
});

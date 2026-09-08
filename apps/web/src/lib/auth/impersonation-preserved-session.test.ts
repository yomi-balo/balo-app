import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('server-only', () => ({}));

// The real `sessionConfig.password` is `process.env.WORKOS_COOKIE_PASSWORD`, which is unset in
// the test env. Mock the module (not the env var) so the seal/unseal round trip below is REAL
// iron-session work against a deterministic, sufficiently long password — the `switch-token.test.ts`
// precedent.
const { TEST_PASSWORD } = vi.hoisted(() => ({
  TEST_PASSWORD: 'impersonation-preserved-session-test-password-0123456789',
}));
vi.mock('@/lib/auth/session-config', () => ({
  COOKIE_NAME: 'balo_session',
  sessionConfig: { password: TEST_PASSWORD, cookieName: 'balo_session', cookieOptions: {} },
  IMPERSONATED_SESSION_MAX_AGE_SECONDS: 60 * 30,
}));

vi.mock('@/lib/logging', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const mockCookieStore = {
  get: vi.fn(),
  set: vi.fn(),
  delete: vi.fn(),
};
vi.mock('next/headers', () => ({
  cookies: vi.fn(() => Promise.resolve(mockCookieStore)),
}));

import { sealData } from 'iron-session';
import {
  PRESERVED_ADMIN_COOKIE,
  IMPERSONATION_PRESERVED_ADMIN_SEAL_PURPOSE,
  sealPreservedAdminSession,
  unsealPreservedAdminSession,
  writePreservedAdminCookie,
  readPreservedAdminCookie,
  clearPreservedAdminCookie,
} from './impersonation-preserved-session';
import type { SessionData } from './session';

const IMPERSONATED_SESSION_MAX_AGE_SECONDS = 60 * 30;
const IRON_CLOCK_SKEW_SECONDS = 60;

const SESSION_DATA: SessionData = {
  user: {
    id: 'admin-1',
    email: 'admin@balo.com',
    firstName: 'Ada',
    lastName: 'Admin',
    avatarUrl: null,
    activeMode: 'client',
    onboardingCompleted: true,
    platformRole: 'super_admin',
    companyId: 'company-1',
    companyName: 'Balo Staff',
    companyRole: 'owner',
  },
  accessToken: 'access-token-value',
  refreshToken: 'refresh-token-value',
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('sealPreservedAdminSession / unsealPreservedAdminSession', () => {
  it('round-trips the full SessionData (user + both tokens)', async () => {
    const sealed = await sealPreservedAdminSession(SESSION_DATA);
    expect(sealed).toEqual(expect.any(String));
    // The wire format must not leak the tokens in plaintext.
    expect(sealed).not.toContain('access-token-value');
    expect(sealed).not.toContain('refresh-token-value');

    await expect(unsealPreservedAdminSession(sealed)).resolves.toEqual(SESSION_DATA);
  });

  it('returns null for a garbage seal', async () => {
    await expect(unsealPreservedAdminSession('not-a-seal')).resolves.toBeNull();
  });

  it('returns null for a TAMPERED seal (bad hmac)', async () => {
    const sealed = await sealPreservedAdminSession(SESSION_DATA);
    const tampered = sealed.slice(0, -6) + 'AAAAAA';
    await expect(unsealPreservedAdminSession(tampered)).resolves.toBeNull();
  });

  it('returns null for a seal made with a DIFFERENT password (unforgeable)', async () => {
    const foreign = await sealData(SESSION_DATA, {
      password: 'a-completely-different-password-0123456789abcd',
      ttl: IMPERSONATED_SESSION_MAX_AGE_SECONDS,
    });
    await expect(unsealPreservedAdminSession(foreign)).resolves.toBeNull();
  });

  it('returns null for a malformed payload with no user.id', async () => {
    const malformed = await sealData(
      { user: { email: 'no-id@example.com' }, accessToken: 'at', refreshToken: 'rt' },
      { password: TEST_PASSWORD, ttl: IMPERSONATED_SESSION_MAX_AGE_SECONDS }
    );
    await expect(unsealPreservedAdminSession(malformed)).resolves.toBeNull();
  });

  it('returns null for a payload with no user at all', async () => {
    const noUser = await sealData(
      { accessToken: 'at', refreshToken: 'rt' },
      { password: TEST_PASSWORD, ttl: IMPERSONATED_SESSION_MAX_AGE_SECONDS }
    );
    await expect(unsealPreservedAdminSession(noUser)).resolves.toBeNull();
  });

  it('returns null once the TTL has elapsed (30 minutes + iron clock skew)', async () => {
    const sealed = await sealPreservedAdminSession(SESSION_DATA);

    vi.useFakeTimers();
    vi.setSystemTime(
      Date.now() + (IMPERSONATED_SESSION_MAX_AGE_SECONDS + IRON_CLOCK_SKEW_SECONDS + 5) * 1000
    );

    await expect(unsealPreservedAdminSession(sealed)).resolves.toBeNull();
  });

  it('is still valid just inside the TTL', async () => {
    const sealed = await sealPreservedAdminSession(SESSION_DATA);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + (IMPERSONATED_SESSION_MAX_AGE_SECONDS - 10) * 1000);

    await expect(unsealPreservedAdminSession(sealed)).resolves.toEqual(SESSION_DATA);
  });

  it('round-trips a session with no tokens present (accessToken/refreshToken undefined)', async () => {
    const tokenless: SessionData = { user: SESSION_DATA.user };
    const sealed = await sealPreservedAdminSession(tokenless);
    const unsealed = await unsealPreservedAdminSession(sealed);
    expect(unsealed?.user).toEqual(tokenless.user);
    expect(unsealed?.accessToken).toBeUndefined();
    expect(unsealed?.refreshToken).toBeUndefined();
  });
});

// BAL-553 fix round 1, S2 — domain separation. Same shape and same technique as
// `lib/workspaces/switch-token.test.ts`'s "purpose discriminator" block: this seal shares ONE
// password with `balo_session`, so "sealed with our password" is not by itself proof of origin.
describe('purpose discriminator (S2)', () => {
  it('rejects an otherwise-perfect payload sealed WITHOUT the purpose field', async () => {
    const noPurpose = await sealData(SESSION_DATA, {
      password: TEST_PASSWORD,
      ttl: IMPERSONATED_SESSION_MAX_AGE_SECONDS,
    });
    await expect(unsealPreservedAdminSession(noPurpose)).resolves.toBeNull();
  });

  it('rejects a payload sealed with a DIFFERENT purpose', async () => {
    const otherPurpose = await sealData(
      { ...SESSION_DATA, purpose: 'workspace_switch' },
      { password: TEST_PASSWORD, ttl: IMPERSONATED_SESSION_MAX_AGE_SECONDS }
    );
    await expect(unsealPreservedAdminSession(otherPurpose)).resolves.toBeNull();
  });

  it('accepts a hand-sealed payload that DOES carry the purpose (the discriminator is the only difference)', async () => {
    const withPurpose = await sealData(
      { ...SESSION_DATA, purpose: IMPERSONATION_PRESERVED_ADMIN_SEAL_PURPOSE },
      { password: TEST_PASSWORD, ttl: IMPERSONATED_SESSION_MAX_AGE_SECONDS }
    );
    await expect(unsealPreservedAdminSession(withPurpose)).resolves.toEqual(SESSION_DATA);
  });

  it('does not leak `purpose` into the unsealed result — the public shape is unchanged', async () => {
    const sealed = await sealPreservedAdminSession(SESSION_DATA);
    const unsealed = await unsealPreservedAdminSession(sealed);
    expect(unsealed).toEqual(SESSION_DATA);
    expect(unsealed).not.toHaveProperty('purpose');
  });

  it('rejects a REAL balo_session-shaped seal made with the same password (the exact confusion S2 closes)', async () => {
    // A `balo_session` payload is ALSO `{ user, accessToken, refreshToken }` — no `purpose` — so
    // before this fix a `balo_session` cookie value pasted into `balo_admin_session` would have
    // passed the shape check (`user.id` present) below.
    const sessionShaped = await sealData(SESSION_DATA, { password: TEST_PASSWORD });
    await expect(unsealPreservedAdminSession(sessionShaped)).resolves.toBeNull();
  });

  it('the purpose literal is the documented string', () => {
    expect(IMPERSONATION_PRESERVED_ADMIN_SEAL_PURPOSE).toBe('impersonation_preserved_admin');
  });

  it('rejects a purpose-correct payload whose user.id is missing, non-string, or empty — the shape check runs AFTER the discriminator passes', async () => {
    const noUserAtAll = await sealData(
      {
        purpose: IMPERSONATION_PRESERVED_ADMIN_SEAL_PURPOSE,
        accessToken: 'at',
        refreshToken: 'rt',
      },
      { password: TEST_PASSWORD, ttl: IMPERSONATED_SESSION_MAX_AGE_SECONDS }
    );
    await expect(unsealPreservedAdminSession(noUserAtAll)).resolves.toBeNull();

    const emptyId = await sealData(
      {
        purpose: IMPERSONATION_PRESERVED_ADMIN_SEAL_PURPOSE,
        user: { ...SESSION_DATA.user, id: '' },
        accessToken: 'at',
        refreshToken: 'rt',
      },
      { password: TEST_PASSWORD, ttl: IMPERSONATED_SESSION_MAX_AGE_SECONDS }
    );
    await expect(unsealPreservedAdminSession(emptyId)).resolves.toBeNull();
  });
});

describe('preserved admin cookie read/write/clear', () => {
  it('writes the seal under PRESERVED_ADMIN_COOKIE with httpOnly + sameSite=lax + the impersonation-window maxAge', async () => {
    await writePreservedAdminCookie('sealed-value');

    expect(mockCookieStore.set).toHaveBeenCalledWith(
      PRESERVED_ADMIN_COOKIE,
      'sealed-value',
      expect.objectContaining({
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: IMPERSONATED_SESSION_MAX_AGE_SECONDS,
      })
    );
  });

  it('reads the seal value back from the cookie store', async () => {
    mockCookieStore.get.mockReturnValue({ name: PRESERVED_ADMIN_COOKIE, value: 'sealed-value' });
    await expect(readPreservedAdminCookie()).resolves.toBe('sealed-value');
    expect(mockCookieStore.get).toHaveBeenCalledWith(PRESERVED_ADMIN_COOKIE);
  });

  it('returns undefined when the cookie is missing', async () => {
    mockCookieStore.get.mockReturnValue(undefined);
    await expect(readPreservedAdminCookie()).resolves.toBeUndefined();
  });

  it('clears the cookie by name', async () => {
    await clearPreservedAdminCookie();
    expect(mockCookieStore.delete).toHaveBeenCalledWith(PRESERVED_ADMIN_COOKIE);
  });

  it('the cookie name is the documented balo_admin_session', () => {
    expect(PRESERVED_ADMIN_COOKIE).toBe('balo_admin_session');
  });
});

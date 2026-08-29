import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('server-only', () => ({}));

// The real `sessionConfig.password` is `process.env.WORKOS_COOKIE_PASSWORD`, which is unset in
// the test env. Mock the module (not the env var) so the seal/unseal round trip below is REAL
// iron-session work against a deterministic, sufficiently long password.
const { TEST_PASSWORD } = vi.hoisted(() => ({
  TEST_PASSWORD: 'workspace-switch-token-test-password-0123456789',
}));
vi.mock('@/lib/auth/session-config', () => ({
  COOKIE_NAME: 'balo_session',
  sessionConfig: { password: TEST_PASSWORD, cookieName: 'balo_session', cookieOptions: {} },
}));

vi.mock('@/lib/logging', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { sealData } from 'iron-session';
import {
  sealWorkspaceSwitchToken,
  unsealWorkspaceSwitchToken,
  WORKSPACE_SWITCH_TOKEN_PURPOSE,
  WORKSPACE_SWITCH_TOKEN_TTL_SECONDS,
} from './switch-token';

/**
 * iron's FIXED clock-skew allowance, added to any ttl before a seal is called expired — which
 * is why the effective window is `ttl + 60`, i.e. 120s for a `ttl: 60` token, NOT 60s. Both
 * bounds are pinned below; the constant's docblock states the same number.
 */
const IRON_CLOCK_SKEW_SECONDS = 60;

const PAYLOAD = {
  userId: 'user-1',
  targetKey: 'company:11111111-1111-4111-8111-111111111111',
  returnTo: '/projects/req-1',
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('workspace switch token', () => {
  it('round-trips a sealed payload', async () => {
    const sealed = await sealWorkspaceSwitchToken(PAYLOAD);
    expect(sealed).toEqual(expect.any(String));
    // The payload must not be readable from the wire format.
    expect(sealed).not.toContain('user-1');
    expect(sealed).not.toContain('/projects/req-1');

    await expect(unsealWorkspaceSwitchToken(sealed)).resolves.toEqual(PAYLOAD);
  });

  it('returns null for a missing token', async () => {
    await expect(unsealWorkspaceSwitchToken(null)).resolves.toBeNull();
    await expect(unsealWorkspaceSwitchToken(undefined)).resolves.toBeNull();
    await expect(unsealWorkspaceSwitchToken('')).resolves.toBeNull();
  });

  it('returns null for a garbage token', async () => {
    await expect(unsealWorkspaceSwitchToken('not-a-seal')).resolves.toBeNull();
  });

  it('returns null for a TAMPERED token (bad hmac)', async () => {
    const sealed = await sealWorkspaceSwitchToken(PAYLOAD);
    const tampered = sealed.slice(0, -6) + 'AAAAAA';
    await expect(unsealWorkspaceSwitchToken(tampered)).resolves.toBeNull();
  });

  it('returns null for a token sealed with a DIFFERENT password (unforgeable)', async () => {
    const foreign = await sealData(PAYLOAD, {
      password: 'a-completely-different-password-0123456789abcd',
      ttl: WORKSPACE_SWITCH_TOKEN_TTL_SECONDS,
    });
    await expect(unsealWorkspaceSwitchToken(foreign)).resolves.toBeNull();
  });

  it('returns null once the TTL has elapsed', async () => {
    const sealed = await sealWorkspaceSwitchToken(PAYLOAD);

    // iron allows a fixed 60s clock skew ON TOP of the ttl, so the outer bound of a
    // `ttl: 60` seal is 120s — advance past that.
    vi.useFakeTimers();
    vi.setSystemTime(
      Date.now() + (WORKSPACE_SWITCH_TOKEN_TTL_SECONDS + IRON_CLOCK_SKEW_SECONDS + 5) * 1000
    );

    await expect(unsealWorkspaceSwitchToken(sealed)).resolves.toBeNull();
  });

  it('is still valid just inside the TTL', async () => {
    const sealed = await sealWorkspaceSwitchToken(PAYLOAD);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + (WORKSPACE_SWITCH_TOKEN_TTL_SECONDS - 10) * 1000);

    await expect(unsealWorkspaceSwitchToken(sealed)).resolves.toEqual(PAYLOAD);
  });

  it('returns null when the sealed payload is the wrong SHAPE', async () => {
    const wrongShape = await sealData(
      { userId: 'user-1' },
      { password: TEST_PASSWORD, ttl: WORKSPACE_SWITCH_TOKEN_TTL_SECONDS }
    );
    await expect(unsealWorkspaceSwitchToken(wrongShape)).resolves.toBeNull();
  });

  it('is still valid at 119s but expired at 121s — the window is ttl + iron skew, not ttl', async () => {
    // Pins the DOCUMENTED bound, not just the behaviour: `WORKSPACE_SWITCH_TOKEN_TTL_SECONDS`
    // is 60 but the seal is honoured for up to 120s because iron adds a fixed 60s skew
    // allowance. A future edit that lowers the constant expecting a proportional cut in the
    // replay window will fail here, which is the point.
    const sealed = await sealWorkspaceSwitchToken(PAYLOAD);
    const outerBound = WORKSPACE_SWITCH_TOKEN_TTL_SECONDS + IRON_CLOCK_SKEW_SECONDS;
    expect(outerBound).toBe(120);

    const mintedAt = Date.now();
    vi.useFakeTimers();

    vi.setSystemTime(mintedAt + (outerBound - 1) * 1000);
    await expect(unsealWorkspaceSwitchToken(sealed)).resolves.toEqual(PAYLOAD);

    vi.setSystemTime(mintedAt + (outerBound + 1) * 1000);
    await expect(unsealWorkspaceSwitchToken(sealed)).resolves.toBeNull();
  });
});

// ── Domain separation (fix round 2, MUST-FIX 4) ─────────────────────────────

describe('purpose discriminator', () => {
  it('rejects an otherwise-perfect payload sealed WITHOUT the purpose field', async () => {
    // The session cookie and this token share ONE password (deliberately — one key to
    // rotate), so "sealed with our password" is not by itself proof of origin. Without the
    // discriminator the separation was emergent: each seal happened to be rejected by the
    // other's shape checks. This asserts it explicitly.
    const noPurpose = await sealData(PAYLOAD, {
      password: TEST_PASSWORD,
      ttl: WORKSPACE_SWITCH_TOKEN_TTL_SECONDS,
    });
    await expect(unsealWorkspaceSwitchToken(noPurpose)).resolves.toBeNull();
  });

  it('rejects a payload sealed with a DIFFERENT purpose', async () => {
    const otherPurpose = await sealData(
      { ...PAYLOAD, purpose: 'password_reset' },
      { password: TEST_PASSWORD, ttl: WORKSPACE_SWITCH_TOKEN_TTL_SECONDS }
    );
    await expect(unsealWorkspaceSwitchToken(otherPurpose)).resolves.toBeNull();
  });

  it('accepts a hand-sealed payload that DOES carry the purpose (the discriminator is the only difference)', async () => {
    const withPurpose = await sealData(
      { ...PAYLOAD, purpose: WORKSPACE_SWITCH_TOKEN_PURPOSE },
      { password: TEST_PASSWORD, ttl: WORKSPACE_SWITCH_TOKEN_TTL_SECONDS }
    );
    await expect(unsealWorkspaceSwitchToken(withPurpose)).resolves.toEqual(PAYLOAD);
  });

  it('does not leak `purpose` into the unsealed result — the public shape is unchanged', async () => {
    const sealed = await sealWorkspaceSwitchToken(PAYLOAD);
    const unsealed = await unsealWorkspaceSwitchToken(sealed);
    expect(unsealed).toEqual(PAYLOAD);
    expect(unsealed).not.toHaveProperty('purpose');
  });

  it('rejects a REAL session-shaped seal made with the same password (confusion direction 2)', async () => {
    // A `balo_session` payload is `{ user, accessToken, refreshToken }` — no `purpose`, no
    // top-level `targetKey`. It must not unseal as a switch authorization.
    const sessionShaped = await sealData(
      { user: { id: 'user-1', companyId: 'company-1' }, accessToken: 'at', refreshToken: 'rt' },
      { password: TEST_PASSWORD }
    );
    await expect(unsealWorkspaceSwitchToken(sessionShaped)).resolves.toBeNull();
  });
});

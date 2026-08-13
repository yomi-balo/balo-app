import { afterEach, describe, expect, it } from 'vitest';
import { validateGrant } from './validate-grant';

/**
 * ⚠⚠ THE SECURITY ACCEPTANCE CRITERION. A test that asserts only the happy path here is
 * worthless — every rejection below is a specific thing an unvalidated grant would have handed
 * to a vendor SDK.
 */

const VALID = {
  roomUrl: 'https://balo.daily.co/balo-0f7b1c2d3e4f4a5b8c9d0e1f2a3b4c5d',
  token: 'daily.jwt.super.secret.value',
  isOwner: true,
  expiresAt: '2026-09-02T11:00:00.000Z',
  participantId: 'u0f7b1c2d3e4f4a5b8c9d0e1f2a3b4c5d',
};

describe('validateGrant — shape', () => {
  it('accepts a well-formed grant', () => {
    const result = validateGrant(VALID);
    expect(result.ok).toBe(true);
  });

  it('rejects a non-object, a null and an array', () => {
    expect(validateGrant(null)).toEqual({ ok: false, reason: 'shape' });
    expect(validateGrant('grant')).toEqual({ ok: false, reason: 'shape' });
    expect(validateGrant([])).toEqual({ ok: false, reason: 'shape' });
  });

  it('rejects a missing or empty token — the token is the ONLY thing that admits anyone', () => {
    expect(validateGrant({ ...VALID, token: '' })).toEqual({ ok: false, reason: 'shape' });
    // ⚠ A key genuinely ABSENT, not merely empty — that is the shape a truncated response takes.
    const withoutToken: Record<string, unknown> = { ...VALID };
    delete withoutToken.token;
    expect(validateGrant(withoutToken)).toEqual({ ok: false, reason: 'shape' });
  });

  it('rejects a non-boolean isOwner — a truthy string must never become host rights', () => {
    expect(validateGrant({ ...VALID, isOwner: 'true' })).toEqual({ ok: false, reason: 'shape' });
    expect(validateGrant({ ...VALID, isOwner: 1 })).toEqual({ ok: false, reason: 'shape' });
  });

  it('rejects an empty roomUrl', () => {
    expect(validateGrant({ ...VALID, roomUrl: '' })).toEqual({ ok: false, reason: 'shape' });
  });
});

describe('validateGrant — participantId (the Decision-1 encoding)', () => {
  it('accepts both the user and the guest prefix', () => {
    expect(validateGrant({ ...VALID, participantId: `u${'a'.repeat(32)}` }).ok).toBe(true);
    expect(validateGrant({ ...VALID, participantId: `g${'0'.repeat(32)}` }).ok).toBe(true);
  });

  it('⚠ rejects a bare uuid — that is exactly the shape it must never be', () => {
    expect(
      validateGrant({ ...VALID, participantId: '0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d' })
    ).toEqual({ ok: false, reason: 'participant_id' });
  });

  it('rejects a wrong prefix, a wrong length and uppercase hex', () => {
    expect(validateGrant({ ...VALID, participantId: `x${'a'.repeat(32)}` }).ok).toBe(false);
    expect(validateGrant({ ...VALID, participantId: `u${'a'.repeat(31)}` }).ok).toBe(false);
    expect(validateGrant({ ...VALID, participantId: `u${'a'.repeat(33)}` }).ok).toBe(false);
    expect(validateGrant({ ...VALID, participantId: `u${'A'.repeat(32)}` }).ok).toBe(false);
  });

  it('names the participant_id rule, not the generic shape one', () => {
    expect(validateGrant({ ...VALID, participantId: 'nope' })).toEqual({
      ok: false,
      reason: 'participant_id',
    });
  });
});

describe('validateGrant — expiresAt', () => {
  it('rejects an empty string, prose and an impossible date', () => {
    expect(validateGrant({ ...VALID, expiresAt: '' })).toEqual({ ok: false, reason: 'expires_at' });
    expect(validateGrant({ ...VALID, expiresAt: 'soon' })).toEqual({
      ok: false,
      reason: 'expires_at',
    });
    expect(validateGrant({ ...VALID, expiresAt: '2026-13-45' })).toEqual({
      ok: false,
      reason: 'expires_at',
    });
  });

  it('⚠⚠ ACCEPTS AN ALREADY-EXPIRED TIMESTAMP — expiry does not eject, it only blocks a new join', () => {
    const result = validateGrant({ ...VALID, expiresAt: '2001-01-01T00:00:00.000Z' });
    expect(result.ok).toBe(true);
  });
});

describe('validateGrant — roomUrl host allow-list', () => {
  it('accepts a Daily subdomain and the bare apex', () => {
    expect(validateGrant({ ...VALID, roomUrl: 'https://balo.daily.co/x' }).ok).toBe(true);
    expect(validateGrant({ ...VALID, roomUrl: 'https://daily.co/x' }).ok).toBe(true);
  });

  it('⚠ rejects http — the scheme is asserted, never assumed', () => {
    expect(validateGrant({ ...VALID, roomUrl: 'http://x.daily.co/r' })).toEqual({
      ok: false,
      reason: 'url_scheme',
    });
  });

  it('⚠ rejects a javascript: URL, which parses perfectly well', () => {
    expect(validateGrant({ ...VALID, roomUrl: 'javascript:alert(1)' })).toEqual({
      ok: false,
      reason: 'url_scheme',
    });
  });

  it('⚠⚠ rejects evildaily.co — the reason a naive endsWith would have shipped a hole', () => {
    expect(validateGrant({ ...VALID, roomUrl: 'https://evildaily.co/r' })).toEqual({
      ok: false,
      reason: 'url_host',
    });
  });

  it('⚠ rejects daily.co as a PREFIX of somebody else’s domain', () => {
    expect(validateGrant({ ...VALID, roomUrl: 'https://daily.co.evil.example/r' })).toEqual({
      ok: false,
      reason: 'url_host',
    });
  });

  it('rejects an unrelated host', () => {
    expect(validateGrant({ ...VALID, roomUrl: 'https://attacker.example/' })).toEqual({
      ok: false,
      reason: 'url_host',
    });
  });

  it('rejects an unparseable URL', () => {
    expect(validateGrant({ ...VALID, roomUrl: 'not a url at all' })).toEqual({
      ok: false,
      reason: 'url_parse',
    });
  });
});

/**
 * ⚠⚠ THE TENANT PIN AND THE USERINFO REFUSAL — the two residuals the security audit named.
 *
 * `*.daily.co` is a VENDOR-WIDE allow-list: any Daily customer can register a subdomain, so
 * `https://attacker.daily.co/r` passed it, and a poisoned `join_url` would hand a live
 * Balo-minted JWT plus a camera and a microphone to a third party's Daily domain. Userinfo was
 * separately accepted on an otherwise-valid host.
 */
describe('validateGrant — ⚠⚠ the tenant pin and userinfo', () => {
  it('⚠ rejects a credential-bearing URL even on a valid Daily host', () => {
    expect(validateGrant({ ...VALID, roomUrl: 'https://user:pass@balo.daily.co/r' })).toEqual({
      ok: false,
      reason: 'url_host',
    });
    expect(validateGrant({ ...VALID, roomUrl: 'https://user@balo.daily.co/r' })).toEqual({
      ok: false,
      reason: 'url_host',
    });
  });

  it('⚠ still rejects the mirror-image trick, where userinfo hides the real host', () => {
    // `https://daily.co@evil.com/r` has hostname `evil.com`.
    expect(validateGrant({ ...VALID, roomUrl: 'https://daily.co@evil.example/r' })).toEqual({
      ok: false,
      reason: 'url_host',
    });
  });

  describe('with NEXT_PUBLIC_DAILY_DOMAIN configured', () => {
    const original = process.env.NEXT_PUBLIC_DAILY_DOMAIN;

    afterEach(() => {
      if (original === undefined) {
        delete process.env.NEXT_PUBLIC_DAILY_DOMAIN;
        return;
      }
      process.env.NEXT_PUBLIC_DAILY_DOMAIN = original;
    });

    it('⚠⚠ accepts ONLY Balo own Daily domain — another tenant is refused', () => {
      process.env.NEXT_PUBLIC_DAILY_DOMAIN = 'balo.daily.co';

      expect(validateGrant({ ...VALID, roomUrl: 'https://balo.daily.co/x' }).ok).toBe(true);
      expect(validateGrant({ ...VALID, roomUrl: 'https://attacker.daily.co/x' })).toEqual({
        ok: false,
        reason: 'url_host',
      });
      // ⚠ Even the vendor apex is another tenant once we are pinned.
      expect(validateGrant({ ...VALID, roomUrl: 'https://daily.co/x' })).toEqual({
        ok: false,
        reason: 'url_host',
      });
    });

    it('⚠ falls back to the vendor suffix when the variable is unset — a missing env var is not an outage', () => {
      delete process.env.NEXT_PUBLIC_DAILY_DOMAIN;

      expect(validateGrant({ ...VALID, roomUrl: 'https://balo.daily.co/x' }).ok).toBe(true);
      expect(validateGrant({ ...VALID, roomUrl: 'https://evildaily.co/x' }).ok).toBe(false);
    });
  });
});

describe('validateGrant — the redaction brand', () => {
  it('⚠⚠ JSON.stringify of a validated grant leaks NOTHING', () => {
    const result = validateGrant(VALID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const serialised = JSON.stringify({ grant: result.grant });
    expect(serialised).not.toContain(VALID.token);
    expect(serialised).not.toContain(VALID.roomUrl);
    expect(serialised).toContain('[redacted]');
  });

  it('still exposes the fields the frame genuinely needs', () => {
    const result = validateGrant(VALID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.grant.roomUrl).toBe(VALID.roomUrl);
    expect(result.grant.token).toBe(VALID.token);
    expect(result.grant.isOwner).toBe(true);
    expect(result.grant.participantId).toBe(VALID.participantId);
  });
});

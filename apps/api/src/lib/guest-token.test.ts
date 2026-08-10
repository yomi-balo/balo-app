import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { mintGuestInviteToken } from './guest-token.js';

/**
 * BAL-408 — the mint is a two-half secret, and BOTH halves are pinned here.
 *
 * ⚠⚠ THE ALGORITHM ASSERTION IS THE WHOLE POINT OF THIS FILE. `apps/web`'s `/join/{token}`
 * landing looks the guest up by `sha256(raw)`; the mint writes the hash. Those are two
 * SEPARATE expressions in two SEPARATE packages with no shared constant, so nothing but a
 * test couples them. A `not.toBe(rawToken)` assertion — the obvious one to write — stays
 * green if this file silently switches to sha512 or adds a pepper, and the consequence is
 * that EVERY emailed join link renders `<LinkNotActive />` in production with CI fully
 * green. So the expected value below is RECOMPUTED here from `node:crypto` rather than
 * hard-coded or re-imported.
 */
describe('mintGuestInviteToken — the hash algorithm is PINNED, not merely "different"', () => {
  it('⚠ hashes with SHA-256 over the RAW token, hex-encoded — the exact `/join` verify expression', () => {
    const { rawToken, tokenHash } = mintGuestInviteToken();

    expect(tokenHash).toBe(createHash('sha256').update(rawToken).digest('hex'));
  });

  it('⚠ is NOT sha512 / sha1 / md5, and carries no pepper — each stated as its own refutation', () => {
    const { rawToken, tokenHash } = mintGuestInviteToken();

    for (const algorithm of ['sha512', 'sha1', 'md5']) {
      expect(tokenHash).not.toBe(createHash(algorithm).update(rawToken).digest('hex'));
    }
    // A pepper would still be 64 hex chars and still not equal the raw token, so the shape
    // assertions below cannot catch one. This can.
    expect(tokenHash).not.toBe(createHash('sha256').update(`${rawToken}pepper`).digest('hex'));
  });

  it('never returns the raw secret as the hash (the assertion that is necessary but NOT sufficient)', () => {
    const { rawToken, tokenHash } = mintGuestInviteToken();
    expect(tokenHash).not.toBe(rawToken);
  });
});

describe('mintGuestInviteToken — the wire shape', () => {
  it('mints 43 base64url characters — 256 bits, the `proposal_share_links` / `review_invite_tokens` shape', () => {
    const { rawToken } = mintGuestInviteToken();

    expect(rawToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('emits no base64 padding and no URL-unsafe characters, so the token is path-safe unescaped', () => {
    const { rawToken } = mintGuestInviteToken();

    expect(rawToken).not.toContain('=');
    expect(rawToken).not.toContain('+');
    expect(rawToken).not.toContain('/');
    expect(encodeURIComponent(rawToken)).toBe(rawToken);
  });

  it('produces a 64-character lowercase hex digest', () => {
    const { tokenHash } = mintGuestInviteToken();

    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash).toHaveLength(64);
  });
});

describe('mintGuestInviteToken — entropy', () => {
  it('successive mints differ in BOTH halves (no module-level cache, no fixed seed)', () => {
    const first = mintGuestInviteToken();
    const second = mintGuestInviteToken();

    expect(first.rawToken).not.toBe(second.rawToken);
    expect(first.tokenHash).not.toBe(second.tokenHash);
  });

  it('200 mints yield 200 distinct raw tokens and 200 distinct hashes', () => {
    const raws = new Set<string>();
    const hashes = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const { rawToken, tokenHash } = mintGuestInviteToken();
      raws.add(rawToken);
      hashes.add(tokenHash);
    }

    expect(raws.size).toBe(200);
    expect(hashes.size).toBe(200);
  });

  it('the hash is a pure function of the raw token — the same input always digests the same', () => {
    // Pins that the mint holds no per-call salt. If it did, `/join` could never verify.
    const { rawToken, tokenHash } = mintGuestInviteToken();

    expect(createHash('sha256').update(rawToken).digest('hex')).toBe(tokenHash);
    expect(createHash('sha256').update(rawToken).digest('hex')).toBe(
      createHash('sha256').update(rawToken).digest('hex')
    );
  });
});

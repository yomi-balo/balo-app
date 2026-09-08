import { describe, it, expect } from 'vitest';
import {
  sessionConfig,
  IMPERSONATED_SESSION_MAX_AGE_SECONDS,
  impersonatedSessionConfig,
} from './session-config';

/**
 * BAL-553 ⟦R5⟧ — the per-save TTL override seam for an impersonated session.
 *
 * The load-bearing property under test: `ttl` and `cookieOptions.maxAge` must ALWAYS be set to
 * the SAME value. `session-config.ts`'s docblock explains why — iron-session derives `maxAge`
 * from `ttl` only when `cookieOptions` carries no `maxAge` key, and `sessionConfig` always does,
 * so setting `maxAge` alone would leave the SEAL at iron-session's 14-day default while the
 * cookie itself expired in 30 minutes.
 */
describe('IMPERSONATED_SESSION_MAX_AGE_SECONDS', () => {
  it('is 30 minutes in seconds', () => {
    expect(IMPERSONATED_SESSION_MAX_AGE_SECONDS).toBe(1800);
  });
});

describe('impersonatedSessionConfig', () => {
  it('sets ttl AND cookieOptions.maxAge to the SAME value, at the full 30-minute budget', () => {
    const config = impersonatedSessionConfig(1800);
    expect(config.ttl).toBe(1800);
    expect(config.cookieOptions.maxAge).toBe(1800);
  });

  it('carries the remaining time, not a fresh 30 minutes — the deadline is absolute', () => {
    const config = impersonatedSessionConfig(600);
    expect(config.ttl).toBe(600);
    expect(config.cookieOptions.maxAge).toBe(600);
  });

  it('clamps at IMPERSONATED_SESSION_MAX_AGE_SECONDS — re-saving can never EXTEND the window', () => {
    const config = impersonatedSessionConfig(9999);
    expect(config.ttl).toBe(IMPERSONATED_SESSION_MAX_AGE_SECONDS);
    expect(config.cookieOptions.maxAge).toBe(IMPERSONATED_SESSION_MAX_AGE_SECONDS);
  });

  it('clamps at a floor of 1 second for an already-expired or negative remaining time', () => {
    expect(impersonatedSessionConfig(0).ttl).toBe(1);
    expect(impersonatedSessionConfig(-500).ttl).toBe(1);
  });

  it('rounds a fractional remaining time up to the nearest whole second', () => {
    expect(impersonatedSessionConfig(10.2).ttl).toBe(11);
  });

  it('preserves every other field of sessionConfig (password, cookieName, secure, httpOnly, sameSite)', () => {
    const config = impersonatedSessionConfig(1800);
    expect(config.password).toBe(sessionConfig.password);
    expect(config.cookieName).toBe(sessionConfig.cookieName);
    expect(config.cookieOptions.secure).toBe(sessionConfig.cookieOptions.secure);
    expect(config.cookieOptions.httpOnly).toBe(sessionConfig.cookieOptions.httpOnly);
    expect(config.cookieOptions.sameSite).toBe(sessionConfig.cookieOptions.sameSite);
  });

  it('never mutates the shared sessionConfig literal (R5 no-mutation proof)', () => {
    impersonatedSessionConfig(1800);
    impersonatedSessionConfig(1);
    impersonatedSessionConfig(99999);
    expect(sessionConfig.cookieOptions.maxAge).toBe(60 * 60 * 24 * 7);
  });

  it('returns a NEW object on every call — not a shared mutable reference', () => {
    const first = impersonatedSessionConfig(1800);
    const second = impersonatedSessionConfig(1800);
    expect(first).not.toBe(second);
    expect(first.cookieOptions).not.toBe(second.cookieOptions);
  });
});

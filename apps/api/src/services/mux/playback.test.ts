import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ⚠⚠ FIX ROUND 1 (F9-2) — mock the logging module SO A FUTURE `createLogger(...).info(url)`
// HAS SOMEWHERE TO LAND. `playback.ts` imports no logger today (structurally true), but a test
// asserting only its export list would still pass if that changed; this makes the "never logs"
// claim an actual, falsifiable assertion instead of a fact about the export list.
const { mockLogDebug, mockLogInfo, mockLogWarn, mockLogError } = vi.hoisted(() => ({
  mockLogDebug: vi.fn(),
  mockLogInfo: vi.fn(),
  mockLogWarn: vi.fn(),
  mockLogError: vi.fn(),
}));
vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({
    debug: mockLogDebug,
    info: mockLogInfo,
    warn: mockLogWarn,
    error: mockLogError,
  }),
}));

import { MuxConfigError } from './errors.js';
import {
  MUX_PLAYBACK_DEFAULT_TTL_SECONDS,
  MUX_PLAYBACK_MAX_TTL_SECONDS,
  signedPlaybackUrl,
  signedThumbnailUrl,
} from './playback.js';

const PLAYBACK_ID = 'pb_abc123';
let PRIVATE_KEY_B64: string;

beforeAll(() => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  PRIVATE_KEY_B64 = Buffer.from(privateKey).toString('base64');
});

/** Decode a JWT's payload (middle segment) without verifying — test-only. */
function decodeJwtPayload(token: string): Record<string, unknown> {
  const [, payloadB64url] = token.split('.');
  const payloadB64 = (payloadB64url ?? '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = payloadB64 + '='.repeat((4 - (payloadB64.length % 4)) % 4);
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
}

function envReset(): { MUX_SIGNING_KEY_ID?: string; MUX_SIGNING_KEY_PRIVATE?: string } {
  return {
    MUX_SIGNING_KEY_ID: process.env.MUX_SIGNING_KEY_ID,
    MUX_SIGNING_KEY_PRIVATE: process.env.MUX_SIGNING_KEY_PRIVATE,
  };
}

describe('signedPlaybackUrl / signedThumbnailUrl (BAL-473 §9)', () => {
  let original: { MUX_SIGNING_KEY_ID?: string; MUX_SIGNING_KEY_PRIVATE?: string };

  beforeEach(() => {
    original = envReset();
    process.env.MUX_SIGNING_KEY_ID = 'signing-key-id-1';
    process.env.MUX_SIGNING_KEY_PRIVATE = PRIVATE_KEY_B64;
  });

  afterEach(() => {
    vi.useRealTimers();
    if (original.MUX_SIGNING_KEY_ID === undefined) {
      delete process.env.MUX_SIGNING_KEY_ID;
    } else {
      process.env.MUX_SIGNING_KEY_ID = original.MUX_SIGNING_KEY_ID;
    }
    if (original.MUX_SIGNING_KEY_PRIVATE === undefined) {
      delete process.env.MUX_SIGNING_KEY_PRIVATE;
    } else {
      process.env.MUX_SIGNING_KEY_PRIVATE = original.MUX_SIGNING_KEY_PRIVATE;
    }
  });

  it('video URL is stream.mux.com/{id}.m3u8?token=… with aud:"v"', async () => {
    const url = await signedPlaybackUrl(PLAYBACK_ID);

    expect(url.startsWith(`https://stream.mux.com/${PLAYBACK_ID}.m3u8?token=`)).toBe(true);
    const token = new URL(url).searchParams.get('token');
    expect(token).not.toBeNull();
    const payload = decodeJwtPayload(token as string);
    expect(payload.aud).toBe('v');
    expect(payload.sub).toBe(PLAYBACK_ID);
  });

  it('thumbnail URL is image.mux.com/{id}/thumbnail.jpg?token=… with aud:"t"', async () => {
    const url = await signedThumbnailUrl(PLAYBACK_ID);

    expect(url.startsWith(`https://image.mux.com/${PLAYBACK_ID}/thumbnail.jpg?token=`)).toBe(true);
    const token = new URL(url).searchParams.get('token');
    const payload = decodeJwtPayload(token as string);
    expect(payload.aud).toBe('t');
  });

  it('a supplied `timeSeconds` is embedded as a claim AND appended to the URL', async () => {
    const url = await signedThumbnailUrl(PLAYBACK_ID, { timeSeconds: 14 });

    expect(url).toContain('&time=14');
    const token = new URL(url).searchParams.get('token');
    const payload = decodeJwtPayload(token as string);
    expect(payload.time).toBe('14');
  });

  it('a 24h TTL request clamps to the 2h ceiling', async () => {
    vi.useFakeTimers();
    const now = new Date('2026-08-25T12:00:00.000Z');
    vi.setSystemTime(now);

    const url = await signedPlaybackUrl(PLAYBACK_ID, 24 * 60 * 60);
    const token = new URL(url).searchParams.get('token');
    const payload = decodeJwtPayload(token as string);

    expect((payload.exp as number) - Math.floor(now.getTime() / 1000)).toBe(
      MUX_PLAYBACK_MAX_TTL_SECONDS
    );
  });

  it('a 10s TTL request clamps UP to the 60s floor', async () => {
    vi.useFakeTimers();
    const now = new Date('2026-08-25T12:00:00.000Z');
    vi.setSystemTime(now);

    const url = await signedPlaybackUrl(PLAYBACK_ID, 10);
    const token = new URL(url).searchParams.get('token');
    const payload = decodeJwtPayload(token as string);

    expect((payload.exp as number) - Math.floor(now.getTime() / 1000)).toBe(60);
  });

  it('defaults to the 1h TTL when none is supplied', async () => {
    vi.useFakeTimers();
    const now = new Date('2026-08-25T12:00:00.000Z');
    vi.setSystemTime(now);

    const url = await signedPlaybackUrl(PLAYBACK_ID);
    const token = new URL(url).searchParams.get('token');
    const payload = decodeJwtPayload(token as string);

    expect((payload.exp as number) - Math.floor(now.getTime() / 1000)).toBe(
      MUX_PLAYBACK_DEFAULT_TTL_SECONDS
    );
  });

  it('throws MuxConfigError when MUX_SIGNING_KEY_ID is absent', async () => {
    delete process.env.MUX_SIGNING_KEY_ID;

    await expect(signedPlaybackUrl(PLAYBACK_ID)).rejects.toBeInstanceOf(MuxConfigError);
  });

  it('throws MuxConfigError when MUX_SIGNING_KEY_PRIVATE is absent', async () => {
    delete process.env.MUX_SIGNING_KEY_PRIVATE;

    await expect(signedPlaybackUrl(PLAYBACK_ID)).rejects.toBeInstanceOf(MuxConfigError);
  });

  /**
   * ⚠⚠ FIX ROUND 1 (F11) — `clampTtlSeconds(NaN)` used to return `NaN` (`Math.min`/`Math.max`
   * propagate it rather than clamping), which became `expiration: "NaNs"` on the signed JWT. A
   * non-finite TTL must fall back to the default instead.
   */
  it('⚠ a NaN ttlSeconds falls back to the default rather than propagating NaN', async () => {
    vi.useFakeTimers();
    const now = new Date('2026-08-25T12:00:00.000Z');
    vi.setSystemTime(now);

    const url = await signedPlaybackUrl(PLAYBACK_ID, Number('not-a-number'));
    const token = new URL(url).searchParams.get('token');
    const payload = decodeJwtPayload(token as string);

    expect((payload.exp as number) - Math.floor(now.getTime() / 1000)).toBe(
      MUX_PLAYBACK_DEFAULT_TTL_SECONDS
    );
  });

  /**
   * ⚠⚠ FIX ROUND 1 (F9-2) — the previous version of this test asserted only the module's
   * EXPORT LIST, which would still pass if the module logged the signed URL on every call (an
   * export list says nothing about what a function's BODY does). Mocking the logger and
   * asserting zero calls actually exercises the claim: if a future edit adds
   * `createLogger('mux-playback').info({ url })`, THIS is what turns red.
   */
  it('⚠ never logs the URL or the token', async () => {
    await signedPlaybackUrl(PLAYBACK_ID);
    await signedThumbnailUrl(PLAYBACK_ID);

    expect(mockLogDebug).not.toHaveBeenCalled();
    expect(mockLogInfo).not.toHaveBeenCalled();
    expect(mockLogWarn).not.toHaveBeenCalled();
    expect(mockLogError).not.toHaveBeenCalled();
  });
});

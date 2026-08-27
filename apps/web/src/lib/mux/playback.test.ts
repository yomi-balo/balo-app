import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  MUX_PLAYBACK_DEFAULT_TTL_SECONDS,
  MUX_PLAYBACK_MAX_TTL_SECONDS,
} from '@balo/shared/meetings';
import { signedPlaybackUrl, signedThumbnailUrl } from './playback';
import { log } from '@/lib/logging';

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

describe('signedPlaybackUrl / signedThumbnailUrl (BAL-440 — the apps/web signer)', () => {
  let original: { MUX_SIGNING_KEY_ID?: string; MUX_SIGNING_KEY_PRIVATE?: string };

  beforeEach(() => {
    original = envReset();
    process.env.MUX_SIGNING_KEY_ID = 'signing-key-id-1';
    process.env.MUX_SIGNING_KEY_PRIVATE = PRIVATE_KEY_B64;
    vi.clearAllMocks();
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

  it('video URL is stream.mux.com/{id}.m3u8?token=… with aud:"v" and the right kid', async () => {
    const url = await signedPlaybackUrl(PLAYBACK_ID);

    expect(url.startsWith(`https://stream.mux.com/${PLAYBACK_ID}.m3u8?token=`)).toBe(true);
    const token = new URL(url).searchParams.get('token');
    expect(token).not.toBeNull();
    const payload = decodeJwtPayload(token as string);
    expect(payload.aud).toBe('v');
    expect(payload.sub).toBe(PLAYBACK_ID);
    expect(payload.kid).toBe('signing-key-id-1');
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

  it('rejects with a plain Error naming the var when MUX_SIGNING_KEY_ID is absent', async () => {
    delete process.env.MUX_SIGNING_KEY_ID;

    await expect(signedPlaybackUrl(PLAYBACK_ID)).rejects.toThrow('MUX_SIGNING_KEY_ID is not set');
  });

  it('rejects with a plain Error naming the var when MUX_SIGNING_KEY_PRIVATE is absent', async () => {
    delete process.env.MUX_SIGNING_KEY_PRIVATE;

    await expect(signedPlaybackUrl(PLAYBACK_ID)).rejects.toThrow(
      'MUX_SIGNING_KEY_PRIVATE is not set'
    );
  });

  /**
   * ⚠⚠ THE "NEVER LOGS" CLAIM, MADE FALSIFIABLE. `@/lib/logging` is auto-mocked globally
   * (`apps/web/src/test/setup.ts`); this asserts the mock's four methods stay uncalled after
   * BOTH signing calls, so a future `log.info({ url })` added to this module turns this red.
   */
  it('never logs the URL or the token', async () => {
    await signedPlaybackUrl(PLAYBACK_ID);
    await signedThumbnailUrl(PLAYBACK_ID);

    expect(log.debug).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });
});

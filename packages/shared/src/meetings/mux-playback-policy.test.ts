import { describe, it, expect } from 'vitest';
import {
  clampMuxTtlSeconds,
  playbackTtlForDuration,
  muxPlaybackManifestUrl,
  muxThumbnailUrl,
  muxVideoSigningOptions,
  muxThumbnailSigningOptions,
  MUX_PLAYBACK_DEFAULT_TTL_SECONDS,
  MUX_PLAYBACK_MAX_TTL_SECONDS,
  MUX_PLAYBACK_MIN_TTL_SECONDS,
} from './mux-playback-policy';

describe('clampMuxTtlSeconds', () => {
  it('falls back to the default when undefined', () => {
    expect(clampMuxTtlSeconds(undefined)).toBe(MUX_PLAYBACK_DEFAULT_TTL_SECONDS);
  });

  it('clamps UP to the floor', () => {
    expect(clampMuxTtlSeconds(10)).toBe(MUX_PLAYBACK_MIN_TTL_SECONDS);
  });

  it('clamps DOWN to the ceiling', () => {
    expect(clampMuxTtlSeconds(86_400)).toBe(MUX_PLAYBACK_MAX_TTL_SECONDS);
  });

  it('falls back to the default on NaN rather than propagating it', () => {
    expect(clampMuxTtlSeconds(Number('not-a-number'))).toBe(MUX_PLAYBACK_DEFAULT_TTL_SECONDS);
  });

  it('falls back to the default on Infinity', () => {
    expect(clampMuxTtlSeconds(Infinity)).toBe(MUX_PLAYBACK_DEFAULT_TTL_SECONDS);
  });

  it('passes a value already inside the bounds through unchanged', () => {
    expect(clampMuxTtlSeconds(3600)).toBe(3600);
  });
});

describe('playbackTtlForDuration', () => {
  it('a null duration yields headroom alone (900s)', () => {
    expect(playbackTtlForDuration(null)).toBe(900);
  });

  it('a zero duration also yields headroom alone', () => {
    expect(playbackTtlForDuration(0)).toBe(900);
  });

  it('adds the headroom to a real duration', () => {
    expect(playbackTtlForDuration(2700)).toBe(3600);
  });

  it('clamps a long recording to the 2h ceiling', () => {
    expect(playbackTtlForDuration(10_000)).toBe(MUX_PLAYBACK_MAX_TTL_SECONDS);
  });

  it('a short recording still gets the full headroom', () => {
    expect(playbackTtlForDuration(10)).toBe(910);
  });
});

describe('muxPlaybackManifestUrl', () => {
  it('builds the exact stream.mux.com URL', () => {
    expect(muxPlaybackManifestUrl('pb_x', 'tok')).toBe(
      'https://stream.mux.com/pb_x.m3u8?token=tok'
    );
  });
});

describe('muxThumbnailUrl', () => {
  it('builds the exact image.mux.com URL with no time query when omitted', () => {
    expect(muxThumbnailUrl('pb_x', 'tok')).toBe(
      'https://image.mux.com/pb_x/thumbnail.jpg?token=tok'
    );
  });

  it('appends &time=N when a time offset is supplied', () => {
    expect(muxThumbnailUrl('pb_x', 'tok', 14)).toBe(
      'https://image.mux.com/pb_x/thumbnail.jpg?token=tok&time=14'
    );
  });
});

describe('muxVideoSigningOptions', () => {
  it('builds the exact options object, clamping the TTL', () => {
    expect(muxVideoSigningOptions('kid', 'secret', 10)).toEqual({
      keyId: 'kid',
      keySecret: 'secret',
      type: 'video',
      expiration: `${MUX_PLAYBACK_MIN_TTL_SECONDS}s`,
    });
  });

  it('defaults the TTL when undefined', () => {
    expect(muxVideoSigningOptions('kid', 'secret', undefined)).toEqual({
      keyId: 'kid',
      keySecret: 'secret',
      type: 'video',
      expiration: `${MUX_PLAYBACK_DEFAULT_TTL_SECONDS}s`,
    });
  });
});

describe('muxThumbnailSigningOptions', () => {
  it('omits params.time when timeSeconds is not supplied', () => {
    const options = muxThumbnailSigningOptions('kid', 'secret');
    expect(options).toEqual({
      keyId: 'kid',
      keySecret: 'secret',
      type: 'thumbnail',
      expiration: `${MUX_PLAYBACK_DEFAULT_TTL_SECONDS}s`,
    });
    expect(options).not.toHaveProperty('params');
  });

  it('includes params.time (as a string) when timeSeconds is supplied', () => {
    const options = muxThumbnailSigningOptions('kid', 'secret', { timeSeconds: 14 });
    expect(options).toEqual({
      keyId: 'kid',
      keySecret: 'secret',
      type: 'thumbnail',
      expiration: `${MUX_PLAYBACK_DEFAULT_TTL_SECONDS}s`,
      params: { time: '14' },
    });
  });

  it('clamps the TTL exactly as muxVideoSigningOptions does', () => {
    const options = muxThumbnailSigningOptions('kid', 'secret', { ttlSeconds: 24 * 60 * 60 });
    expect(options.expiration).toBe(`${MUX_PLAYBACK_MAX_TTL_SECONDS}s`);
  });
});

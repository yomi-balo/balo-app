import { describe, it, expect } from 'vitest';
import { formatPlaybackDuration } from './duration';

describe('formatPlaybackDuration', () => {
  it('returns null for a null input', () => {
    expect(formatPlaybackDuration(null)).toBeNull();
  });

  it('returns null for a non-finite input', () => {
    expect(formatPlaybackDuration(Number.NaN)).toBeNull();
    expect(formatPlaybackDuration(Infinity)).toBeNull();
  });

  it.each([
    [0, '0:00'],
    [59, '0:59'],
    [60, '1:00'],
    [2712, '45:12'],
    [3599, '59:59'],
    [3600, '1:00:00'],
    [3735, '1:02:15'],
  ])('formats %i seconds as %s', (seconds, expected) => {
    expect(formatPlaybackDuration(seconds)).toBe(expected);
  });

  it('clamps a negative value to 0:00 rather than showing a negative duration', () => {
    expect(formatPlaybackDuration(-5)).toBe('0:00');
  });

  it('floors a fractional second count', () => {
    expect(formatPlaybackDuration(65.9)).toBe('1:05');
  });
});

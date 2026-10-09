import { describe, it, expect } from 'vitest';
import { EXPERT_REAPPLY_COOLDOWN_DAYS_MAX, PLATFORM_SETTINGS, parsePlatformSetting } from './index';

describe('PLATFORM_SETTINGS', () => {
  it('defaults the reapply cooldown to 60 days', () => {
    expect(PLATFORM_SETTINGS.expert_reapply_cooldown_days.defaultValue).toBe(60);
  });
});

describe('parsePlatformSetting — expert_reapply_cooldown_days', () => {
  it.each([0, 7, 60, EXPERT_REAPPLY_COOLDOWN_DAYS_MAX])('accepts the integer %s', (raw) => {
    expect(parsePlatformSetting('expert_reapply_cooldown_days', raw)).toEqual({
      value: raw,
      valid: true,
    });
  });

  it.each([
    ['a negative number', -1],
    ['a non-integer', 1.5],
    ['a value above the cap', EXPERT_REAPPLY_COOLDOWN_DAYS_MAX + 1],
    ['a numeric string', '60'],
    ['a non-numeric string', 'abc'],
    ['null', null],
    ['undefined', undefined],
    ['NaN', Number.NaN],
    ['an object', { days: 60 }],
  ])('falls back to the default for %s', (_label, raw) => {
    expect(parsePlatformSetting('expert_reapply_cooldown_days', raw)).toEqual({
      value: 60,
      valid: false,
    });
  });
});

import { describe, expect, it } from 'vitest';
import { zonesDiffer } from './index';

const SUMMER = new Date('2026-01-15T00:00:00Z');
const WINTER = new Date('2026-07-15T00:00:00Z');

describe('zonesDiffer', () => {
  it('is false for Melbourne and Sydney, which change clocks together', () => {
    expect(zonesDiffer('Australia/Melbourne', 'Australia/Sydney', SUMMER)).toBe(false);
    expect(zonesDiffer('Australia/Melbourne', 'Australia/Sydney', WINTER)).toBe(false);
  });

  it('is true for Brisbane and Sydney, including when the offsets match at `from`', () => {
    expect(zonesDiffer('Australia/Brisbane', 'Australia/Sydney', SUMMER)).toBe(true);
    expect(zonesDiffer('Australia/Brisbane', 'Australia/Sydney', WINTER)).toBe(true);
  });

  it('is true for London and Sydney', () => {
    expect(zonesDiffer('Europe/London', 'Australia/Sydney', SUMMER)).toBe(true);
  });

  it('is false for the same string', () => {
    expect(zonesDiffer('Europe/London', 'Europe/London', SUMMER)).toBe(false);
  });

  it('is false when either zone is invalid', () => {
    expect(zonesDiffer('Not/AZone', 'Europe/London', SUMMER)).toBe(false);
    expect(zonesDiffer('Europe/London', 'Not/AZone', SUMMER)).toBe(false);
  });

  it('is false for aliases of one zone', () => {
    expect(zonesDiffer('Asia/Kolkata', 'Asia/Calcutta', SUMMER)).toBe(false);
  });
});

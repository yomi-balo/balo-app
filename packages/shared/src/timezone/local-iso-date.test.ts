import { describe, expect, it } from 'vitest';
import { localIsoDate } from './index';

describe('localIsoDate', () => {
  describe('Australia/Melbourne in AEDT (UTC+11)', () => {
    it('is already the next day just after UTC midnight minus eleven hours', () => {
      // 2026-10-26T13:00Z is 00:00 on 27 Oct in Melbourne.
      expect(localIsoDate(new Date('2026-10-26T13:00:00Z'), 'Australia/Melbourne')).toBe(
        '2026-10-27'
      );
    });

    it('is still the previous day one minute before local midnight', () => {
      expect(localIsoDate(new Date('2026-10-26T12:59:00Z'), 'Australia/Melbourne')).toBe(
        '2026-10-26'
      );
    });

    it('is the local day when UTC is still on the previous day (morning in Melbourne)', () => {
      // 09:30 on 27 Oct in Melbourne is 22:30Z on 26 Oct.
      expect(localIsoDate(new Date('2026-10-26T22:30:00Z'), 'Australia/Melbourne')).toBe(
        '2026-10-27'
      );
    });
  });

  describe('Australia/Melbourne in AEST (UTC+10)', () => {
    it('rolls over at 14:00Z', () => {
      expect(localIsoDate(new Date('2026-06-15T13:59:00Z'), 'Australia/Melbourne')).toBe(
        '2026-06-15'
      );
      expect(localIsoDate(new Date('2026-06-15T14:00:00Z'), 'Australia/Melbourne')).toBe(
        '2026-06-16'
      );
    });
  });

  describe('a negative-offset zone (America/Los_Angeles, UTC-7 in PDT)', () => {
    it('is still the previous day after UTC midnight', () => {
      expect(localIsoDate(new Date('2026-07-02T03:00:00Z'), 'America/Los_Angeles')).toBe(
        '2026-07-01'
      );
    });

    it('rolls over at 07:00Z', () => {
      expect(localIsoDate(new Date('2026-07-02T06:59:00Z'), 'America/Los_Angeles')).toBe(
        '2026-07-01'
      );
      expect(localIsoDate(new Date('2026-07-02T07:00:00Z'), 'America/Los_Angeles')).toBe(
        '2026-07-02'
      );
    });
  });

  describe('fallback to UTC', () => {
    const instant = new Date('2026-10-26T22:30:00Z');

    it('uses UTC for a null or undefined zone', () => {
      expect(localIsoDate(instant, null)).toBe('2026-10-26');
      expect(localIsoDate(instant, undefined)).toBe('2026-10-26');
    });

    it('uses UTC for an empty or unrecognised zone', () => {
      expect(localIsoDate(instant, '')).toBe('2026-10-26');
      expect(localIsoDate(instant, 'Mars/Olympus_Mons')).toBe('2026-10-26');
    });

    it('accepts UTC itself', () => {
      expect(localIsoDate(instant, 'UTC')).toBe('2026-10-26');
    });
  });
});

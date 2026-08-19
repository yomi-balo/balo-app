import { describe, it, expect } from 'vitest';
import {
  PROVIDER_META,
  PROVIDER_ORDER,
  isCalendarProvider,
  isCalendarCredentialStatus,
} from './calendar-providers';

describe('isCalendarProvider', () => {
  it('accepts the two real providers', () => {
    expect(isCalendarProvider('google')).toBe(true);
    expect(isCalendarProvider('microsoft')).toBe(true);
  });

  it('rejects everything else, including near-misses and browser-editable garbage', () => {
    expect(isCalendarProvider('')).toBe(false);
    expect(isCalendarProvider(null)).toBe(false);
    expect(isCalendarProvider(undefined)).toBe(false);
    expect(isCalendarProvider('GOOGLE')).toBe(false);
    expect(isCalendarProvider('apple')).toBe(false);
    expect(isCalendarProvider('"><script>alert(1)</script>')).toBe(false);
  });
});

describe('isCalendarCredentialStatus', () => {
  it('accepts the four real DB statuses', () => {
    expect(isCalendarCredentialStatus('ACTIVE')).toBe(true);
    expect(isCalendarCredentialStatus('SYNC_PENDING')).toBe(true);
    expect(isCalendarCredentialStatus('EXPIRED')).toBe(true);
    expect(isCalendarCredentialStatus('REVOKED')).toBe(true);
  });

  it('rejects the retired legacy vocabulary and other garbage', () => {
    expect(isCalendarCredentialStatus('')).toBe(false);
    expect(isCalendarCredentialStatus(null)).toBe(false);
    expect(isCalendarCredentialStatus(undefined)).toBe(false);
    expect(isCalendarCredentialStatus('active')).toBe(false);
    expect(isCalendarCredentialStatus('connected')).toBe(false);
    expect(isCalendarCredentialStatus('auth_error')).toBe(false);
  });
});

describe('PROVIDER_ORDER / PROVIDER_META', () => {
  it('PROVIDER_ORDER matches PROVIDER_META keys exactly', () => {
    expect([...PROVIDER_ORDER].sort()).toEqual(Object.keys(PROVIDER_META).sort());
  });

  it('every provider has a label, sublabel, and icon', () => {
    for (const provider of PROVIDER_ORDER) {
      const meta = PROVIDER_META[provider];
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.sublabel.length).toBeGreaterThan(0);
      expect(meta.Icon).toBeTypeOf('function');
    }
  });
});

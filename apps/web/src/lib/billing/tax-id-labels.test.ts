import { describe, it, expect } from 'vitest';
import { BILLING_COUNTRIES, getTaxIdLabel } from './tax-id-labels';

describe('getTaxIdLabel', () => {
  it('returns the named scheme for the six explicitly-labelled countries', () => {
    expect(getTaxIdLabel('AU').label).toBe('ABN');
    expect(getTaxIdLabel('NZ').label).toBe('GST Number');
    expect(getTaxIdLabel('GB').label).toBe('VAT Number');
    expect(getTaxIdLabel('US').label).toBe('EIN (Tax ID)');
    expect(getTaxIdLabel('CA').label).toBe('Business Number (BN)');
    expect(getTaxIdLabel('SG').label).toBe('UEN');
  });

  it('maps every EU member state to the shared VAT Number bucket', () => {
    for (const code of ['FR', 'DE', 'IT', 'NL', 'IE', 'ES', 'SE', 'PL']) {
      expect(getTaxIdLabel(code).label).toBe('VAT Number');
    }
  });

  it('falls back for everything else', () => {
    for (const code of ['JP', 'CN', 'IN', 'BR', 'CH', 'AE']) {
      expect(getTaxIdLabel(code).label).toBe('Tax ID / Business Registration Number');
    }
  });

  it('is case-insensitive and tolerant of surrounding whitespace', () => {
    expect(getTaxIdLabel('au').label).toBe('ABN');
    expect(getTaxIdLabel(' fr ').label).toBe('VAT Number');
  });

  it('returns the fallback for an empty or unknown code', () => {
    expect(getTaxIdLabel('').label).toBe('Tax ID / Business Registration Number');
    expect(getTaxIdLabel('ZZ').label).toBe('Tax ID / Business Registration Number');
  });

  it('always returns a non-empty placeholder', () => {
    for (const country of BILLING_COUNTRIES) {
      expect(getTaxIdLabel(country.code).placeholder.length).toBeGreaterThan(0);
    }
  });
});

describe('BILLING_COUNTRIES', () => {
  it('uses unique, uppercase ISO 3166-1 alpha-2 codes', () => {
    const codes = BILLING_COUNTRIES.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) {
      expect(code).toMatch(/^[A-Z]{2}$/);
    }
  });

  it('includes the six named markets and is sorted by display name', () => {
    const codes = new Set(BILLING_COUNTRIES.map((c) => c.code));
    for (const named of ['AU', 'NZ', 'GB', 'US', 'CA', 'SG']) {
      expect(codes.has(named)).toBe(true);
    }
    const names = BILLING_COUNTRIES.map((c) => c.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });
});

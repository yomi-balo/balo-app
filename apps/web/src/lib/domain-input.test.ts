import { describe, it, expect } from 'vitest';
import {
  cleanDomainInput,
  isValidDomainFormat,
  validateDomainInput,
  DOMAIN_EMPTY_MESSAGE,
  DOMAIN_INVALID_FORMAT_MESSAGE,
} from './domain-input';

describe('cleanDomainInput', () => {
  it('trims, lowercases, and strips protocol / leading @ / path', () => {
    expect(cleanDomainInput('  ACME.com ')).toBe('acme.com');
    expect(cleanDomainInput('https://acme.com/teams')).toBe('acme.com');
    expect(cleanDomainInput('http://ACME.COM')).toBe('acme.com');
    expect(cleanDomainInput('@northwind.io')).toBe('northwind.io');
    expect(cleanDomainInput('acme.com/some/path')).toBe('acme.com');
  });

  it('reduces junk-only input to an empty string', () => {
    expect(cleanDomainInput('   ')).toBe('');
    expect(cleanDomainInput('@@')).toBe('');
  });
});

describe('isValidDomainFormat', () => {
  it('accepts multi-label hostnames', () => {
    expect(isValidDomainFormat('acme.com')).toBe(true);
    expect(isValidDomainFormat('north-wind.co.uk')).toBe(true);
  });

  it('rejects single labels, spaces, and empty double-dots', () => {
    expect(isValidDomainFormat('acme')).toBe(false);
    expect(isValidDomainFormat('not a domain')).toBe(false);
    expect(isValidDomainFormat('nope..com')).toBe(false);
    expect(isValidDomainFormat('')).toBe(false);
  });
});

describe('validateDomainInput', () => {
  it('returns the cleaned domain for valid input', () => {
    expect(validateDomainInput('HTTPS://Acme.com/join')).toEqual({ ok: true, domain: 'acme.com' });
  });

  it('returns the empty-message for junk-only input', () => {
    expect(validateDomainInput('   ')).toEqual({ ok: false, error: DOMAIN_EMPTY_MESSAGE });
  });

  it('returns the format-message for a malformed domain', () => {
    expect(validateDomainInput('acme')).toEqual({
      ok: false,
      error: DOMAIN_INVALID_FORMAT_MESSAGE,
    });
  });
});

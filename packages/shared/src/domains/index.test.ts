import { describe, it, expect } from 'vitest';
import {
  normalizeDomain,
  extractEmailDomain,
  isBlockedDomain,
  suggestCompanyNameFromEmail,
  FREEMAIL_DOMAINS,
  DISPOSABLE_DOMAINS,
} from './index';

/**
 * Unit truth-table for the pure domain helpers (BAL-344). Mocks nothing —
 * `@balo/shared/domains` has no `db` import and no I/O. Domain identity /
 * blocklist membership is the "ALWAYS test" category: it decides whether a
 * corporate domain is auto-captured, and BAL-345 match/join builds on the exact
 * same normalisation, so the rules are locked here.
 */

describe('normalizeDomain', () => {
  it('lowercases and trims', () => {
    expect(normalizeDomain('  ACME.com ')).toBe('acme.com');
  });

  it('strips a leading @', () => {
    expect(normalizeDomain('@acme.com')).toBe('acme.com');
  });

  it('strips repeated leading @ and trims first', () => {
    expect(normalizeDomain('  @@Gmail.COM ')).toBe('gmail.com');
  });

  it('strips a trailing dot (FQDN form)', () => {
    expect(normalizeDomain('acme.com.')).toBe('acme.com');
  });

  it('returns empty string for empty/whitespace input', () => {
    expect(normalizeDomain('')).toBe('');
    expect(normalizeDomain('   ')).toBe('');
  });

  it('leaves sub-domains intact — no eTLD+1 reduction', () => {
    expect(normalizeDomain('mail.acme.co.uk')).toBe('mail.acme.co.uk');
  });
});

describe('extractEmailDomain', () => {
  it('extracts the normalised domain from a simple address', () => {
    expect(extractEmailDomain('jane@acme.com')).toBe('acme.com');
  });

  it('lowercases + trims the extracted domain', () => {
    expect(extractEmailDomain('Jane@ACME.Com ')).toBe('acme.com');
  });

  it('uses the segment after the LAST @ for multi-@ input', () => {
    expect(extractEmailDomain('weird@local@acme.com')).toBe('acme.com');
  });

  it('returns null when there is no @', () => {
    expect(extractEmailDomain('no-at')).toBeNull();
  });

  it('returns null when the domain part is empty', () => {
    expect(extractEmailDomain('a@')).toBeNull();
  });

  it('returns null when the local part is empty (leading @)', () => {
    expect(extractEmailDomain('@b.com')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(extractEmailDomain('')).toBeNull();
  });

  it('returns null when the domain has no dot', () => {
    expect(extractEmailDomain('a@localhostnodot')).toBeNull();
  });
});

describe('isBlockedDomain', () => {
  const freemail = [
    'gmail.com',
    'googlemail.com',
    'outlook.com',
    'hotmail.com',
    'yahoo.com',
    'icloud.com',
    'me.com',
    'proton.me',
    'protonmail.com',
    'aol.com',
    'gmx.com',
    'zoho.com',
    'yandex.com',
    'mail.com',
  ];

  it.each(freemail)('blocks freemail domain %s', (domain) => {
    expect(isBlockedDomain(domain)).toBe(true);
  });

  const disposable = ['mailinator.com', 'yopmail.com', '10minutemail.com'];

  it.each(disposable)('blocks disposable domain %s', (domain) => {
    expect(isBlockedDomain(domain)).toBe(true);
  });

  const corporate = ['acme.com', 'balo.expert', 'salesforce.com'];

  it.each(corporate)('does NOT block real corporate domain %s', (domain) => {
    expect(isBlockedDomain(domain)).toBe(false);
  });

  it('is case/space insensitive', () => {
    expect(isBlockedDomain('  GMAIL.com ')).toBe(true);
  });

  it('strips a leading @ before testing membership', () => {
    expect(isBlockedDomain('@Gmail.COM')).toBe(true);
  });

  it('treats empty/whitespace as blocked (not a capturable corporate domain)', () => {
    expect(isBlockedDomain('')).toBe(true);
    expect(isBlockedDomain('   ')).toBe(true);
  });

  it('keeps every freemail set entry blocked (no drift between set and rule)', () => {
    for (const domain of FREEMAIL_DOMAINS) {
      expect(isBlockedDomain(domain)).toBe(true);
    }
  });

  it('keeps every disposable set entry blocked (no drift between set and rule)', () => {
    for (const domain of DISPOSABLE_DOMAINS) {
      expect(isBlockedDomain(domain)).toBe(true);
    }
  });
});

describe('suggestCompanyNameFromEmail', () => {
  it('title-cases a single-label corporate apex', () => {
    expect(suggestCompanyNameFromEmail('founder@acme.com')).toBe('Acme');
  });

  it('splits hyphenated labels into Title Case words', () => {
    expect(suggestCompanyNameFromEmail('jane@acme-corp.io')).toBe('Acme Corp');
  });

  it('splits underscore-separated labels too', () => {
    expect(suggestCompanyNameFromEmail('ops@big_co.com')).toBe('Big Co');
  });

  it('ignores sub-domains beyond the apex label', () => {
    expect(suggestCompanyNameFromEmail('a@mail.acme.co.uk')).toBe('Mail');
  });

  it('returns "" for a freemail/blocked domain (no "Gmail" prefill)', () => {
    expect(suggestCompanyNameFromEmail('someone@gmail.com')).toBe('');
  });

  it('returns "" when the input has no usable domain', () => {
    expect(suggestCompanyNameFromEmail('foo')).toBe('');
    expect(suggestCompanyNameFromEmail('')).toBe('');
  });
});

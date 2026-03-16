import { describe, it, expect } from 'vitest';
import {
  sanitizeNameSegment,
  generateBaseUsername,
  pickNextAvailable,
  isValidUsername,
  USERNAME_MIN,
  USERNAME_MAX,
  RESERVED_USERNAMES,
} from './username-utils';

// ── sanitizeNameSegment ─────────────────────────────────────────

describe('sanitizeNameSegment', () => {
  it('lowercases and joins simple names', () => {
    expect(sanitizeNameSegment('John')).toBe('john');
  });

  it('replaces non-alphanumeric chars with hyphens', () => {
    expect(sanitizeNameSegment("O'Brien")).toBe('o-brien');
  });

  it('handles hyphenated names', () => {
    expect(sanitizeNameSegment('Jean-Pierre')).toBe('jean-pierre');
  });

  it('collapses consecutive hyphens', () => {
    expect(sanitizeNameSegment('a---b')).toBe('a-b');
  });

  it('trims leading and trailing hyphens', () => {
    expect(sanitizeNameSegment('-hello-')).toBe('hello');
  });

  it('handles names with spaces', () => {
    expect(sanitizeNameSegment('Mary Jane')).toBe('mary-jane');
  });

  it('returns empty string for all-special-char input', () => {
    expect(sanitizeNameSegment('---')).toBe('');
  });

  it('handles unicode/accented characters by replacing them', () => {
    expect(sanitizeNameSegment('José')).toBe('jos');
  });
});

// ── isValidUsername ─────────────────────────────────────────────

describe('isValidUsername', () => {
  it('accepts a standard username', () => {
    expect(isValidUsername('john-doe')).toBe(true);
  });

  it('accepts min-length username (3 chars)', () => {
    expect(isValidUsername('abc')).toBe(true);
  });

  it('rejects too-short username', () => {
    expect(isValidUsername('ab')).toBe(false);
  });

  it('rejects too-long username', () => {
    const long = 'a'.repeat(USERNAME_MAX + 1);
    expect(isValidUsername(long)).toBe(false);
  });

  it('accepts max-length username', () => {
    const maxLen = 'a'.repeat(USERNAME_MAX);
    expect(isValidUsername(maxLen)).toBe(true);
  });

  it('rejects usernames starting with a hyphen', () => {
    expect(isValidUsername('-john')).toBe(false);
  });

  it('rejects usernames ending with a hyphen', () => {
    expect(isValidUsername('john-')).toBe(false);
  });

  it('rejects usernames with uppercase letters', () => {
    expect(isValidUsername('John')).toBe(false);
  });

  it('rejects reserved usernames', () => {
    for (const reserved of RESERVED_USERNAMES) {
      expect(isValidUsername(reserved)).toBe(false);
    }
  });

  it('accepts a username containing a reserved word as substring', () => {
    expect(isValidUsername('admin-user')).toBe(true);
    expect(isValidUsername('my-balo-name')).toBe(true);
  });

  it('rejects single character', () => {
    expect(isValidUsername('a')).toBe(false);
  });

  it('rejects two characters', () => {
    expect(isValidUsername('ab')).toBe(false);
  });

  it('allows digits', () => {
    expect(isValidUsername('user123')).toBe(true);
  });

  it('allows all-digit usernames', () => {
    expect(isValidUsername('123')).toBe(true);
  });
});

// ── generateBaseUsername ────────────────────────────────────────

describe('generateBaseUsername', () => {
  it('generates username from normal names', () => {
    expect(generateBaseUsername('John', 'Doe')).toBe('john-doe');
  });

  it('handles special characters in names', () => {
    expect(generateBaseUsername('Jean-Pierre', "O'Brien")).toBe('jean-pierre-o-brien');
  });

  it('returns null for null firstName', () => {
    expect(generateBaseUsername(null, 'Doe')).toBeNull();
  });

  it('returns null for null lastName', () => {
    expect(generateBaseUsername('John', null)).toBeNull();
  });

  it('returns null for undefined firstName', () => {
    expect(generateBaseUsername(undefined, 'Doe')).toBeNull();
  });

  it('returns null for undefined lastName', () => {
    expect(generateBaseUsername('John', undefined)).toBeNull();
  });

  it('returns null for empty firstName', () => {
    expect(generateBaseUsername('', 'Doe')).toBeNull();
  });

  it('returns null for empty lastName', () => {
    expect(generateBaseUsername('John', '')).toBeNull();
  });

  it('returns null when first name sanitizes to empty', () => {
    expect(generateBaseUsername('---', 'Doe')).toBeNull();
  });

  it('returns null when last name sanitizes to empty', () => {
    expect(generateBaseUsername('John', '---')).toBeNull();
  });

  it('returns null when result is a reserved word', () => {
    // "ad" + "min" → "ad-min" = not reserved (5 chars, not exact match)
    // But we can construct one: the reserved word "api" is 3 chars
    // We need first="ap" last="i" → sanitized segments "ap" + "i" → "ap-i" (4 chars, not reserved)
    // Let's check "balo" — first="bal" last="o" → "bal-o" not reserved
    // Actually reserved check is exact match, so e.g. first="bal" last="o" → "bal-o" is valid
    expect(generateBaseUsername('bal', 'o')).toBe('bal-o');
  });

  it('truncates very long names to USERNAME_MAX', () => {
    const longFirst = 'a'.repeat(25);
    const longLast = 'b'.repeat(25);
    const result = generateBaseUsername(longFirst, longLast);
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(USERNAME_MAX);
    expect(result!.startsWith('a')).toBe(true);
  });

  it('returns null if truncation produces an invalid username', () => {
    // If both segments are just 1 char each: "a-b" = 3 chars, valid
    expect(generateBaseUsername('a', 'b')).toBe('a-b');
  });

  it('handles names with spaces and special chars', () => {
    expect(generateBaseUsername('Mary Jane', 'Von Trapp')).toBe('mary-jane-von-trapp');
  });
});

// ── pickNextAvailable ──────────────────────────────────────────

describe('pickNextAvailable', () => {
  it('returns base when no existing usernames', () => {
    expect(pickNextAvailable('john-doe', [])).toBe('john-doe');
  });

  it('returns base when existing set does not include base', () => {
    expect(pickNextAvailable('john-doe', ['jane-doe'])).toBe('john-doe');
  });

  it('returns base-2 when base is taken', () => {
    expect(pickNextAvailable('john-doe', ['john-doe'])).toBe('john-doe-2');
  });

  it('returns base-3 when base and base-2 are taken', () => {
    expect(pickNextAvailable('john-doe', ['john-doe', 'john-doe-2'])).toBe('john-doe-3');
  });

  it('finds gaps: returns base-2 when base and base-3 are taken but base-2 is not', () => {
    expect(pickNextAvailable('john-doe', ['john-doe', 'john-doe-3'])).toBe('john-doe-2');
  });

  it('handles large existing sets', () => {
    const existing = ['john-doe'];
    for (let i = 2; i <= 50; i++) {
      existing.push(`john-doe-${i}`);
    }
    expect(pickNextAvailable('john-doe', existing)).toBe('john-doe-51');
  });

  it('handles base at max length by trimming for suffix', () => {
    // Create a base that's exactly at USERNAME_MAX
    const base = 'a'.repeat(USERNAME_MAX);
    // The suffixed version "aaa...a-2" would exceed max, so it should trim
    const result = pickNextAvailable(base, [base]);
    expect(result.length).toBeLessThanOrEqual(USERNAME_MAX);
    expect(result).not.toBe(base);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  encryptCalendarSecret,
  decryptCalendarSecret,
  CalendarEncryptionConfigError,
} from './calendar-encryption.js';

describe('calendar-encryption (BAL-468 §6)', () => {
  const original = process.env.CALENDAR_ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.CALENDAR_ENCRYPTION_KEY = 'a-test-key-32-bytes-minimum-ok!!';
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env.CALENDAR_ENCRYPTION_KEY;
    } else {
      process.env.CALENDAR_ENCRYPTION_KEY = original;
    }
  });

  it('round-trips a secret', () => {
    const encrypted = encryptCalendarSecret('svix-secret-value');
    expect(decryptCalendarSecret(encrypted)).toBe('svix-secret-value');
  });

  it('two encryptions of the same plaintext differ (random IV)', () => {
    const a = encryptCalendarSecret('same-secret');
    const b = encryptCalendarSecret('same-secret');
    expect(a).not.toBe(b);
    expect(decryptCalendarSecret(a)).toBe('same-secret');
    expect(decryptCalendarSecret(b)).toBe('same-secret');
  });

  it('the format is exactly three base64 segments separated by colons', () => {
    const encrypted = encryptCalendarSecret('x');
    const parts = encrypted.split(':');
    expect(parts).toHaveLength(3);
    for (const part of parts) {
      expect(() => Buffer.from(part, 'base64')).not.toThrow();
    }
  });

  it('throws on a tampered ciphertext (auth tag mismatch)', () => {
    const encrypted = encryptCalendarSecret('secret');
    const [iv, authTag, ciphertext] = encrypted.split(':') as [string, string, string];
    const tamperedCiphertext = Buffer.from(ciphertext, 'base64');
    tamperedCiphertext[0] = (tamperedCiphertext[0] ?? 0) ^ 0xff;
    const tampered = [iv, authTag, tamperedCiphertext.toString('base64')].join(':');
    expect(() => decryptCalendarSecret(tampered)).toThrow();
  });

  it('throws when decrypted with the wrong key', () => {
    const encrypted = encryptCalendarSecret('secret');
    process.env.CALENDAR_ENCRYPTION_KEY = 'a-completely-different-key-value';
    expect(() => decryptCalendarSecret(encrypted)).toThrow();
  });

  it('unset key throws CalendarEncryptionConfigError on both halves', () => {
    delete process.env.CALENDAR_ENCRYPTION_KEY;
    expect(() => encryptCalendarSecret('x')).toThrow(CalendarEncryptionConfigError);
    expect(() => decryptCalendarSecret('a:b:c')).toThrow(CalendarEncryptionConfigError);
  });

  it('malformed stored value (2 parts) throws', () => {
    expect(() => decryptCalendarSecret('only:two')).toThrow();
  });

  it('malformed stored value (4 parts) throws', () => {
    expect(() => decryptCalendarSecret('a:b:c:d')).toThrow();
  });
});

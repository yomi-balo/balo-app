import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('calendar-encryption', () => {
  const MOCK_KEY = 'test-encryption-key-for-unit-tests';
  let encryptCalendarToken: typeof import('./calendar-encryption').encryptCalendarToken;
  let decryptCalendarToken: typeof import('./calendar-encryption').decryptCalendarToken;

  beforeEach(async () => {
    process.env.CALENDAR_ENCRYPTION_KEY = MOCK_KEY;
    // Re-import to pick up env var
    vi.resetModules();
    const mod = await import('./calendar-encryption');
    encryptCalendarToken = mod.encryptCalendarToken;
    decryptCalendarToken = mod.decryptCalendarToken;
  });

  afterEach(() => {
    delete process.env.CALENDAR_ENCRYPTION_KEY;
  });

  it('encrypts and decrypts a token round-trip', () => {
    const plaintext = 'my-secret-access-token';
    const encrypted = encryptCalendarToken(plaintext);
    const decrypted = decryptCalendarToken(encrypted);
    expect(decrypted).toBe(plaintext);
  });

  it('produces format iv:authTag:ciphertext', () => {
    const encrypted = encryptCalendarToken('test');
    const parts = encrypted.split(':');
    expect(parts.length).toBe(3);
    // Each part should be valid base64
    for (const part of parts) {
      expect(() => Buffer.from(part, 'base64')).not.toThrow();
    }
  });

  it('two encryptions of the same value produce different ciphertexts (random IV)', () => {
    const plaintext = 'same-value-both-times';
    const enc1 = encryptCalendarToken(plaintext);
    const enc2 = encryptCalendarToken(plaintext);
    expect(enc1).not.toBe(enc2);
    // Both should decrypt to the same value
    expect(decryptCalendarToken(enc1)).toBe(plaintext);
    expect(decryptCalendarToken(enc2)).toBe(plaintext);
  });

  it('throws when decrypting tampered ciphertext', () => {
    const encrypted = encryptCalendarToken('secret');
    const parts = encrypted.split(':');
    // Tamper with the ciphertext portion
    const tampered = `${parts[0]}:${parts[1]}:${Buffer.from('tampered').toString('base64')}`;
    expect(() => decryptCalendarToken(tampered)).toThrow();
  });

  it('throws when decrypting tampered auth tag', () => {
    const encrypted = encryptCalendarToken('secret');
    const parts = encrypted.split(':');
    // Tamper with the auth tag
    const tampered = `${parts[0]}:${Buffer.from('badtag1234567890').toString('base64')}:${parts[2]}`;
    expect(() => decryptCalendarToken(tampered)).toThrow();
  });

  it('throws when encrypted value format is invalid', () => {
    expect(() => decryptCalendarToken('not-valid-format')).toThrow(
      'Invalid encrypted value format'
    );
  });

  it('throws when CALENDAR_ENCRYPTION_KEY is not set', async () => {
    delete process.env.CALENDAR_ENCRYPTION_KEY;
    vi.resetModules();
    const mod = await import('./calendar-encryption');
    expect(() => mod.encryptCalendarToken('test')).toThrow(
      'CALENDAR_ENCRYPTION_KEY is not configured'
    );
  });

  it('throws on decrypt when CALENDAR_ENCRYPTION_KEY is not set', async () => {
    const encrypted = encryptCalendarToken('test');
    delete process.env.CALENDAR_ENCRYPTION_KEY;
    vi.resetModules();
    const mod = await import('./calendar-encryption');
    expect(() => mod.decryptCalendarToken(encrypted)).toThrow(
      'CALENDAR_ENCRYPTION_KEY is not configured'
    );
  });
});

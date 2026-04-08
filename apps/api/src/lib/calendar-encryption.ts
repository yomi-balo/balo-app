import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';

/**
 * Returns the derived AES-256 key from CALENDAR_ENCRYPTION_KEY env var.
 * Uses SHA-256 hash to derive a 32-byte key (same pattern as payout encryption).
 */
function getKey(): Buffer {
  const key = process.env.CALENDAR_ENCRYPTION_KEY;
  if (!key) {
    throw new Error('CALENDAR_ENCRYPTION_KEY is not configured');
  }
  return crypto.createHash('sha256').update(key).digest();
}

/**
 * Encrypts a plaintext string using AES-256-GCM.
 * Returns format: `iv:authTag:ciphertext` (all base64).
 */
export function encryptCalendarToken(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`;
}

/**
 * Decrypts a value encrypted by `encryptCalendarToken()`.
 * Expects format: `iv:authTag:ciphertext` (all base64), AES-256-GCM.
 */
export function decryptCalendarToken(encryptedValue: string): string {
  const key = getKey();

  const parts = encryptedValue.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted value format — expected iv:authTag:ciphertext');
  }

  const [ivB64, authTagB64, ciphertextB64] = parts as [string, string, string];
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');
  const ciphertext = Buffer.from(ciphertextB64, 'base64');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf-8');
}

import crypto from 'crypto';

/**
 * Decrypts a value that was encrypted by `encryptValue()` in the web app.
 *
 * Format: `iv:authTag:ciphertext` (all base64), AES-256-GCM.
 * Key derived from SHA-256 hash of PAYOUT_ENCRYPTION_KEY env var.
 */
export function decryptValue(encryptedValue: string): string {
  const key = process.env.PAYOUT_ENCRYPTION_KEY;
  if (!key) {
    throw new Error('PAYOUT_ENCRYPTION_KEY is not configured');
  }

  const derivedKey = crypto.createHash('sha256').update(key).digest();

  const parts = encryptedValue.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted value format — expected iv:authTag:ciphertext');
  }

  const [ivB64, authTagB64, ciphertextB64] = parts as [string, string, string];
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');
  const ciphertext = Buffer.from(ciphertextB64, 'base64');

  const decipher = crypto.createDecipheriv('aes-256-gcm', derivedKey, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf-8');
}

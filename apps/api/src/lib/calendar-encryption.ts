import crypto from 'node:crypto';

/**
 * BAL-468 §6 — the cipher for `calendar_subscriptions.endpoint_secret` at rest.
 *
 * ⚠ A NEW, SEPARATE key — `CALENDAR_ENCRYPTION_KEY` — never `PAYOUT_ENCRYPTION_KEY`
 * (`lib/encryption.ts`). Different trust boundary, and that module is decrypt-only anyway
 * (there is no `encryptValue` in this repo to reuse for the encrypt half).
 *
 * Format: `iv:authTag:ciphertext`, all base64. AES-256-GCM, 12-byte IV (the GCM standard).
 * Key: `sha256(CALENDAR_ENCRYPTION_KEY)` — the same derivation `lib/encryption.ts` uses, so
 * the wire format is familiar to a reviewer who knows the payout cipher.
 *
 * ⚠ Unset key → throws `CalendarEncryptionConfigError`, never a silent `!`. Callers map it:
 * the webhook route → 503 (an outage, not a bad request); the reconciler → skip with reason
 * `cipher_not_configured` and zero vendor calls (a create whose secret cannot be persisted
 * would leave an un-verifiable, un-deletable orphan).
 *
 * ⚠ Malformed stored value (not three colon-separated parts), a tampered ciphertext (auth-tag
 * mismatch), or a rotated key all throw — `crypto` throws on `.final()` for the auth-tag case.
 * Let it propagate to the same 503/skip mapping.
 *
 * ⚠ NEVER log, track, or put in an error body: not the plaintext secret, not the ciphertext,
 * not the derived key. The secret is the only thing between a guessed webhook URL and a
 * forged availability rebuild.
 *
 * ⚠⚠ KEY ROTATION IS DESTRUCTIVE. There is no dual-key read path in this module. Rotating
 * `CALENDAR_ENCRYPTION_KEY` makes every stored `endpoint_secret` undecryptable — every
 * inbound delivery answers 503 until every `calendar_subscriptions` row is soft-deleted and
 * the reconciler rebuilds them (self-healing via the orphan rule). See BAL-468 plan §17.
 */
export class CalendarEncryptionConfigError extends Error {
  constructor(detail: string) {
    super(`Calendar encryption configuration error: ${detail}`);
    this.name = 'CalendarEncryptionConfigError';
    Object.setPrototypeOf(this, CalendarEncryptionConfigError.prototype);
  }
}

const IV_LENGTH_BYTES = 12;
const ALGORITHM = 'aes-256-gcm';

function deriveKey(): Buffer {
  const key = process.env.CALENDAR_ENCRYPTION_KEY;
  if (!key) {
    throw new CalendarEncryptionConfigError('CALENDAR_ENCRYPTION_KEY is not set');
  }
  return crypto.createHash('sha256').update(key).digest();
}

/** `iv:authTag:ciphertext`, all base64. A fresh random IV every call — two encryptions of the
 *  same plaintext never produce the same ciphertext. */
export function encryptCalendarSecret(plaintext: string): string {
  const key = deriveKey();
  const iv = crypto.randomBytes(IV_LENGTH_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv, authTag, ciphertext].map((buf) => buf.toString('base64')).join(':');
}

export function decryptCalendarSecret(encrypted: string): string {
  const key = deriveKey();
  const parts = encrypted.split(':');
  if (parts.length !== 3) {
    throw new Error('Malformed encrypted value — expected iv:authTag:ciphertext');
  }
  const [ivB64, authTagB64, ciphertextB64] = parts as [string, string, string];
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');
  const ciphertext = Buffer.from(ciphertextB64, 'base64');

  // The decrypt half reads the IV length from the stored value rather than asserting
  // IV_LENGTH_BYTES, so it stays compatible with any length a future writer might use.
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

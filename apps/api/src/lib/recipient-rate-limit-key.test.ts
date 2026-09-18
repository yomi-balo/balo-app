import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hashRateLimitRecipient } from './recipient-rate-limit-key.js';

describe('hashRateLimitRecipient', () => {
  it('never returns the raw address', () => {
    const hash = hashRateLimitRecipient('dana@northwind.test');
    expect(hash).not.toContain('dana');
    expect(hash).not.toContain('northwind');
    expect(hash).not.toContain('@');
  });

  it('is deterministic for the same input', () => {
    expect(hashRateLimitRecipient('dana@northwind.test')).toBe(
      hashRateLimitRecipient('dana@northwind.test')
    );
  });

  it('differs for different addresses', () => {
    expect(hashRateLimitRecipient('dana@northwind.test')).not.toBe(
      hashRateLimitRecipient('priya@northwind.test')
    );
  });

  it('is the first 32 hex characters of the SHA-256 digest', () => {
    const full = createHash('sha256').update('dana@northwind.test').digest('hex');
    expect(hashRateLimitRecipient('dana@northwind.test')).toBe(full.slice(0, 32));
    expect(hashRateLimitRecipient('dana@northwind.test')).toHaveLength(32);
  });

  it('is sensitive to case — the caller is responsible for canonicalising first', () => {
    // ⚠ Pins that this function does NOT canonicalise, so a caller that forgets
    // `canonicalGuestEmail` gets a silently different bucket rather than a loud failure.
    expect(hashRateLimitRecipient('DANA@northwind.test')).not.toBe(
      hashRateLimitRecipient('dana@northwind.test')
    );
  });
});

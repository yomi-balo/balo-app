import { describe, it, expect } from 'vitest';
import { deriveBookingIdempotencyKey } from './booking-idempotency';

describe('deriveBookingIdempotencyKey', () => {
  it('is deterministic for the same (userId, nonce) pair', () => {
    const a = deriveBookingIdempotencyKey('user-1', 'nonce-1');
    const b = deriveBookingIdempotencyKey('user-1', 'nonce-1');
    expect(a).toBe(b);
  });

  it('produces a different key for a different user with the same nonce', () => {
    const a = deriveBookingIdempotencyKey('user-1', 'nonce-1');
    const b = deriveBookingIdempotencyKey('user-2', 'nonce-1');
    expect(a).not.toBe(b);
  });

  it('produces a different key for a different nonce with the same user', () => {
    const a = deriveBookingIdempotencyKey('user-1', 'nonce-1');
    const b = deriveBookingIdempotencyKey('user-1', 'nonce-2');
    expect(a).not.toBe(b);
  });

  it('outputs a lowercase 64-char hex digest', () => {
    const key = deriveBookingIdempotencyKey('user-1', 'nonce-1');
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });
});

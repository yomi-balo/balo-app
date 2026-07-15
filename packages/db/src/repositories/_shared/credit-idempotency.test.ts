import { describe, it, expect } from 'vitest';
import { deriveIdempotencyKey, type IdempotencyKeyInput } from './credit-idempotency';

/**
 * Unit tests for the PURE state-derived idempotency-key helper (BAL-376). Mocks
 * nothing — the module has no `db`, no I/O, no `randomUUID`. The single guarantee is
 * DETERMINISM: identical triggering state ⇒ identical key (so Stripe replays / BullMQ
 * retries collapse to a no-op, invariant #4), and DIFFERENT state ⇒ different key (so
 * distinct events never accidentally dedup into one).
 */

describe('deriveIdempotencyKey — per-reason shape', () => {
  it('keys a manual purchase on the Stripe PaymentIntent id', () => {
    expect(deriveIdempotencyKey({ reason: 'manual_purchase', paymentIntentId: 'pi_123' })).toBe(
      'manual_purchase:pi_123'
    );
  });

  it('keys an auto-top-up on wallet + the threshold-crossing entry (one reload per crossing)', () => {
    expect(
      deriveIdempotencyKey({
        reason: 'auto_topup',
        walletId: 'wal_1',
        triggeringEntryId: 'led_9',
      })
    ).toBe('auto_topup:wal_1:led_9');
  });

  it('keys an overdraft settlement on the session (exactly one settlement per session)', () => {
    expect(deriveIdempotencyKey({ reason: 'overdraft_settlement', sessionId: 'sess_abc' })).toBe(
      'overdraft_settlement:sess_abc'
    );
  });

  it('keys a session consume on session + per-minute tick sequence', () => {
    expect(
      deriveIdempotencyKey({ reason: 'session_consume', sessionId: 'sess_abc', tickSeq: 5 })
    ).toBe('session_consume:sess_abc:5');
  });

  it('keys a dormancy expiry on wallet + sweep date', () => {
    expect(
      deriveIdempotencyKey({ reason: 'dormancy_expiry', walletId: 'wal_1', asOf: '2026-07-15' })
    ).toBe('dormancy_expiry:wal_1:2026-07-15');
  });

  it('keys a promo grant on wallet + promo code (one grant per promo per wallet)', () => {
    expect(deriveIdempotencyKey({ reason: 'promo', walletId: 'wal_1', promoCode: 'SUMMER' })).toBe(
      'promo:wal_1:SUMMER'
    );
  });

  it('keys an adjustment on the admin-supplied token', () => {
    expect(deriveIdempotencyKey({ reason: 'adjustment', token: 'tok_1' })).toBe('adjustment:tok_1');
  });
});

describe('deriveIdempotencyKey — determinism & collision-freedom', () => {
  it('is deterministic: identical state yields an identical key (replay collapses to a no-op)', () => {
    const input: IdempotencyKeyInput = {
      reason: 'auto_topup',
      walletId: 'wal_1',
      triggeringEntryId: 'led_9',
    };
    expect(deriveIdempotencyKey(input)).toBe(deriveIdempotencyKey({ ...input }));
  });

  it('distinguishes consecutive consume ticks on the same session (no accidental dedup)', () => {
    const a = deriveIdempotencyKey({
      reason: 'session_consume',
      sessionId: 'sess_abc',
      tickSeq: 1,
    });
    const b = deriveIdempotencyKey({
      reason: 'session_consume',
      sessionId: 'sess_abc',
      tickSeq: 2,
    });
    expect(a).not.toBe(b);
  });

  it('distinguishes settlements of different sessions', () => {
    const a = deriveIdempotencyKey({ reason: 'overdraft_settlement', sessionId: 'sess_a' });
    const b = deriveIdempotencyKey({ reason: 'overdraft_settlement', sessionId: 'sess_b' });
    expect(a).not.toBe(b);
  });

  it('namespaces by reason: a purchase and a promo with the same wallet-ish token never collide', () => {
    const purchase = deriveIdempotencyKey({ reason: 'manual_purchase', paymentIntentId: 'x' });
    const adjustment = deriveIdempotencyKey({ reason: 'adjustment', token: 'x' });
    expect(purchase).not.toBe(adjustment);
    expect(purchase.startsWith('manual_purchase:')).toBe(true);
    expect(adjustment.startsWith('adjustment:')).toBe(true);
  });
});

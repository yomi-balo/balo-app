import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { db } from '../client';
import { stripeWebhookEventsRepository } from './stripe-webhook-events';

/**
 * Integration tests for `stripeWebhookEventsRepository` (BAL-382) — the event-id
 * idempotency log for the single Stripe webhook. Self-contained rows (`event_id` is a
 * free text key — no factory needed). Uses the in-harness `db` (per-test transaction,
 * auto-rolled-back); the write methods take a `DbExecutor` and the harness `db` IS that
 * per-test transaction.
 */

describe('stripeWebhookEventsRepository.insertReceived', () => {
  it('inserts the marker on first sight and returns the row', async () => {
    const eventId = `evt_${randomUUID()}`;
    const row = await stripeWebhookEventsRepository.insertReceived(
      { eventId, type: 'payment_intent.succeeded' },
      db
    );
    expect(row).toBeDefined();
    expect(row?.eventId).toBe(eventId);
    expect(row?.type).toBe('payment_intent.succeeded');
    expect(row?.payloadHash).toBeNull();
    expect(row?.receivedAt).toBeInstanceOf(Date);
    expect(row?.processedAt).toBeNull();
  });

  it('returns undefined on a conflicting second insert with the same event_id (idempotent)', async () => {
    const eventId = `evt_${randomUUID()}`;
    const first = await stripeWebhookEventsRepository.insertReceived(
      { eventId, type: 'setup_intent.succeeded' },
      db
    );
    expect(first).toBeDefined();

    const second = await stripeWebhookEventsRepository.insertReceived(
      { eventId, type: 'setup_intent.succeeded' },
      db
    );
    expect(second).toBeUndefined();

    // Still exactly one row for that event id — the first one.
    const found = await stripeWebhookEventsRepository.findByEventId(eventId);
    expect(found?.id).toBe(first?.id);
  });

  it('persists an optional payload hash when provided', async () => {
    const eventId = `evt_${randomUUID()}`;
    const row = await stripeWebhookEventsRepository.insertReceived(
      { eventId, type: 'charge.dispute.created', payloadHash: 'sha256:abc' },
      db
    );
    expect(row?.payloadHash).toBe('sha256:abc');
  });
});

describe('stripeWebhookEventsRepository.findByEventId', () => {
  it('returns the marker when present and undefined when absent', async () => {
    const eventId = `evt_${randomUUID()}`;
    await stripeWebhookEventsRepository.insertReceived(
      { eventId, type: 'payment_intent.payment_failed' },
      db
    );

    const found = await stripeWebhookEventsRepository.findByEventId(eventId);
    expect(found?.eventId).toBe(eventId);

    const missing = await stripeWebhookEventsRepository.findByEventId(`evt_${randomUUID()}`);
    expect(missing).toBeUndefined();
  });
});

describe('stripeWebhookEventsRepository.markProcessed', () => {
  it('stamps processed_at (null → a timestamp)', async () => {
    const eventId = `evt_${randomUUID()}`;
    await stripeWebhookEventsRepository.insertReceived(
      { eventId, type: 'payment_intent.succeeded' },
      db
    );

    const before = await stripeWebhookEventsRepository.findByEventId(eventId);
    expect(before?.processedAt).toBeNull();

    await stripeWebhookEventsRepository.markProcessed(eventId, db);

    const after = await stripeWebhookEventsRepository.findByEventId(eventId);
    expect(after?.processedAt).toBeInstanceOf(Date);
  });

  /**
   * BAL-515 — the two tests below are the repository half of the webhook commit proof. Together
   * they pin that the return value DISCRIMINATES: `true` only when a row was actually stamped,
   * `false` when the UPDATE matched nothing. Against the pre-fix `Promise<void>` signature both
   * calls resolve `undefined`, so `toBe(true)` and `toBe(false)` cannot both pass — the pair
   * fails on reverted source rather than merely being green on fixed source.
   *
   * The `false` case is the one that lost money's cousin: an event id whose marker is missing or
   * (mid-phantom-commit) invisible was previously indistinguishable from a successful stamp, so
   * the route could ack 200 for an effect with no marker.
   */
  it('returns TRUE when it stamps an existing row', async () => {
    const eventId = `evt_${randomUUID()}`;
    await stripeWebhookEventsRepository.insertReceived(
      { eventId, type: 'payment_intent.succeeded' },
      db
    );

    await expect(stripeWebhookEventsRepository.markProcessed(eventId, db)).resolves.toBe(true);
  });

  it('returns FALSE for an unknown event id (updates zero rows, does not throw)', async () => {
    await expect(
      stripeWebhookEventsRepository.markProcessed(`evt_${randomUUID()}`, db)
    ).resolves.toBe(false);
  });
});

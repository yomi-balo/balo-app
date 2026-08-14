import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../client';
import { dailyWebhookEvents } from '../schema';
import { dailyWebhookEventsRepository } from './daily-webhook-events';

/**
 * Integration tests for `dailyWebhookEventsRepository` (BAL-134, Decision D2) — the event-id
 * idempotency log for the single Daily webhook.
 *
 * Self-contained rows: `event_id` is a free text key with no FK, so no factory is needed (the
 * `stripe-webhook-events.integration.test.ts` precedent this file deliberately mirrors). Uses
 * the in-harness `db`, which IS the per-test transaction, and which therefore also satisfies
 * the `DbExecutor` both write methods demand.
 */

/** A fresh, collision-proof Daily-shaped event id. */
function eventId(): string {
  return `evt-${randomUUID()}`;
}

describe('dailyWebhookEventsRepository.insertReceived', () => {
  it('inserts the marker on first sight, with processed_at still NULL', async () => {
    const id = eventId();

    const row = await dailyWebhookEventsRepository.insertReceived(
      { eventId: id, type: 'participant.joined', roomName: 'balo-abc' },
      db
    );

    expect(row).toBeDefined();
    expect(row?.eventId).toBe(id);
    expect(row?.type).toBe('participant.joined');
    expect(row?.roomName).toBe('balo-abc');
    expect(row?.payloadHash).toBeNull();
    expect(row?.receivedAt).toBeInstanceOf(Date);
    // ⚠ NULL AT INSERT IS THE WHOLE PROTOCOL: the marker means "received", never "applied".
    // The effect stamps it, inside the same transaction.
    expect(row?.processedAt).toBeNull();
  });

  it('THE REPLAY: a second insert of the same event_id returns undefined and writes nothing', async () => {
    const id = eventId();

    const first = await dailyWebhookEventsRepository.insertReceived(
      { eventId: id, type: 'participant.joined' },
      db
    );
    expect(first).toBeDefined();

    // This is the case D2 exists for. Without the marker, a `participant.joined` replayed
    // AFTER its interval legitimately closed would insert a SECOND presence interval anchored
    // at the OLD joined_at with no left_at — an open interval in the past, i.e. a silent
    // unbounded over-bill. `undefined` here is the caller's signal to abandon the effect.
    const replay = await dailyWebhookEventsRepository.insertReceived(
      { eventId: id, type: 'participant.joined' },
      db
    );
    expect(replay).toBeUndefined();

    const rows = await db
      .select()
      .from(dailyWebhookEvents)
      .where(eq(dailyWebhookEvents.eventId, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(first?.id);
  });

  it('a replay does NOT overwrite the first delivery’s recorded fields', async () => {
    const id = eventId();
    await dailyWebhookEventsRepository.insertReceived(
      { eventId: id, type: 'participant.joined', roomName: 'balo-first', payloadHash: 'sha256:1' },
      db
    );

    // `onConflictDoNothing`, not `onConflictDoUpdate` — the incumbent row is left
    // BYTE-IDENTICAL. A retry that arrived with a different body must never rewrite the
    // record of what was actually processed.
    await dailyWebhookEventsRepository.insertReceived(
      { eventId: id, type: 'participant.left', roomName: 'balo-second', payloadHash: 'sha256:2' },
      db
    );

    const found = await dailyWebhookEventsRepository.findByEventId(id);
    expect(found?.type).toBe('participant.joined');
    expect(found?.roomName).toBe('balo-first');
    expect(found?.payloadHash).toBe('sha256:1');
  });

  it('persists an optional payload hash, and defaults both optional columns to NULL', async () => {
    const withHash = await dailyWebhookEventsRepository.insertReceived(
      { eventId: eventId(), type: 'meeting.ended', payloadHash: 'sha256:abc' },
      db
    );
    expect(withHash?.payloadHash).toBe('sha256:abc');

    // `room_name` is nullable because not every Daily event names a room — an event that does
    // not must still get a marker, or its replay is unguarded.
    const bare = await dailyWebhookEventsRepository.insertReceived(
      { eventId: eventId(), type: 'meeting.ended' },
      db
    );
    expect(bare?.roomName).toBeNull();
    expect(bare?.payloadHash).toBeNull();
  });

  it('CONCURRENT DELIVERY: two callers issue the same event_id and exactly ONE wins', async () => {
    const id = eventId();

    // ⚠ HONEST ABOUT WHAT THIS DOES AND DOES NOT PROVE. The harness runs every test inside ONE
    // transaction on a `max: 1` pool, so a genuine interleaving is INEXPRESSIBLE here — these
    // two calls serialize on the single connection (memory
    // `reference_db_integration_harness_no_concurrency`). What it pins is the OUTCOME the
    // unique index must produce for two deliveries of one event id — exactly one row, exactly
    // one non-undefined return — which is the property the webhook branches on. The real
    // interleaving is Postgres's to serialise: the second INSERT would block on the unique
    // index and then find the conflict, reaching the same result by a different route.
    const results = await Promise.all([
      dailyWebhookEventsRepository.insertReceived({ eventId: id, type: 'participant.left' }, db),
      dailyWebhookEventsRepository.insertReceived({ eventId: id, type: 'participant.left' }, db),
    ]);

    const winners = results.filter((row) => row !== undefined);
    expect(winners).toHaveLength(1);

    const rows = await db
      .select()
      .from(dailyWebhookEvents)
      .where(eq(dailyWebhookEvents.eventId, id));
    expect(rows).toHaveLength(1);
  });

  it('distinct event ids never collide, even with an identical type and room', async () => {
    const first = await dailyWebhookEventsRepository.insertReceived(
      { eventId: eventId(), type: 'participant.joined', roomName: 'balo-same' },
      db
    );
    const second = await dailyWebhookEventsRepository.insertReceived(
      { eventId: eventId(), type: 'participant.joined', roomName: 'balo-same' },
      db
    );

    // The unique is on `event_id` ALONE. Two genuine joins to one room are two events, not a
    // replay — a unique that included the room would silently drop the second participant.
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second?.id).not.toBe(first?.id);
  });
});

describe('dailyWebhookEventsRepository.findByEventId', () => {
  it('returns the marker when present and undefined when absent', async () => {
    const id = eventId();
    await dailyWebhookEventsRepository.insertReceived({ eventId: id, type: 'meeting.ended' }, db);

    const found = await dailyWebhookEventsRepository.findByEventId(id);
    expect(found?.eventId).toBe(id);

    const missing = await dailyWebhookEventsRepository.findByEventId(eventId());
    expect(missing).toBeUndefined();
  });

  it('THE SHORT-CIRCUIT CONTRACT: presence alone is not "handled" — processed_at is', async () => {
    const id = eventId();
    await dailyWebhookEventsRepository.insertReceived(
      { eventId: id, type: 'participant.left' },
      db
    );

    // A received-but-unprocessed marker is a delivery that died before committing its effect.
    // A caller that treated any row as "already handled" would drop the effect of the retry
    // that exists to repair it — hence the docblock's "branch on processedAt, not presence".
    const received = await dailyWebhookEventsRepository.findByEventId(id);
    expect(received).toBeDefined();
    expect(received?.processedAt).toBeNull();

    await dailyWebhookEventsRepository.markProcessed(id, db);

    const processed = await dailyWebhookEventsRepository.findByEventId(id);
    expect(processed?.processedAt).toBeInstanceOf(Date);
  });
});

describe('dailyWebhookEventsRepository.markProcessed', () => {
  it('stamps processed_at (null → a timestamp) using the DB clock', async () => {
    const id = eventId();
    const inserted = await dailyWebhookEventsRepository.insertReceived(
      { eventId: id, type: 'participant.joined' },
      db
    );
    expect(inserted?.processedAt).toBeNull();

    await dailyWebhookEventsRepository.markProcessed(id, db);

    const after = await dailyWebhookEventsRepository.findByEventId(id);
    expect(after?.processedAt).toBeInstanceOf(Date);
    // `now()` inside a transaction is the TRANSACTION time, so it is never before the insert.
    const receivedAt = after?.receivedAt;
    const processedAt = after?.processedAt;
    expect(receivedAt).toBeInstanceOf(Date);
    expect(processedAt).toBeInstanceOf(Date);
    if (receivedAt instanceof Date && processedAt instanceof Date) {
      expect(processedAt.getTime()).toBeGreaterThanOrEqual(receivedAt.getTime());
    }
  });

  it('is a no-op for an unknown event id (updates zero rows, does not throw)', async () => {
    // A lost race must not become an exception in a webhook that behaved correctly.
    await expect(
      dailyWebhookEventsRepository.markProcessed(eventId(), db)
    ).resolves.toBeUndefined();
  });

  it('stamps only the named event, leaving every sibling marker untouched', async () => {
    const target = eventId();
    const bystander = eventId();
    await dailyWebhookEventsRepository.insertReceived(
      { eventId: target, type: 'participant.joined' },
      db
    );
    await dailyWebhookEventsRepository.insertReceived(
      { eventId: bystander, type: 'participant.joined' },
      db
    );

    await dailyWebhookEventsRepository.markProcessed(target, db);

    expect((await dailyWebhookEventsRepository.findByEventId(target))?.processedAt).toBeInstanceOf(
      Date
    );
    expect((await dailyWebhookEventsRepository.findByEventId(bystander))?.processedAt).toBeNull();
  });
});

describe('daily_webhook_events — the append-only posture', () => {
  it('carries NO created_at / updated_at / deleted_at columns (append-only, by design)', async () => {
    const id = eventId();
    const row = await dailyWebhookEventsRepository.insertReceived(
      { eventId: id, type: 'participant.joined' },
      db
    );
    expect(row).toBeDefined();

    // The deliberate exception to the every-table timestamps/soft-delete convention, matching
    // `stripe_webhook_events` / `credit_ledger` / `audit_events`. Asserted so a well-meaning
    // "consistency" pass that adds `...timestamps` fails here and has to read the rationale.
    const columns = Object.keys(row ?? {});
    expect(columns).not.toContain('createdAt');
    expect(columns).not.toContain('updatedAt');
    expect(columns).not.toContain('deletedAt');
    expect(columns.sort()).toEqual(
      ['eventId', 'id', 'payloadHash', 'processedAt', 'receivedAt', 'roomName', 'type'].sort()
    );
  });

  it('the unique on event_id is NON-PARTIAL — no soft-delete can ever vacate it', async () => {
    // The safety argument for the non-partial unique is that nothing can soft-delete a row
    // here. There is no `deleted_at` column to stamp, so the recreate footgun (memory
    // `reference_softdelete_nonpartial_unique_recreate`) has no way in. Pinned by asserting
    // the conflict survives regardless of what else is on the table.
    const id = eventId();
    await dailyWebhookEventsRepository.insertReceived({ eventId: id, type: 'meeting.ended' }, db);
    await dailyWebhookEventsRepository.markProcessed(id, db);

    // Even a fully-processed marker still blocks its own event id forever. That permanence IS
    // the idempotency guarantee.
    const afterProcessing = await dailyWebhookEventsRepository.insertReceived(
      { eventId: id, type: 'meeting.ended' },
      db
    );
    expect(afterProcessing).toBeUndefined();
  });
});

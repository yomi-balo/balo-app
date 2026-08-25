import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../client';
import { muxWebhookEvents } from '../schema';
import { muxWebhookEventsRepository } from './mux-webhook-events';

/**
 * Integration tests for `muxWebhookEventsRepository` (BAL-473) — the event-id idempotency log
 * for the single Mux webhook (`POST /webhooks/mux`).
 *
 * Self-contained rows: `event_id` is a free text key with no FK, so no factory is needed (the
 * `daily-webhook-events.integration.test.ts` / `stripe-webhook-events.integration.test.ts`
 * precedent this file deliberately mirrors). Uses the in-harness `db`, which IS the per-test
 * transaction, and which therefore also satisfies the `DbExecutor` both write methods demand.
 */

/** A fresh, collision-proof Mux-shaped event id. */
function eventId(): string {
  return `evt-${randomUUID()}`;
}

/** A `meeting_recordings.id`-shaped passthrough. No FK — this column is an OPS READ only. */
function passthrough(): string {
  return randomUUID();
}

describe('muxWebhookEventsRepository.insertReceived', () => {
  it('inserts the marker on first sight, with processed_at still NULL', async () => {
    const id = eventId();
    const segmentId = passthrough();

    const row = await muxWebhookEventsRepository.insertReceived(
      { eventId: id, type: 'video.asset.ready', passthrough: segmentId },
      db
    );

    expect(row).toBeDefined();
    expect(row?.eventId).toBe(id);
    expect(row?.type).toBe('video.asset.ready');
    expect(row?.passthrough).toBe(segmentId);
    expect(row?.payloadHash).toBeNull();
    expect(row?.receivedAt).toBeInstanceOf(Date);
    // ⚠ NULL AT INSERT IS THE WHOLE PROTOCOL: the marker means "received", never "applied".
    // The effect stamps it, inside the same transaction.
    expect(row?.processedAt).toBeNull();
  });

  it('THE REPLAY: a second insert of the same event_id returns undefined and writes nothing', async () => {
    const id = eventId();

    const first = await muxWebhookEventsRepository.insertReceived(
      { eventId: id, type: 'video.asset.ready' },
      db
    );
    expect(first).toBeDefined();

    // Mux retries aggressively. `undefined` is the caller's signal to abandon the effect: the
    // other transaction either already applied it or is about to.
    const replay = await muxWebhookEventsRepository.insertReceived(
      { eventId: id, type: 'video.asset.ready' },
      db
    );
    expect(replay).toBeUndefined();

    const rows = await db.select().from(muxWebhookEvents).where(eq(muxWebhookEvents.eventId, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(first?.id);
  });

  it('a replay does NOT overwrite the first delivery’s recorded fields', async () => {
    const id = eventId();
    const original = passthrough();
    await muxWebhookEventsRepository.insertReceived(
      { eventId: id, type: 'video.asset.ready', passthrough: original, payloadHash: 'sha256:1' },
      db
    );

    // `onConflictDoNothing`, not `onConflictDoUpdate` — the incumbent row is left
    // BYTE-IDENTICAL. A retry that arrived with a different body must never rewrite the record
    // of what was actually processed.
    await muxWebhookEventsRepository.insertReceived(
      {
        eventId: id,
        type: 'video.asset.errored',
        passthrough: passthrough(),
        payloadHash: 'sha256:2',
      },
      db
    );

    const found = await muxWebhookEventsRepository.findByEventId(id);
    expect(found?.type).toBe('video.asset.ready');
    expect(found?.passthrough).toBe(original);
    expect(found?.payloadHash).toBe('sha256:1');
  });

  it('records a delivery that carries NO passthrough, so Mux stops retrying an unactionable body', async () => {
    const withHash = await muxWebhookEventsRepository.insertReceived(
      { eventId: eventId(), type: 'video.asset.created', payloadHash: 'sha256:abc' },
      db
    );
    expect(withHash?.payloadHash).toBe('sha256:abc');

    // ⚠ `passthrough` is NULLABLE because not every Mux event type carries one, and an asset
    // created outside this pipeline would carry none. Such a delivery must still get a marker
    // and a `200`, or its replay is unguarded.
    const bare = await muxWebhookEventsRepository.insertReceived(
      { eventId: eventId(), type: 'video.upload.asset_created' },
      db
    );
    expect(bare?.passthrough).toBeNull();
    expect(bare?.payloadHash).toBeNull();
  });

  it('records a passthrough that resolves to NO recording — it is an ops column, not a lookup', async () => {
    // Deliberately a uuid that names no `meeting_recordings` row. There is NO FK here on
    // purpose: resolving the segment is `findById` / `findByMuxAssetId`'s job, and an
    // unresolvable passthrough must still be RECORDED rather than rejected.
    const orphan = passthrough();
    const row = await muxWebhookEventsRepository.insertReceived(
      { eventId: eventId(), type: 'video.asset.ready', passthrough: orphan },
      db
    );
    expect(row?.passthrough).toBe(orphan);
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
      muxWebhookEventsRepository.insertReceived({ eventId: id, type: 'video.asset.ready' }, db),
      muxWebhookEventsRepository.insertReceived({ eventId: id, type: 'video.asset.ready' }, db),
    ]);

    const winners = results.filter((row) => row !== undefined);
    expect(winners).toHaveLength(1);

    const rows = await db.select().from(muxWebhookEvents).where(eq(muxWebhookEvents.eventId, id));
    expect(rows).toHaveLength(1);
  });

  it('distinct event ids never collide, even with an identical type and passthrough', async () => {
    const segmentId = passthrough();
    const first = await muxWebhookEventsRepository.insertReceived(
      { eventId: eventId(), type: 'video.asset.ready', passthrough: segmentId },
      db
    );
    const second = await muxWebhookEventsRepository.insertReceived(
      { eventId: eventId(), type: 'video.asset.ready', passthrough: segmentId },
      db
    );

    // The unique is on `event_id` ALONE. One segment legitimately produces several events
    // (`video.asset.created`, `video.asset.ready`, …) — a unique that included `passthrough`
    // would silently drop every event after the first.
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second?.id).not.toBe(first?.id);
  });
});

describe('muxWebhookEventsRepository.findByEventId', () => {
  it('returns the marker when present and undefined when absent', async () => {
    const id = eventId();
    await muxWebhookEventsRepository.insertReceived({ eventId: id, type: 'video.asset.ready' }, db);

    const found = await muxWebhookEventsRepository.findByEventId(id);
    expect(found?.eventId).toBe(id);

    const missing = await muxWebhookEventsRepository.findByEventId(eventId());
    expect(missing).toBeUndefined();
  });

  it('THE SHORT-CIRCUIT CONTRACT: presence alone is not "handled" — processed_at is', async () => {
    const id = eventId();
    await muxWebhookEventsRepository.insertReceived(
      { eventId: id, type: 'video.asset.errored' },
      db
    );

    // A received-but-unprocessed marker is a delivery that died before committing its effect.
    // A caller that treated any row as "already handled" would drop the effect of the retry
    // that exists to repair it — hence the docblock's "branch on processedAt, not presence".
    const received = await muxWebhookEventsRepository.findByEventId(id);
    expect(received).toBeDefined();
    expect(received?.processedAt).toBeNull();

    await muxWebhookEventsRepository.markProcessed(id, db);

    const processed = await muxWebhookEventsRepository.findByEventId(id);
    expect(processed?.processedAt).toBeInstanceOf(Date);
  });

  it('sees a marker inserted earlier in the SAME transaction when handed that executor', async () => {
    const id = eventId();
    await muxWebhookEventsRepository.insertReceived({ eventId: id, type: 'video.asset.ready' }, db);

    // The harness `db` IS the open transaction. Passing it explicitly is what the webhook does
    // for its in-transaction re-read; the default (base client) is for the PRE-transaction
    // short-circuit only.
    const found = await muxWebhookEventsRepository.findByEventId(id, db);
    expect(found?.eventId).toBe(id);
  });
});

describe('muxWebhookEventsRepository.markProcessed', () => {
  it('stamps processed_at (null → a timestamp) using the DB clock', async () => {
    const id = eventId();
    const inserted = await muxWebhookEventsRepository.insertReceived(
      { eventId: id, type: 'video.asset.ready' },
      db
    );
    expect(inserted?.processedAt).toBeNull();

    await muxWebhookEventsRepository.markProcessed(id, db);

    const after = await muxWebhookEventsRepository.findByEventId(id);
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
    await expect(muxWebhookEventsRepository.markProcessed(eventId(), db)).resolves.toBeUndefined();
  });

  it('stamps only the named event, leaving every sibling marker untouched', async () => {
    const target = eventId();
    const bystander = eventId();
    await muxWebhookEventsRepository.insertReceived(
      { eventId: target, type: 'video.asset.ready' },
      db
    );
    await muxWebhookEventsRepository.insertReceived(
      { eventId: bystander, type: 'video.asset.ready' },
      db
    );

    await muxWebhookEventsRepository.markProcessed(target, db);

    expect((await muxWebhookEventsRepository.findByEventId(target))?.processedAt).toBeInstanceOf(
      Date
    );
    expect((await muxWebhookEventsRepository.findByEventId(bystander))?.processedAt).toBeNull();
  });
});

describe('mux_webhook_events — the append-only posture', () => {
  it('carries NO created_at / updated_at / deleted_at columns (append-only, by design)', async () => {
    const row = await muxWebhookEventsRepository.insertReceived(
      { eventId: eventId(), type: 'video.asset.ready' },
      db
    );
    expect(row).toBeDefined();

    // The deliberate exception to the every-table timestamps/soft-delete convention, matching
    // `daily_webhook_events` / `stripe_webhook_events` / `credit_ledger` / `audit_events`.
    // Asserted so a well-meaning "consistency" pass that adds `...timestamps` fails here and
    // has to read the rationale.
    const columns = Object.keys(row ?? {});
    expect(columns).not.toContain('createdAt');
    expect(columns).not.toContain('updatedAt');
    expect(columns).not.toContain('deletedAt');
    expect(columns.sort()).toEqual(
      ['eventId', 'id', 'passthrough', 'payloadHash', 'processedAt', 'receivedAt', 'type'].sort()
    );
  });

  it('the unique on event_id is NON-PARTIAL — no soft-delete can ever vacate it', async () => {
    // The safety argument for the non-partial unique is that nothing can soft-delete a row
    // here. There is no `deleted_at` column to stamp, so the recreate footgun (memory
    // `reference_softdelete_nonpartial_unique_recreate`) has no way in. Non-partial also keeps
    // the `onConflictDoNothing` arbiter TOTAL, so the `42P10` partial-arbiter hazard cannot
    // arise. Pinned by asserting the conflict survives full processing.
    const id = eventId();
    await muxWebhookEventsRepository.insertReceived({ eventId: id, type: 'video.asset.ready' }, db);
    await muxWebhookEventsRepository.markProcessed(id, db);

    // Even a fully-processed marker still blocks its own event id forever. That permanence IS
    // the idempotency guarantee.
    const afterProcessing = await muxWebhookEventsRepository.insertReceived(
      { eventId: id, type: 'video.asset.ready' },
      db
    );
    expect(afterProcessing).toBeUndefined();
  });
});

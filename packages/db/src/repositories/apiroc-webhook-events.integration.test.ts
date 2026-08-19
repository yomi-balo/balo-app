import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../client';
import { apirocWebhookEvents } from '../schema';
import { expertDraftFactory } from '../test/factories';
import { expectConstraintViolation } from '../test/helpers/expect-check-violation';
import { calendarRepository } from './calendar';
import { calendarSubscriptionsRepository } from './calendar-subscriptions';
import { apirocWebhookEventsRepository } from './apiroc-webhook-events';

/**
 * Integration tests for `apirocWebhookEventsRepository` (BAL-468) — the `svix-id` idempotency
 * log for the inbound Apiroc calendar-change webhook. Deliberately mirrors
 * `daily-webhook-events.integration.test.ts`.
 *
 * ⚠ UNLIKE its two siblings, a marker here is NOT self-contained: `calendar_subscription_id`
 * is `NOT NULL` with a real FK, so every test seeds a real subscription. That is the point —
 * a marker is only ever written AFTER the path resolved to a live row and the signature
 * verified, so the value is always known.
 *
 * Uses the in-harness `db`, which IS the per-test transaction and therefore also satisfies
 * the `DbExecutor` both write methods demand explicitly.
 */

/** A fresh, collision-proof Svix-shaped message id. */
function svixId(): string {
  return `msg_${randomUUID().replace(/-/g, '')}`;
}

/** Seed a live subscription and return its id — the FK target every marker needs. */
async function seedSubscriptionId(): Promise<string> {
  const expert = await expertDraftFactory();
  const connection = await calendarRepository.upsertApirocConnection({
    expertProfileId: expert.id,
    provider: 'google',
    endUserAccountId: `eua_${randomUUID()}`,
  });
  const id = randomUUID();
  const row = await calendarSubscriptionsRepository.insertSubscription({
    id,
    connectionId: connection.id,
    calendarId: 'cal-primary',
    webhookSubscriptionId: `wsub_${randomUUID()}`,
    endpointSecret: 'aXY=:dGFn:Y2lwaGVy',
    webhookUrl: `https://api.balo.example/webhooks/apiroc/calendar/${id}`,
  });
  return row.id;
}

describe('apirocWebhookEventsRepository.insertReceived', () => {
  it('inserts the marker on first sight, with processed_at still NULL', async () => {
    const subscriptionId = await seedSubscriptionId();
    const id = svixId();

    const row = await apirocWebhookEventsRepository.insertReceived(
      { svixId: id, calendarSubscriptionId: subscriptionId, eventType: 'event.updated' },
      db
    );

    expect(row).toBeDefined();
    expect(row?.svixId).toBe(id);
    expect(row?.calendarSubscriptionId).toBe(subscriptionId);
    expect(row?.eventType).toBe('event.updated');
    expect(row?.receivedAt).toBeInstanceOf(Date);
    // ⚠ NULL AT INSERT IS THE WHOLE PROTOCOL: the marker means "received", never "applied".
    // The stamp lands only once the availability-rebuild enqueue has actually succeeded.
    expect(row?.processedAt).toBeNull();
  });

  it('THE REPLAY: a second insert of the same svix_id returns undefined and writes nothing', async () => {
    const subscriptionId = await seedSubscriptionId();
    const id = svixId();

    const first = await apirocWebhookEventsRepository.insertReceived(
      { svixId: id, calendarSubscriptionId: subscriptionId, eventType: 'event.updated' },
      db
    );
    expect(first).toBeDefined();

    const replay = await apirocWebhookEventsRepository.insertReceived(
      { svixId: id, calendarSubscriptionId: subscriptionId, eventType: 'event.updated' },
      db
    );
    expect(replay).toBeUndefined();

    const rows = await db
      .select()
      .from(apirocWebhookEvents)
      .where(eq(apirocWebhookEvents.svixId, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(first?.id);
  });

  it('a replay does NOT overwrite the first delivery’s recorded fields', async () => {
    const firstSubscription = await seedSubscriptionId();
    const otherSubscription = await seedSubscriptionId();
    const id = svixId();

    await apirocWebhookEventsRepository.insertReceived(
      { svixId: id, calendarSubscriptionId: firstSubscription, eventType: 'event.created' },
      db
    );

    // `onConflictDoNothing`, not `onConflictDoUpdate` — the incumbent row is left
    // BYTE-IDENTICAL. A retry that arrived with a different body must never rewrite the
    // record of what was actually processed.
    await apirocWebhookEventsRepository.insertReceived(
      { svixId: id, calendarSubscriptionId: otherSubscription, eventType: 'event.deleted' },
      db
    );

    const found = await apirocWebhookEventsRepository.findBySvixId(id);
    expect(found?.calendarSubscriptionId).toBe(firstSubscription);
    expect(found?.eventType).toBe('event.created');
  });

  it('distinct svix ids never collide, even on the same subscription and event type', async () => {
    const subscriptionId = await seedSubscriptionId();

    // The unique is on `svix_id` ALONE. Two genuine changes to one calendar are two
    // deliveries, not a replay — a unique that included the subscription would silently drop
    // every change after the first.
    const first = await apirocWebhookEventsRepository.insertReceived(
      { svixId: svixId(), calendarSubscriptionId: subscriptionId, eventType: 'event.updated' },
      db
    );
    const second = await apirocWebhookEventsRepository.insertReceived(
      { svixId: svixId(), calendarSubscriptionId: subscriptionId, eventType: 'event.updated' },
      db
    );

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second?.id).not.toBe(first?.id);
  });

  it('CONCURRENT DELIVERY: two callers issue the same svix_id and exactly ONE wins', async () => {
    const subscriptionId = await seedSubscriptionId();
    const id = svixId();

    // ⚠ HONEST ABOUT WHAT THIS DOES AND DOES NOT PROVE. The harness runs every test inside ONE
    // transaction on a `max: 1` pool, so a genuine interleaving is INEXPRESSIBLE here (memory
    // `reference_db_integration_harness_no_concurrency`) — these two calls serialize on the
    // single connection. What it pins is the OUTCOME the unique index must produce for two
    // deliveries of one message id: exactly one row, exactly one non-undefined return, which
    // is the property the handler branches on.
    const results = await Promise.all([
      apirocWebhookEventsRepository.insertReceived(
        { svixId: id, calendarSubscriptionId: subscriptionId, eventType: 'event.updated' },
        db
      ),
      apirocWebhookEventsRepository.insertReceived(
        { svixId: id, calendarSubscriptionId: subscriptionId, eventType: 'event.updated' },
        db
      ),
    ]);

    expect(results.filter((row) => row !== undefined)).toHaveLength(1);
    const rows = await db
      .select()
      .from(apirocWebhookEvents)
      .where(eq(apirocWebhookEvents.svixId, id));
    expect(rows).toHaveLength(1);
  });

  it('refuses a marker that names no real subscription (23503)', async () => {
    // The FK is what makes `calendar_subscription_id` trustworthy as an ops read — unlike
    // `daily_webhook_events.room_name`, which is nullable with no constraint at all.
    await expectConstraintViolation('23503', (tx) =>
      tx.insert(apirocWebhookEvents).values({
        svixId: svixId(),
        calendarSubscriptionId: randomUUID(),
        eventType: 'event.updated',
      })
    );
  });
});

describe('apirocWebhookEventsRepository.findBySvixId', () => {
  it('returns the marker when present and undefined when absent', async () => {
    const subscriptionId = await seedSubscriptionId();
    const id = svixId();
    await apirocWebhookEventsRepository.insertReceived(
      { svixId: id, calendarSubscriptionId: subscriptionId, eventType: 'event.updated' },
      db
    );

    expect((await apirocWebhookEventsRepository.findBySvixId(id))?.svixId).toBe(id);
    expect(await apirocWebhookEventsRepository.findBySvixId(svixId())).toBeUndefined();
  });

  it('THE SHORT-CIRCUIT CONTRACT: presence alone is not "handled" — processed_at is', async () => {
    const subscriptionId = await seedSubscriptionId();
    const id = svixId();
    await apirocWebhookEventsRepository.insertReceived(
      { svixId: id, calendarSubscriptionId: subscriptionId, eventType: 'event.updated' },
      db
    );

    // A received-but-unprocessed marker is a delivery that died before its effect landed. A
    // caller that treated any row as "already handled" would answer 2xx forever to a calendar
    // change it never rebuilt availability for.
    const received = await apirocWebhookEventsRepository.findBySvixId(id);
    expect(received).toBeDefined();
    expect(received?.processedAt).toBeNull();

    await apirocWebhookEventsRepository.markProcessed(id, db);

    expect((await apirocWebhookEventsRepository.findBySvixId(id))?.processedAt).toBeInstanceOf(
      Date
    );
  });
});

describe('apirocWebhookEventsRepository.markProcessed', () => {
  it('stamps processed_at (null → a timestamp) using the DB clock', async () => {
    const subscriptionId = await seedSubscriptionId();
    const id = svixId();
    const inserted = await apirocWebhookEventsRepository.insertReceived(
      { svixId: id, calendarSubscriptionId: subscriptionId, eventType: 'event.created' },
      db
    );
    expect(inserted?.processedAt).toBeNull();

    await apirocWebhookEventsRepository.markProcessed(id, db);

    const after = await apirocWebhookEventsRepository.findBySvixId(id);
    const receivedAt = after?.receivedAt;
    const processedAt = after?.processedAt;
    expect(receivedAt).toBeInstanceOf(Date);
    expect(processedAt).toBeInstanceOf(Date);
    if (receivedAt instanceof Date && processedAt instanceof Date) {
      // `now()` inside a transaction is TRANSACTION time, so it is never before the insert.
      expect(processedAt.getTime()).toBeGreaterThanOrEqual(receivedAt.getTime());
    }
  });

  it('a second call is a harmless no-op, and an unknown id updates zero rows without throwing', async () => {
    const subscriptionId = await seedSubscriptionId();
    const id = svixId();
    await apirocWebhookEventsRepository.insertReceived(
      { svixId: id, calendarSubscriptionId: subscriptionId, eventType: 'event.updated' },
      db
    );

    await apirocWebhookEventsRepository.markProcessed(id, db);
    await expect(apirocWebhookEventsRepository.markProcessed(id, db)).resolves.toBeUndefined();
    // Turning a lost race into an exception would hand Svix a non-2xx for a delivery that was
    // in fact processed — putting it straight back in the retry queue.
    await expect(
      apirocWebhookEventsRepository.markProcessed(svixId(), db)
    ).resolves.toBeUndefined();

    expect((await apirocWebhookEventsRepository.findBySvixId(id))?.processedAt).toBeInstanceOf(
      Date
    );
  });

  it('stamps only the named delivery, leaving every sibling marker untouched', async () => {
    const subscriptionId = await seedSubscriptionId();
    const target = svixId();
    const bystander = svixId();
    await apirocWebhookEventsRepository.insertReceived(
      { svixId: target, calendarSubscriptionId: subscriptionId, eventType: 'event.updated' },
      db
    );
    await apirocWebhookEventsRepository.insertReceived(
      { svixId: bystander, calendarSubscriptionId: subscriptionId, eventType: 'event.updated' },
      db
    );

    await apirocWebhookEventsRepository.markProcessed(target, db);

    expect((await apirocWebhookEventsRepository.findBySvixId(target))?.processedAt).toBeInstanceOf(
      Date
    );
    expect((await apirocWebhookEventsRepository.findBySvixId(bystander))?.processedAt).toBeNull();
  });
});

describe('apiroc_webhook_events — the append-only posture', () => {
  it('carries NO created_at / updated_at / deleted_at columns (append-only, by design)', async () => {
    const subscriptionId = await seedSubscriptionId();
    const row = await apirocWebhookEventsRepository.insertReceived(
      { svixId: svixId(), calendarSubscriptionId: subscriptionId, eventType: 'event.updated' },
      db
    );
    expect(row).toBeDefined();

    // The deliberate exception to the every-table timestamps/soft-delete convention, matching
    // `stripe_webhook_events` / `daily_webhook_events` / `credit_ledger` / `audit_events`.
    // Asserted so a "consistency" pass that adds `...timestamps` fails HERE and has to read
    // the rationale — because adding `deleted_at` would also silently invalidate the safety
    // argument for the non-partial unique below.
    const columns = Object.keys(row ?? {});
    expect(columns).not.toContain('createdAt');
    expect(columns).not.toContain('updatedAt');
    expect(columns).not.toContain('deletedAt');
    expect(columns.sort()).toEqual(
      ['calendarSubscriptionId', 'eventType', 'id', 'processedAt', 'receivedAt', 'svixId'].sort()
    );
  });

  it('the unique on svix_id is NON-PARTIAL — a fully processed marker still blocks its id', async () => {
    const subscriptionId = await seedSubscriptionId();
    const id = svixId();
    await apirocWebhookEventsRepository.insertReceived(
      { svixId: id, calendarSubscriptionId: subscriptionId, eventType: 'event.updated' },
      db
    );
    await apirocWebhookEventsRepository.markProcessed(id, db);

    // That permanence IS the idempotency guarantee — and it is safe because nothing can
    // soft-delete a row here (there is no `deleted_at` to stamp), so the recreate footgun
    // (`reference_softdelete_nonpartial_unique_recreate`) has no way in. A partial predicate
    // would instead force every `onConflictDoNothing` to restate inlined literals or fail
    // 42P10.
    const afterProcessing = await apirocWebhookEventsRepository.insertReceived(
      { svixId: id, calendarSubscriptionId: subscriptionId, eventType: 'event.updated' },
      db
    );
    expect(afterProcessing).toBeUndefined();
  });
});

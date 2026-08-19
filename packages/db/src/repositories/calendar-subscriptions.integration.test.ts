import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../client';
import { calendarSubscriptions, type CalendarSubscription } from '../schema';
import { expertDraftFactory } from '../test/factories';
import { expectConstraintViolation } from '../test/helpers/expect-check-violation';
import { calendarRepository } from './calendar';
import {
  calendarSubscriptionsRepository,
  type InsertSubscriptionInput,
} from './calendar-subscriptions';

/**
 * BAL-468 — `calendar_subscriptions` against REAL Postgres.
 *
 * ⚠⚠ THIS SUITE IS NOT A COVERAGE CHECKBOX. Its two highest-value assertions are INVISIBLE to
 * `tsc`, to lint, and to any mocked unit test, and each one pins a ruling a well-meaning
 * "consistency" pass would otherwise reverse:
 *
 *   · **THE UNIQUE ON `webhook_subscription_id` IS REALLY PARTIAL.** A second LIVE insert of
 *     one vendor id must raise 23505; the same vendor id must insert cleanly once the
 *     incumbent is soft-deleted. A non-partial unique passes the first half and fails the
 *     second — silently, months later, on a teardown-then-recreate
 *     (`reference_softdelete_nonpartial_unique_recreate`).
 *
 *   · **TWO LIVE ROWS FOR ONE `(connection_id, calendar_id)` INSERT SUCCESSFULLY.** This is
 *     ruling #5, and it is the exact statement a "helpful" partial unique on that pair would
 *     break. It is the create-then-delete renewal overlap — the LEGITIMATE steady state — and
 *     there is no other gate in the repository that can catch its loss.
 */

// ── Fixtures ──────────────────────────────────────────────────────

/** A live ACTIVE Apiroc connection for a fresh expert. Returns its id. */
/**
 * ⚠ SEEDS ONE CONFLICT-CHECKED SUB-CALENDAR BY DEFAULT, and that default is load-bearing for
 * monitor arm 3: the arm alerts on DESIRED-but-absent, where "desired" is
 * `subCalendars.filter((c) => c.conflictCheck)`. A connection with no conflict-checked calendar
 * legitimately wants zero subscriptions and must NOT be flagged. Pass `conflictCheckCalendars:
 * 0` to build that case explicitly.
 */
async function seedConnection(
  provider = 'google',
  credentialStatus: 'ACTIVE' | 'SYNC_PENDING' | 'EXPIRED' | 'REVOKED' = 'ACTIVE',
  options: { conflictCheckCalendars?: number } = {}
): Promise<{ connectionId: string; expertProfileId: string }> {
  const expert = await expertDraftFactory();
  const connection = await calendarRepository.upsertApirocConnection({
    expertProfileId: expert.id,
    provider,
    endUserAccountId: `eua_${randomUUID()}`,
    providerEmail: `expert@${provider}.example`,
    credentialStatus,
  });
  const conflictCheckCalendars = options.conflictCheckCalendars ?? 1;
  if (conflictCheckCalendars > 0) {
    await calendarRepository.replaceSubCalendars(
      connection.id,
      Array.from({ length: conflictCheckCalendars }, (_, i) => ({
        calendarId: `subcal-${i}`,
        name: `Calendar ${i}`,
        provider,
        profileName: null,
        isPrimary: i === 0,
        conflictCheck: true,
        color: null,
      }))
    );
  }
  return { connectionId: connection.id, expertProfileId: expert.id };
}

/**
 * Build an insert payload. ⚠ `id` is MINTED HERE, not defaulted — the production caller mints
 * it before the vendor call because the registered webhook URL must contain it (§8.5).
 */
function subInput(
  connectionId: string,
  overrides: Partial<InsertSubscriptionInput> = {}
): InsertSubscriptionInput {
  const id = overrides.id ?? randomUUID();
  return {
    id,
    connectionId,
    calendarId: 'cal-primary',
    webhookSubscriptionId: `wsub_${randomUUID()}`,
    // Ciphertext-shaped, because this repository stores what it is handed and never encrypts.
    endpointSecret: 'aXY=:dGFn:Y2lwaGVy',
    webhookUrl: `https://api.balo.example/webhooks/apiroc/calendar/${id}`,
    ...overrides,
  };
}

/**
 * Force a distinct `created_at`.
 *
 * ⚠ MANDATORY BEFORE ANY ORDER-SENSITIVE ASSERTION. `created_at` defaults to `now()`, which
 * in Postgres is TRANSACTION START TIME, and the harness holds each test inside ONE
 * transaction — so rows inserted "seconds apart" here share a BYTE-IDENTICAL `created_at` and
 * the canonicity ordering falls through to `id desc`, a random v4 UUID. Without this stamp a
 * "newest wins" assertion is a coin flip that passes about half the time. Production does not
 * have the problem (each create is its own transaction), so stamping removes a harness
 * artefact rather than weakening the test.
 */
async function stampCreatedAt(id: string, iso: string): Promise<void> {
  await db
    .update(calendarSubscriptions)
    .set({ createdAt: new Date(iso) })
    .where(eq(calendarSubscriptions.id, id));
}

/** Raw read of one row regardless of soft-delete state — the repository can't see dead rows. */
async function readRaw(id: string): Promise<CalendarSubscription | undefined> {
  const [row] = await db
    .select()
    .from(calendarSubscriptions)
    .where(eq(calendarSubscriptions.id, id));
  return row;
}

// ── insertSubscription / findLiveById ─────────────────────────────

describe('calendarSubscriptionsRepository.insertSubscription', () => {
  it('inserts with the CALLER-MINTED id and leaves all three vendor-state columns NULL', async () => {
    const { connectionId } = await seedConnection();
    const input = subInput(connectionId);

    const row = await calendarSubscriptionsRepository.insertSubscription(input);

    // The id round-trips because the URL already registered at the vendor contains it.
    expect(row.id).toBe(input.id);
    expect(row.webhookUrl).toContain(input.id);
    expect(row.connectionId).toBe(connectionId);
    expect(row.calendarId).toBe('cal-primary');
    expect(row.webhookSubscriptionId).toBe(input.webhookSubscriptionId);
    expect(row.endpointSecret).toBe(input.endpointSecret);

    // ⚠ `expiration` is unknown between the create and the verification pass — the create
    // response has no such key AT ALL. NULL here is "we have not looked", which is exactly
    // what the monitor's `unconfirmed` arm watches for.
    expect(row.expiration).toBeNull();
    expect(row.expirationSyncedAt).toBeNull();
    expect(row.lastDeliveryAt).toBeNull();
    expect(row.deletedAt).toBeNull();
    expect(row.createdAt).toBeInstanceOf(Date);

    const found = await calendarSubscriptionsRepository.findLiveById(input.id);
    expect(found?.id).toBe(input.id);
  });

  it('refuses a row that names no real connection (23503)', async () => {
    await expectConstraintViolation('23503', (tx) =>
      tx.insert(calendarSubscriptions).values({
        connectionId: randomUUID(),
        calendarId: 'cal-primary',
        webhookSubscriptionId: `wsub_${randomUUID()}`,
        endpointSecret: 'x',
        webhookUrl: 'https://api.balo.example/webhooks/apiroc/calendar/x',
      })
    );
  });

  it('⚠⚠ RULING #5: TWO LIVE ROWS FOR ONE (connection_id, calendar_id) INSERT SUCCESSFULLY', async () => {
    const { connectionId } = await seedConnection();

    // This is the create-then-delete renewal overlap, and it is the LEGITIMATE steady state:
    // the replacement is registered at the vendor and inserted here while the incumbent is
    // still live and still delivering. A partial unique on (connection_id, calendar_id) —
    // which the brief originally called for — rejects this second INSERT with 23505 and
    // breaks every renewal. The only ordering that would satisfy such an index is
    // soft-delete-then-insert, which opens a window with NO live row while the vendor is
    // still delivering to the old URL (→ 404 → non-2xx → Svix disables the endpoint).
    const incumbent = await calendarSubscriptionsRepository.insertSubscription(
      subInput(connectionId, { calendarId: 'cal-shared' })
    );
    const replacement = await calendarSubscriptionsRepository.insertSubscription(
      subInput(connectionId, { calendarId: 'cal-shared' })
    );

    expect(replacement.id).not.toBe(incumbent.id);

    const live = await calendarSubscriptionsRepository.listLiveByConnectionId(connectionId);
    expect(live).toHaveLength(2);
    expect(live.every((r) => r.calendarId === 'cal-shared')).toBe(true);
  });
});

describe('cal_wsub_vendor_id_idx — the PARTIAL unique on the vendor id', () => {
  it('rejects a SECOND LIVE row carrying the same webhook_subscription_id (23505)', async () => {
    const { connectionId } = await seedConnection();
    const vendorId = `wsub_${randomUUID()}`;
    await calendarSubscriptionsRepository.insertSubscription(
      subInput(connectionId, { webhookSubscriptionId: vendorId })
    );

    // A vendor id is never reissued, so two live rows claiming one is a real anomaly — and
    // NOT something `insertSubscription` swallows: there is no ON CONFLICT anywhere in this
    // repository (ruling #6), so the caller sees the raw 23505.
    await expectConstraintViolation('23505', (tx) =>
      tx.insert(calendarSubscriptions).values({
        connectionId,
        calendarId: 'cal-other',
        webhookSubscriptionId: vendorId,
        endpointSecret: 'x',
        webhookUrl: 'https://api.balo.example/webhooks/apiroc/calendar/x',
      })
    );
  });

  it('IS PARTIAL: the same vendor id inserts cleanly once the incumbent is soft-deleted', async () => {
    const { connectionId } = await seedConnection();
    const vendorId = `wsub_${randomUUID()}`;
    const first = await calendarSubscriptionsRepository.insertSubscription(
      subInput(connectionId, { webhookSubscriptionId: vendorId })
    );

    await calendarSubscriptionsRepository.softDeleteById(first.id);

    // The half a NON-partial unique fails. It would leave the soft-deleted row occupying the
    // vendor id forever, so a teardown-then-recreate (or a vendor that DID reissue an id)
    // would blow up with a 23505 against a row the application cannot even see.
    const second = await calendarSubscriptionsRepository.insertSubscription(
      subInput(connectionId, { webhookSubscriptionId: vendorId })
    );
    expect(second.webhookSubscriptionId).toBe(vendorId);
    expect(second.id).not.toBe(first.id);
  });
});

// ── findLiveById ──────────────────────────────────────────────────

describe('calendarSubscriptionsRepository.findLiveById', () => {
  it('returns undefined for an unknown id AND for a soft-deleted row', async () => {
    const { connectionId } = await seedConnection();
    const row = await calendarSubscriptionsRepository.insertSubscription(subInput(connectionId));

    expect(await calendarSubscriptionsRepository.findLiveById(row.id)).toBeDefined();

    await calendarSubscriptionsRepository.softDeleteById(row.id);

    // "Found but dead" is not a state the webhook may see: a torn-down subscription that
    // still resolved would keep accepting deliveries for a registration Balo abandoned.
    expect(await calendarSubscriptionsRepository.findLiveById(row.id)).toBeUndefined();
    expect(await calendarSubscriptionsRepository.findLiveById(randomUUID())).toBeUndefined();

    // …but the row is still THERE — soft delete, not a hard one.
    expect((await readRaw(row.id))?.deletedAt).toBeInstanceOf(Date);
  });
});

// ── listLiveByConnectionId — the canonicity ordering ──────────────

describe('calendarSubscriptionsRepository.listLiveByConnectionId', () => {
  it('⚠ ORDERS NEWEST FIRST — the ordering IS the canonicity rule, not cosmetics', async () => {
    const { connectionId } = await seedConnection();
    const older = await calendarSubscriptionsRepository.insertSubscription(
      subInput(connectionId, { calendarId: 'cal-shared' })
    );
    const newer = await calendarSubscriptionsRepository.insertSubscription(
      subInput(connectionId, { calendarId: 'cal-shared' })
    );
    await stampCreatedAt(older.id, '2026-08-01T00:00:00Z');
    await stampCreatedAt(newer.id, '2026-08-02T00:00:00Z');

    const rows = await calendarSubscriptionsRepository.listLiveByConnectionId(connectionId);

    // `buildSubscriptionPlan` groups by calendarId and takes the FIRST as canonical; every
    // older live sibling becomes a `superseded` delete. Reverse this and renewal starts
    // superseding the row it just created.
    expect(rows.map((r) => r.id)).toEqual([newer.id, older.id]);
  });

  it('excludes soft-deleted rows and rows belonging to a sibling connection', async () => {
    const { connectionId } = await seedConnection('google');
    const sibling = await seedConnection('microsoft');

    const live = await calendarSubscriptionsRepository.insertSubscription(subInput(connectionId));
    const dead = await calendarSubscriptionsRepository.insertSubscription(
      subInput(connectionId, { calendarId: 'cal-dead' })
    );
    await calendarSubscriptionsRepository.insertSubscription(subInput(sibling.connectionId));
    await calendarSubscriptionsRepository.softDeleteById(dead.id);

    const rows = await calendarSubscriptionsRepository.listLiveByConnectionId(connectionId);
    expect(rows.map((r) => r.id)).toEqual([live.id]);
  });

  it('returns [] for a connection that has never subscribed', async () => {
    const { connectionId } = await seedConnection();
    expect(await calendarSubscriptionsRepository.listLiveByConnectionId(connectionId)).toEqual([]);
  });
});

// ── listLiveByIds — the orphan rule's global read ─────────────────

describe('calendarSubscriptionsRepository.listLiveByIds', () => {
  it('returns [] for an empty input WITHOUT issuing a query', async () => {
    expect(await calendarSubscriptionsRepository.listLiveByIds([])).toEqual([]);
  });

  it('returns only the LIVE ids from a mixed set', async () => {
    const { connectionId } = await seedConnection();
    const live = await calendarSubscriptionsRepository.insertSubscription(subInput(connectionId));
    const dead = await calendarSubscriptionsRepository.insertSubscription(
      subInput(connectionId, { calendarId: 'cal-dead' })
    );
    await calendarSubscriptionsRepository.softDeleteById(dead.id);

    const rows = await calendarSubscriptionsRepository.listLiveByIds([
      live.id,
      dead.id,
      randomUUID(),
    ]);
    expect(rows.map((r) => r.id)).toEqual([live.id]);
  });

  it('⚠⚠ IS GLOBAL, NOT PER-CONNECTION — it sees a SIBLING connection’s live row', async () => {
    const mine = await seedConnection('google');
    const theirs = await seedConnection('microsoft');
    const myRow = await calendarSubscriptionsRepository.insertSubscription(
      subInput(mine.connectionId)
    );
    const theirRow = await calendarSubscriptionsRepository.insertSubscription(
      subInput(theirs.connectionId)
    );

    // This is the whole reason the method exists. `cal_conn_end_user_account_idx` is
    // deliberately NON-unique — two Balo experts on one Google account is routine — so
    // `calendarSubscriptions.list(eua)` returns subscriptions owned by OTHER connections. A
    // per-connection orphan check would classify `theirRow` as an orphan and delete a healthy
    // sibling expert's subscription on every sweep, silently killing their change push.
    const rows = await calendarSubscriptionsRepository.listLiveByIds([myRow.id, theirRow.id]);
    expect(rows.map((r) => r.id).sort()).toEqual([myRow.id, theirRow.id].sort());
  });
});

// ── The stamps ────────────────────────────────────────────────────

describe('calendarSubscriptionsRepository.stampVendorState / stampDelivery', () => {
  it('stampVendorState writes both the expiration and the synced-at witness together', async () => {
    const { connectionId } = await seedConnection();
    const row = await calendarSubscriptionsRepository.insertSubscription(subInput(connectionId));

    const expiration = new Date('2026-09-01T00:00:00Z');
    const syncedAt = new Date('2026-08-25T10:00:00Z');
    await calendarSubscriptionsRepository.stampVendorState(row.id, expiration, syncedAt);

    const after = await calendarSubscriptionsRepository.findLiveById(row.id);
    expect(after?.expiration?.toISOString()).toBe(expiration.toISOString());
    expect(after?.expirationSyncedAt?.toISOString()).toBe(syncedAt.toISOString());
  });

  it('a NULL expiration means "the vendor reports no expiry", and still records the witness', async () => {
    const { connectionId } = await seedConnection();
    const row = await calendarSubscriptionsRepository.insertSubscription(subInput(connectionId));
    await calendarSubscriptionsRepository.stampVendorState(
      row.id,
      new Date('2026-09-01T00:00:00Z'),
      new Date('2026-08-20T00:00:00Z')
    );

    const syncedAt = new Date('2026-08-26T00:00:00Z');
    await calendarSubscriptionsRepository.stampVendorState(row.id, null, syncedAt);

    // ⚠ NULL here is NOT "we do not know" — that state is expiration NULL *and*
    // expirationSyncedAt NULL, which is what the monitor's `unconfirmed` arm watches. Writing
    // the witness alongside is what keeps the two distinguishable.
    const after = await calendarSubscriptionsRepository.findLiveById(row.id);
    expect(after?.expiration).toBeNull();
    expect(after?.expirationSyncedAt?.toISOString()).toBe(syncedAt.toISOString());
  });

  it('stampDelivery records liveness and touches nothing else', async () => {
    const { connectionId } = await seedConnection();
    const row = await calendarSubscriptionsRepository.insertSubscription(subInput(connectionId));

    const at = new Date('2026-08-19T12:00:00Z');
    await calendarSubscriptionsRepository.stampDelivery(row.id, at);

    const after = await calendarSubscriptionsRepository.findLiveById(row.id);
    expect(after?.lastDeliveryAt?.toISOString()).toBe(at.toISOString());
    expect(after?.expiration).toBeNull();
    expect(after?.expirationSyncedAt).toBeNull();
  });

  it('neither stamp resurrects or mutates a soft-deleted row', async () => {
    const { connectionId } = await seedConnection();
    const row = await calendarSubscriptionsRepository.insertSubscription(subInput(connectionId));
    await calendarSubscriptionsRepository.softDeleteById(row.id);

    await calendarSubscriptionsRepository.stampVendorState(row.id, new Date(), new Date());
    await calendarSubscriptionsRepository.stampDelivery(row.id, new Date());

    const raw = await readRaw(row.id);
    expect(raw?.expiration).toBeNull();
    expect(raw?.expirationSyncedAt).toBeNull();
    expect(raw?.lastDeliveryAt).toBeNull();
    expect(raw?.deletedAt).toBeInstanceOf(Date);
  });
});

// ── Soft deletes ──────────────────────────────────────────────────

describe('calendarSubscriptionsRepository.softDeleteById', () => {
  it('clears exactly one row and leaves its siblings live', async () => {
    const { connectionId } = await seedConnection();
    const target = await calendarSubscriptionsRepository.insertSubscription(subInput(connectionId));
    const bystander = await calendarSubscriptionsRepository.insertSubscription(
      subInput(connectionId, { calendarId: 'cal-other' })
    );

    await calendarSubscriptionsRepository.softDeleteById(target.id);

    expect((await readRaw(target.id))?.deletedAt).toBeInstanceOf(Date);
    expect((await readRaw(bystander.id))?.deletedAt).toBeNull();
  });

  it('is a no-op for an unknown id and idempotent on an already-deleted row', async () => {
    const { connectionId } = await seedConnection();
    const row = await calendarSubscriptionsRepository.insertSubscription(subInput(connectionId));
    await calendarSubscriptionsRepository.softDeleteById(row.id);
    const firstDeletedAt = (await readRaw(row.id))?.deletedAt;

    await calendarSubscriptionsRepository.softDeleteById(row.id);
    await expect(
      calendarSubscriptionsRepository.softDeleteById(randomUUID())
    ).resolves.toBeUndefined();

    // The `isNull(deletedAt)` guard makes the second call match zero rows, so the ORIGINAL
    // teardown instant survives — which is what makes it usable as evidence.
    expect((await readRaw(row.id))?.deletedAt?.toISOString()).toBe(firstDeletedAt?.toISOString());
  });
});

describe('calendarSubscriptionsRepository.softDeleteByConnectionId', () => {
  it('clears EVERY live row for that connection and NONE for a sibling', async () => {
    const mine = await seedConnection('google');
    const theirs = await seedConnection('microsoft');
    const a = await calendarSubscriptionsRepository.insertSubscription(
      subInput(mine.connectionId, { calendarId: 'cal-a' })
    );
    const b = await calendarSubscriptionsRepository.insertSubscription(
      subInput(mine.connectionId, { calendarId: 'cal-b' })
    );
    const untouched = await calendarSubscriptionsRepository.insertSubscription(
      subInput(theirs.connectionId)
    );

    await calendarSubscriptionsRepository.softDeleteByConnectionId(mine.connectionId);

    // Disconnect is PER-PROVIDER (ADR-1021 amendment §1). An expert-wide sweep here would
    // tear down calendars for a provider the expert never disconnected.
    expect(await calendarSubscriptionsRepository.listLiveByConnectionId(mine.connectionId)).toEqual(
      []
    );
    expect((await readRaw(a.id))?.deletedAt).toBeInstanceOf(Date);
    expect((await readRaw(b.id))?.deletedAt).toBeInstanceOf(Date);
    expect((await readRaw(untouched.id))?.deletedAt).toBeNull();
  });
});

// ── Monitor arm 1 — expiring ──────────────────────────────────────

describe('calendarSubscriptionsRepository.listExpiringBefore', () => {
  it('returns only KNOWN expirations before the threshold, ascending, and honours limit', async () => {
    const { connectionId } = await seedConnection();
    const soon = await calendarSubscriptionsRepository.insertSubscription(
      subInput(connectionId, { calendarId: 'cal-soon' })
    );
    const sooner = await calendarSubscriptionsRepository.insertSubscription(
      subInput(connectionId, { calendarId: 'cal-sooner' })
    );
    const later = await calendarSubscriptionsRepository.insertSubscription(
      subInput(connectionId, { calendarId: 'cal-later' })
    );
    const unknown = await calendarSubscriptionsRepository.insertSubscription(
      subInput(connectionId, { calendarId: 'cal-unknown' })
    );

    const syncedAt = new Date('2026-08-19T00:00:00Z');
    await calendarSubscriptionsRepository.stampVendorState(
      soon.id,
      new Date('2026-08-20T00:00:00Z'),
      syncedAt
    );
    await calendarSubscriptionsRepository.stampVendorState(
      sooner.id,
      new Date('2026-08-19T06:00:00Z'),
      syncedAt
    );
    await calendarSubscriptionsRepository.stampVendorState(
      later.id,
      new Date('2026-09-30T00:00:00Z'),
      syncedAt
    );

    const threshold = new Date('2026-08-21T00:00:00Z');
    const rows = await calendarSubscriptionsRepository.listExpiringBefore(threshold, 10);

    // ⚠ `unknown` (expiration IS NULL) must NOT appear: that is arm 2's question. Folding the
    // two together makes a row created 90 seconds ago masquerade as an expiry.
    expect(rows.map((r) => r.id)).toEqual([sooner.id, soon.id]);
    expect(rows.map((r) => r.id)).not.toContain(unknown.id);
    expect(rows.map((r) => r.id)).not.toContain(later.id);

    // The limit is a batch bound the CALLER must warn about when it fills — no silent caps.
    const capped = await calendarSubscriptionsRepository.listExpiringBefore(threshold, 1);
    expect(capped.map((r) => r.id)).toEqual([sooner.id]);
  });

  it('excludes soft-deleted rows — a teardown is not an outage', async () => {
    const { connectionId } = await seedConnection();
    const row = await calendarSubscriptionsRepository.insertSubscription(subInput(connectionId));
    await calendarSubscriptionsRepository.stampVendorState(
      row.id,
      new Date('2026-08-20T00:00:00Z'),
      new Date('2026-08-19T00:00:00Z')
    );
    await calendarSubscriptionsRepository.softDeleteById(row.id);

    const rows = await calendarSubscriptionsRepository.listExpiringBefore(
      new Date('2026-08-21T00:00:00Z'),
      10
    );
    expect(rows.map((r) => r.id)).not.toContain(row.id);
  });
});

// ── Monitor arm 2 — unconfirmed ───────────────────────────────────

describe('calendarSubscriptionsRepository.listUnconfirmedBefore', () => {
  it('returns only rows with NO expiration created before the grace cutoff', async () => {
    const { connectionId } = await seedConnection();
    const stale = await calendarSubscriptionsRepository.insertSubscription(
      subInput(connectionId, { calendarId: 'cal-stale' })
    );
    const fresh = await calendarSubscriptionsRepository.insertSubscription(
      subInput(connectionId, { calendarId: 'cal-fresh' })
    );
    const confirmed = await calendarSubscriptionsRepository.insertSubscription(
      subInput(connectionId, { calendarId: 'cal-confirmed' })
    );
    const dead = await calendarSubscriptionsRepository.insertSubscription(
      subInput(connectionId, { calendarId: 'cal-dead' })
    );

    await stampCreatedAt(stale.id, '2026-08-19T00:00:00Z');
    await stampCreatedAt(fresh.id, '2026-08-19T11:59:00Z'); // inside the grace window
    await stampCreatedAt(confirmed.id, '2026-08-19T00:00:00Z');
    await stampCreatedAt(dead.id, '2026-08-19T00:00:00Z');
    await calendarSubscriptionsRepository.stampVendorState(
      confirmed.id,
      new Date('2026-09-30T00:00:00Z'),
      new Date('2026-08-19T01:00:00Z')
    );
    await calendarSubscriptionsRepository.softDeleteById(dead.id);

    const rows = await calendarSubscriptionsRepository.listUnconfirmedBefore(
      new Date('2026-08-19T10:00:00Z'),
      10
    );

    // `fresh` is excluded by the grace cutoff — its verification pass simply has not run yet,
    // and alerting on it would measure the schedule rather than a failure.
    expect(rows.map((r) => r.id)).toEqual([stale.id]);
  });

  it('⚠⚠ EXCLUDES a row the vendor confirmed as having NO expiry', async () => {
    // PR #223 review. `stampVendorState`'s docblock is explicit that `expiration: null` means
    // "the vendor reports no expiry" — a real, CONFIRMED answer — and that the don't-know state
    // is that column null with `expiration_synced_at` ALSO null. Checking only `expiration`
    // meant such a row was flagged every single day forever, with the self-heal unable to
    // change anything, because it is not actually broken.
    const { connectionId } = await seedConnection();
    const noExpiry = await calendarSubscriptionsRepository.insertSubscription(
      subInput(connectionId, { calendarId: 'cal-no-expiry' })
    );
    const neverLookedAt = await calendarSubscriptionsRepository.insertSubscription(
      subInput(connectionId, { calendarId: 'cal-never-looked' })
    );
    await stampCreatedAt(noExpiry.id, '2026-08-19T00:00:00Z');
    await stampCreatedAt(neverLookedAt.id, '2026-08-19T00:00:00Z');

    // The vendor answered, and the answer was "no expiry" — expiration null, synced_at set.
    await calendarSubscriptionsRepository.stampVendorState(
      noExpiry.id,
      null,
      new Date('2026-08-19T01:00:00Z')
    );

    const rows = await calendarSubscriptionsRepository.listUnconfirmedBefore(
      new Date('2026-08-19T10:00:00Z'),
      10
    );

    expect(rows.map((r) => r.id)).toEqual([neverLookedAt.id]);
  });

  it('honours the batch limit', async () => {
    const { connectionId } = await seedConnection();
    const first = await calendarSubscriptionsRepository.insertSubscription(
      subInput(connectionId, { calendarId: 'cal-1' })
    );
    const second = await calendarSubscriptionsRepository.insertSubscription(
      subInput(connectionId, { calendarId: 'cal-2' })
    );
    await stampCreatedAt(first.id, '2026-08-18T00:00:00Z');
    await stampCreatedAt(second.id, '2026-08-18T06:00:00Z');

    const rows = await calendarSubscriptionsRepository.listUnconfirmedBefore(
      new Date('2026-08-19T00:00:00Z'),
      1
    );
    expect(rows.map((r) => r.id)).toEqual([first.id]);
  });
});

// ── Monitor arm 3 — the inverse alert ─────────────────────────────

describe('calendarSubscriptionsRepository.listActiveConnectionsWithoutSubscription', () => {
  it('returns an ACTIVE connection with no rows, and EXCLUDES one with a live row', async () => {
    const bare = await seedConnection('google');
    const covered = await seedConnection('microsoft');
    await calendarSubscriptionsRepository.insertSubscription(subInput(covered.connectionId));

    const rows = await calendarSubscriptionsRepository.listActiveConnectionsWithoutSubscription(50);
    const ids = rows.map((r) => r.connectionId);

    expect(ids).toContain(bare.connectionId);
    expect(ids).not.toContain(covered.connectionId);
    // The expert id comes back so the caller can enqueue a repair without a second read.
    expect(rows.find((r) => r.connectionId === bare.connectionId)?.expertProfileId).toBe(
      bare.expertProfileId
    );
  });

  it('⚠⚠ EXCLUDES an ACTIVE connection that legitimately wants NO subscriptions', async () => {
    // PR #223 review. The reconciler's DESIRED set is the conflict-checked sub-calendars, so a
    // connection with none SHOULD have zero subscriptions — the reconcile correctly creates
    // nothing. Alerting on bare absence would page about it every day forever with the
    // self-heal structurally unable to fix it: the alert-fatigue failure mode this feature is
    // otherwise careful to avoid, reached in the ENABLED steady state rather than on revert.
    //
    // ⚠ AND IT IS REACHABLE, NOT THEORETICAL: `provisionConnection` floors conflictCheck on the
    // PRIMARY calendar, but when the provider reports no writable calendar as primary the
    // connection is still persisted ACTIVE with every conflictCheck false.
    const wantsNothing = await seedConnection('google', 'ACTIVE', { conflictCheckCalendars: 0 });
    const wantsOne = await seedConnection('microsoft', 'ACTIVE');

    const rows = await calendarSubscriptionsRepository.listActiveConnectionsWithoutSubscription(50);
    const ids = rows.map((r) => r.connectionId);

    expect(ids).not.toContain(wantsNothing.connectionId);
    expect(ids).toContain(wantsOne.connectionId);
  });

  it('EXCLUDES a connection whose sub-calendars all have conflictCheck OFF', async () => {
    const { connectionId } = await seedConnection('google', 'ACTIVE', {
      conflictCheckCalendars: 0,
    });
    // Rows exist, but none is conflict-checked — still nothing desired, so still no alert.
    await calendarRepository.replaceSubCalendars(connectionId, [
      {
        calendarId: 'read-only-ish',
        name: 'Not conflict checked',
        provider: 'google',
        profileName: null,
        isPrimary: false,
        conflictCheck: false,
        color: null,
      },
    ]);

    const rows = await calendarSubscriptionsRepository.listActiveConnectionsWithoutSubscription(50);
    expect(rows.map((r) => r.connectionId)).not.toContain(connectionId);
  });

  it('INCLUDES a connection whose ONLY subscription is soft-deleted', async () => {
    const { connectionId } = await seedConnection();
    const row = await calendarSubscriptionsRepository.insertSubscription(subInput(connectionId));
    await calendarSubscriptionsRepository.softDeleteById(row.id);

    // This is the shape a silent platform-wide expiry leaves behind — a connection that once
    // had coverage and now has none. Arms 1 and 2 scan `calendar_subscriptions`, so they see
    // NOTHING here and report a clean bill of health while the change push is dead.
    const rows = await calendarSubscriptionsRepository.listActiveConnectionsWithoutSubscription(50);
    expect(rows.map((r) => r.connectionId)).toContain(connectionId);
  });

  it('excludes non-ACTIVE connections and soft-deleted connections', async () => {
    const expired = await seedConnection('google', 'EXPIRED');
    const pending = await seedConnection('microsoft', 'SYNC_PENDING');
    const disconnected = await seedConnection('google');
    await calendarRepository.softDeleteConnectionForProvider(
      disconnected.expertProfileId,
      'google'
    );

    const ids = (
      await calendarSubscriptionsRepository.listActiveConnectionsWithoutSubscription(200)
    ).map((r) => r.connectionId);

    // A broken credential is the health probe's problem, not the subscription monitor's —
    // alerting on it here would double-report one outage under two different names.
    expect(ids).not.toContain(expired.connectionId);
    expect(ids).not.toContain(pending.connectionId);
    expect(ids).not.toContain(disconnected.connectionId);
  });

  it('honours the batch limit', async () => {
    await seedConnection('google');
    await seedConnection('microsoft');

    const rows = await calendarSubscriptionsRepository.listActiveConnectionsWithoutSubscription(1);
    expect(rows).toHaveLength(1);
  });
});

// ── Posture ───────────────────────────────────────────────────────

describe('calendar_subscriptions — the soft-delete posture', () => {
  it('carries all four convention columns (created/updated/deleted), unlike the marker table', async () => {
    const { connectionId } = await seedConnection();
    const row = await calendarSubscriptionsRepository.insertSubscription(subInput(connectionId));

    // The contrast with `apiroc_webhook_events` is deliberate and is the reason one unique
    // index is partial and the other is not. Asserted so a "consistency" pass that strips
    // these fails here and has to read the rationale.
    const columns = Object.keys(row);
    expect(columns).toContain('createdAt');
    expect(columns).toContain('updatedAt');
    expect(columns).toContain('deletedAt');
  });

  it('every live read filters deleted_at IS NULL — proven by a raw count vs the repository', async () => {
    const { connectionId } = await seedConnection();
    const live = await calendarSubscriptionsRepository.insertSubscription(subInput(connectionId));
    const dead = await calendarSubscriptionsRepository.insertSubscription(
      subInput(connectionId, { calendarId: 'cal-dead' })
    );
    await calendarSubscriptionsRepository.softDeleteById(dead.id);

    const raw = await db
      .select()
      .from(calendarSubscriptions)
      .where(eq(calendarSubscriptions.connectionId, connectionId));
    const liveOnly = await db
      .select()
      .from(calendarSubscriptions)
      .where(
        and(
          eq(calendarSubscriptions.connectionId, connectionId),
          isNull(calendarSubscriptions.deletedAt)
        )
      );

    expect(raw).toHaveLength(2);
    expect(liveOnly).toHaveLength(1);
    expect(
      (await calendarSubscriptionsRepository.listLiveByConnectionId(connectionId)).map((r) => r.id)
    ).toEqual([live.id]);
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';

/**
 * CHARACTERISES the driver hazard behind `prepare: false` on the production client.
 *
 * ⚠ This suite does NOT pin `client.ts` — it builds its own clients with explicit options,
 * so deleting `prepare: false` from production leaves it green. The regression guard on
 * that config line is `invariants/production-client-disables-prepared-statements.test.ts`.
 * Both are needed: this one proves the hazard is real, that one proves we still avoid it.
 *
 * THE BUG THIS GUARDS. Drizzle sends application SQL unnamed (everything goes through
 * `client.unsafe`), but postgres-js issues its OWN transaction control as a tagged template —
 * `sql`commit`` — which IS prepared and given a server-side NAME cached per socket. The apps
 * connect through Supabase's TRANSACTION-mode pooler, where a socket is rebound to a different
 * backend between transactions, so a later transaction can meet a backend that never parsed
 * that name → 26000. postgres-js lists `FetchPreparedStatement` in its `retryRoutines`, so
 * rather than rejecting it RE-EXECUTES the COMMIT — inside an aborted block. Postgres permits
 * that, rolls back, and answers with the tag ROLLBACK and no error. `db.transaction()` then
 * RESOLVES and every write in it is silently gone.
 *
 * In production this discarded a real A$300 wallet credit: the ledger entry was applied and
 * logged, the wallet updated, the webhook acked HTTP 200 to Stripe, and nothing persisted —
 * not even the webhook marker. Card charged, credit lost, no error raised anywhere.
 *
 * WHY `DEALLOCATE ALL`. It is not a contrivance — it reproduces exactly the state the pooler
 * creates: the driver's per-socket cache still holds a statement name that the backend on the
 * other end does not have. That makes the hazard reproducible on a plain container, with no
 * pooler in the harness.
 *
 * NOTE: this test deliberately builds its OWN clients rather than using the shared harness.
 * The harness runs each test inside one outer transaction on a `max:1` pool, which cannot
 * express "a second transaction on the same socket" at all.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';

const clients: postgres.Sql[] = [];
function client(options: postgres.Options<Record<string, never>>): postgres.Sql {
  const c = postgres(TEST_DATABASE_URL, { max: 1, ...options });
  clients.push(c);
  return c;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.end({ timeout: 5 })));
});

/** Runs two sequential transactions on ONE socket, with the backend swapped in between. */
async function writeAcrossBackendHandover(
  raw: postgres.Sql
): Promise<{ rejected: boolean; ids: number[] }> {
  const db = drizzle(raw);
  const table = `commit_probe_${Math.abs(Date.now() % 100000)}`;

  await raw.unsafe(`drop table if exists ${table}`);
  await raw.unsafe(`create table ${table} (id int primary key)`);

  // Transaction 1 — postgres-js parses and CACHES a server-side named statement for `commit`.
  await db.transaction(async (tx) => {
    await tx.execute(sql.raw(`insert into ${table} values (1)`));
  });

  // The backend hand-over: the driver's cache now names a statement this backend lacks.
  await raw.unsafe('deallocate all');

  // Transaction 2 — the one that silently vanishes under `prepare: true`.
  let rejected = false;
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`insert into ${table} values (2)`));
    });
  } catch {
    rejected = true;
  }

  const rows = await raw.unsafe(`select id from ${table} order by id`);
  await raw.unsafe(`drop table if exists ${table}`);
  return { rejected, ids: rows.map((r) => Number(r.id)) };
}

describe('postgres-js COMMIT across a pooler backend hand-over', () => {
  it('PERSISTS the second transaction with prepare:false (the production setting)', async () => {
    const { rejected, ids } = await writeAcrossBackendHandover(client({ prepare: false }));

    // The whole point: the write survives, and nothing had to be retried to achieve it.
    expect(ids).toEqual([1, 2]);
    expect(rejected).toBe(false);
  });

  it('DEMONSTRATES the silent loss with prepare:true — a resolved commit that rolled back', async () => {
    // This is the defect, asserted so the fix can never be quietly reverted: the driver
    // reports success while the row is gone. If this test ever starts failing because the
    // write survives, postgres-js changed its retry behaviour and the comment in client.ts
    // should be revisited — but `prepare: false` remains correct for transaction pooling.
    const { rejected, ids } = await writeAcrossBackendHandover(client({ prepare: true }));

    expect(rejected).toBe(false); // ← no error surfaced to the caller
    expect(ids).toEqual([1]); // ← and yet the second write is gone
  });
});

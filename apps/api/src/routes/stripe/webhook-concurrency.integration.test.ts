import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

/**
 * SILENT MONEY LOSS PROBE — two concurrent Stripe webhook deliveries for ONE wallet,
 * against a REAL Postgres.
 *
 * The incident: a card-backed A$300 top-up. Stripe delivered `setup_intent.succeeded` and
 * `payment_intent.succeeded` seconds apart. The `payment_intent.succeeded` handler ran to
 * completion — it logged "Applied credit ledger effect" (`deduped: false`), issued the
 * saved-card UPDATE, logged "Stripe webhook processed" and answered 200 — and yet
 * `credit_ledger` gained NO row, the balance never moved, and `stripe_webhook_events` never
 * got the marker. The entire transaction vanished, with no error at any level.
 *
 * Hypothesis under test: the two deliveries write the SAME `credit_wallets` row
 * (`setup_intent.succeeded` → `applyMandate`; `payment_intent.succeeded` →
 * `applyLedgerEntry`'s balance UPDATE + `applySavedCardDisplay`) and their interleaving
 * loses the credit. Every top-up in a card-backed low-balance mode runs that race.
 *
 * ⚠ HARNESS BYPASS — READ BEFORE EDITING. `packages/db/src/test/setup-integration.ts` runs
 * every integration test inside ONE transaction on a `max:1` pool, which makes true
 * concurrency INEXPRESSIBLE (a second connection cannot exist, and uncommitted rows are
 * invisible to anyone else). So this file takes the documented escape hatch: it builds its
 * own production-shaped client via `createConcurrentDb` and re-installs it with `_setDb` in
 * `beforeEach`, AFTER the harness's own `beforeEach` has swapped in the per-test
 * transaction. Everything written here COMMITS FOR REAL and is deleted by hand in
 * `afterAll` — nothing rolls back.
 *
 * Interleaving is forced with the documented technique: an out-of-band connection holds
 * `SELECT … FOR UPDATE` on the wallet row, and `pg_blocking_pids()` is polled until each
 * webhook request is observably parked mid-transaction on that row.
 */

vi.hoisted(() => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_123';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_123';
});

interface LogRecord {
  level: 'debug' | 'info' | 'warn' | 'error';
  ctx: unknown;
  msg: string;
}

const { mockPublish, logRecords } = vi.hoisted(() => {
  const records: LogRecord[] = [];
  return {
    logRecords: records,
    // Faithful to the incident: the post-commit receipt publish THROWS ("Custom Id cannot
    // contain :" — BullMQ rejecting a jobId) and the handler swallows it.
    mockPublish: vi.fn(async () => {
      throw new Error('Custom Id cannot contain :');
    }),
  };
});

vi.mock('stripe', async () => (await import('../../test/mocks/stripe.js')).stripeMockModule());
vi.mock('../../notifications/publisher.js', () => ({
  notificationEvents: { publish: mockPublish },
}));
vi.mock('@balo/shared/logging', () => {
  const record =
    (level: LogRecord['level']) =>
    (ctx: unknown, msg?: string): void => {
      logRecords.push({ level, ctx, msg: msg ?? String(ctx) });
    };
  const logger = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    child: () => logger,
  };
  return {
    createLogger: () => logger,
    log: logger,
    getTransport: () => undefined,
    LOGGER_OPTIONS: {},
    REDACT_PATHS: [],
  };
});

import { buildApp } from '../../app.js';
import { mockStripe, resetStripeMock } from '../../test/mocks/stripe.js';

// ── the concurrency escape hatch ─────────────────────────────────────────────────────────
/**
 * Loaded through a VARIABLE specifier on purpose: a static deep import would pull
 * `packages/db/src/**` into `apps/api`'s `tsc --noEmit` program and break its `rootDir`.
 * If this ever resolved to a second module instance rather than the one `@balo/db` and the
 * harness share, every test below would fail immediately on an undefined `db` — so the
 * suite passing is itself the proof that the API is talking to the client installed here.
 */
const CONCURRENT_CLIENT_MODULE = '../../../../../packages/db/src/test/concurrent-client';

/** Minimal structural view of a `postgres-js` client (the module arrives untyped). */
type RawSql = (<T>(strings: TemplateStringsArray, ...values: unknown[]) => Promise<T[]>) & {
  reserve(): Promise<ReservedSql>;
  end(options?: { timeout?: number }): Promise<void>;
};
type ReservedSql = (<T>(strings: TemplateStringsArray, ...values: unknown[]) => Promise<T[]>) & {
  release(): void;
};
interface ConcurrentClientModule {
  _setDb: (next: unknown) => void;
  createConcurrentDb: (
    url: string,
    options?: Record<string, unknown>
  ) => { db: unknown; client: RawSql };
}

const url = process.env.TEST_DATABASE_URL!;
let harness: ConcurrentClientModule;
/** Out-of-band connections: the lock holder, the `pg_blocking_pids` poller, the cleanup. */
let adminSql: RawSql;
/** What the API will run on: a bare `postgres(url)`, prepare ON — production's shape. */
let prodDb: unknown;
let prodClient: RawSql;

let app: FastifyInstance;
let userId: string;
let companyId: string;
let walletId: string;

const START_BALANCE = 100_000; // A$1,000.00 — the incident's pre-top-up balance
const TOPUP_MINOR = 30_000; // A$300.00 — the amount that vanished

function inject(fastify: FastifyInstance, body: unknown) {
  return fastify.inject({
    method: 'POST',
    url: '/webhooks/stripe',
    headers: { 'content-type': 'application/json', 'stripe-signature': 'valid_sig' },
    payload: JSON.stringify(body),
  });
}

function paymentIntentSucceeded(eventId: string, piId: string) {
  return {
    id: eventId,
    type: 'payment_intent.succeeded',
    data: {
      object: {
        id: piId,
        // `customer` + `payment_method` are what make `resolveCardOnFile` non-null, which is
        // what adds the SECOND `credit_wallets` UPDATE (`applySavedCardDisplay`) to this
        // transaction. Without them the race under test does not exist.
        customer: 'cus_incident',
        payment_method: 'pm_incident',
        metadata: { walletId, reason: 'manual_purchase', memberId: userId },
      },
    },
  };
}

function setupIntentSucceeded(eventId: string, siId: string) {
  return {
    id: eventId,
    type: 'setup_intent.succeeded',
    data: {
      object: {
        id: siId,
        customer: 'cus_incident',
        payment_method: 'pm_incident',
        metadata: { walletId },
      },
    },
  };
}

interface BlockedBackend {
  pid: number;
  query: string;
  blockers: number[];
}

/** Backends currently BLOCKED on another backend's lock, and what they are stuck on. */
async function blockedBackends(): Promise<BlockedBackend[]> {
  return adminSql<BlockedBackend>`
    SELECT a.pid,
           left(regexp_replace(a.query, '\\s+', ' ', 'g'), 70) AS query,
           pg_blocking_pids(a.pid) AS blockers
    FROM pg_stat_activity a
    WHERE a.datname = current_database()
      AND cardinality(pg_blocking_pids(a.pid)) > 0`;
}

async function waitForBlocked(n: number, whatFor: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  let last: BlockedBackend[] = [];
  while (Date.now() < deadline) {
    last = await blockedBackends();
    if (last.length >= n) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `timed out waiting for ${n} blocked backend(s) (${whatFor}); saw ${last.length}: ${JSON.stringify(last)}`
  );
}

/** Hold a real row lock on the wallet from an out-of-band transaction. */
async function holdWalletRowLock(): Promise<{ release: () => Promise<void> }> {
  const held = await adminSql.reserve();
  await held`BEGIN`;
  await held`SELECT id FROM credit_wallets WHERE id = ${walletId} FOR UPDATE`;
  return {
    release: async () => {
      await held`COMMIT`;
      held.release();
    },
  };
}

/**
 * `postgres@3.4.8` raises an UNCAUGHT `TypeError: Cannot read properties of null (reading
 * 'write')` (connection.js:255) when it touches a socket whose backend was terminated. That
 * is a production hazard in its own right — a pooler eviction can take the API process down
 * — but it is not the invariant test E is about, and vitest fails a whole file on any
 * unhandled error, so E quarantines that one crash for the duration of the kill.
 */
function quarantineTerminatedSocketCrash(): () => void {
  const prior = process.listeners('uncaughtException');
  process.removeAllListeners('uncaughtException');
  const handler = (err: unknown): void => {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("reading 'write'")) return;
    for (const listener of prior) listener(err as Error, 'uncaughtException');
  };
  process.on('uncaughtException', handler);
  return () => {
    process.off('uncaughtException', handler);
    for (const listener of prior) process.on('uncaughtException', listener);
  };
}

async function walletBalance(): Promise<number> {
  const [row] = await adminSql<{ balance_minor: string }>`
    SELECT balance_minor FROM credit_wallets WHERE id = ${walletId}`;
  return Number(row!.balance_minor);
}

async function ledgerKeys(): Promise<string[]> {
  const rows = await adminSql<{ idempotency_key: string }>`
    SELECT idempotency_key FROM credit_ledger WHERE wallet_id = ${walletId} ORDER BY seq`;
  return rows.map((r) => r.idempotency_key);
}

async function markers(): Promise<Array<{ event_id: string; processed_at: Date | null }>> {
  return adminSql<{ event_id: string; processed_at: Date | null }>`
    SELECT event_id, processed_at FROM stripe_webhook_events
    WHERE event_id LIKE 'evt_conc_%' ORDER BY received_at`;
}

/** Every error the application logged — the incident logged NONE from the money path. */
function errorLogs(): LogRecord[] {
  return logRecords.filter((l) => l.level === 'error');
}

describe('Stripe webhook — concurrent setup_intent + payment_intent on ONE wallet', () => {
  beforeAll(async () => {
    harness = (await import(CONCURRENT_CLIENT_MODULE)) as ConcurrentClientModule;
    ({ db: prodDb, client: prodClient } = harness.createConcurrentDb(url));
    adminSql = harness.createConcurrentDb(url, { max: 6 }).client;
    harness._setDb(prodDb);

    const [user] = await adminSql<{ id: string }>`
      INSERT INTO users (workos_id, email)
      VALUES (${`wos_conc_${Date.now()}`}, ${`conc_${Date.now()}@test.com`})
      RETURNING id`;
    userId = user!.id;
    const [company] = await adminSql<{ id: string }>`
      INSERT INTO companies (name, is_personal) VALUES ('Concurrency Probe Co', false)
      RETURNING id`;
    companyId = company!.id;
    // A card-backed low-balance mode — the mode that opens a SetupIntent alongside the
    // PaymentIntent, which is what creates the race. The account's FIRST top-up (which
    // credited correctly) was 'notify_only' and opened no SetupIntent.
    const [wallet] = await adminSql<{ id: string }>`
      INSERT INTO credit_wallets (company_id, balance_minor, low_balance_mode)
      VALUES (${companyId}, ${START_BALANCE}, 'auto_topup')
      RETURNING id`;
    walletId = wallet!.id;

    app = await buildApp({ logger: false });
  });

  afterAll(async () => {
    await app?.close();
    await prodClient?.end({ timeout: 5 }).catch(() => undefined);
    // Nothing here rolls back — delete by hand, over the out-of-band client, FK order first.
    await adminSql`DELETE FROM credit_ledger WHERE wallet_id = ${walletId}`;
    await adminSql`DELETE FROM audit_events WHERE entity_id = ${walletId}`;
    await adminSql`DELETE FROM credit_wallets WHERE id = ${walletId}`;
    await adminSql`DELETE FROM companies WHERE id = ${companyId}`;
    await adminSql`DELETE FROM users WHERE id = ${userId}`;
    await adminSql`DELETE FROM stripe_webhook_events WHERE event_id LIKE 'evt_conc_%'`;
    await adminSql.end();
  });

  beforeEach(() => {
    // The harness's own beforeEach just swapped `db` to the per-test transaction on the
    // max:1 pool. Put the real pooled client back — concurrency needs real connections.
    harness._setDb(prodDb);
    logRecords.length = 0;
    resetStripeMock();
    mockPublish.mockClear();
    mockStripe.paymentIntents.retrieve.mockImplementation(async (id: string) => ({
      id,
      latest_charge: `ch_${id}`,
    }));
    mockStripe.charges.retrieve.mockImplementation(async (id: string) => ({
      id,
      currency: 'aud',
      amount: TOPUP_MINOR,
      balance_transaction: {
        id: `txn_${id}`,
        amount: TOPUP_MINOR,
        currency: 'aud',
        exchange_rate: null,
      },
    }));
    mockStripe.paymentMethods.retrieve.mockResolvedValue({
      id: 'pm_incident',
      type: 'card',
      card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 },
    });
  });

  it('A: payment_intent parked mid-transaction, setup_intent joins the queue, then both release', async () => {
    const before = await walletBalance();
    const pi = 'pi_conc_A';
    const holder = await holdWalletRowLock();

    // PI first: it takes the advisory lock, inserts the ledger row, then BLOCKS on the
    // wallet UPDATE — stopped INSIDE its transaction with the ledger row uncommitted.
    const piRes = inject(app, paymentIntentSucceeded('evt_conc_A_pi', pi));
    await waitForBlocked(1, 'payment_intent parked on the wallet UPDATE');

    // SI now queues behind it on the same row.
    const siRes = inject(app, setupIntentSucceeded('evt_conc_A_si', 'seti_conc_A'));
    await waitForBlocked(2, 'setup_intent queued behind payment_intent');

    const blocked = await blockedBackends();
    await holder.release();
    const [piResponse, siResponse] = await Promise.all([piRes, siRes]);

    console.log('[A] blocked backends at release:', JSON.stringify(blocked));
    console.log('[A] responses:', piResponse.statusCode, siResponse.statusCode);
    console.log('[A] error logs:', JSON.stringify(errorLogs()));

    // Both handlers really were parked inside their transactions on the wallet row.
    expect(blocked).toHaveLength(2);
    expect(piResponse.statusCode).toBe(200);
    expect(siResponse.statusCode).toBe(200);

    // THE MONEY CLAIM. A 200 must mean the credit is durable.
    expect(await ledgerKeys()).toContain(`manual_purchase:${pi}`);
    expect(await walletBalance()).toBe(before + TOPUP_MINOR);
    const rows = await markers();
    expect(rows.map((r) => r.event_id)).toEqual(
      expect.arrayContaining(['evt_conc_A_pi', 'evt_conc_A_si'])
    );
    expect(rows.every((r) => r.processed_at !== null)).toBe(true);
  });

  it('B: setup_intent holds the wallet row first, payment_intent queues behind it', async () => {
    const before = await walletBalance();
    const pi = 'pi_conc_B';
    const holder = await holdWalletRowLock();

    const siRes = inject(app, setupIntentSucceeded('evt_conc_B_si', 'seti_conc_B'));
    await waitForBlocked(1, 'setup_intent parked on the wallet UPDATE');

    const piRes = inject(app, paymentIntentSucceeded('evt_conc_B_pi', pi));
    await waitForBlocked(2, 'payment_intent queued behind setup_intent');

    const blocked = await blockedBackends();
    await holder.release();
    const [siResponse, piResponse] = await Promise.all([siRes, piRes]);

    console.log('[B] blocked backends at release:', JSON.stringify(blocked));
    console.log('[B] responses:', siResponse.statusCode, piResponse.statusCode);
    console.log('[B] error logs:', JSON.stringify(errorLogs()));

    expect(blocked).toHaveLength(2);
    expect(siResponse.statusCode).toBe(200);
    expect(piResponse.statusCode).toBe(200);
    expect(await ledgerKeys()).toContain(`manual_purchase:${pi}`);
    expect(await walletBalance()).toBe(before + TOPUP_MINOR);
  });

  it('C: 12 unforced setup_intent/payment_intent races credit exactly 12 times', async () => {
    const before = await walletBalance();
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const [si, pi] = await Promise.all([
        inject(app, setupIntentSucceeded(`evt_conc_C${i}_si`, `seti_conc_C${i}`)),
        inject(app, paymentIntentSucceeded(`evt_conc_C${i}_pi`, `pi_conc_C${i}`)),
      ]);
      statuses.push(si.statusCode, pi.statusCode);
    }
    const keys = await ledgerKeys();
    const balance = await walletBalance();

    console.log('[C] statuses:', statuses.join(','));
    console.log('[C] balance delta:', balance - before, 'expected', 12 * TOPUP_MINOR);
    console.log('[C] non-receipt error logs:', JSON.stringify(errorLogs().length));

    expect(statuses.every((s) => s === 200)).toBe(true);
    for (let i = 0; i < 12; i++) {
      expect(keys).toContain(`manual_purchase:pi_conc_C${i}`);
    }
    expect(balance).toBe(before + 12 * TOPUP_MINOR);
  });

  it('D: the SAME payment_intent event delivered twice concurrently credits exactly once', async () => {
    const before = await walletBalance();
    const event = paymentIntentSucceeded('evt_conc_D_pi', 'pi_conc_D');
    const [first, second] = await Promise.all([inject(app, event), inject(app, event)]);

    const keys = await ledgerKeys();
    const balance = await walletBalance();
    const rows = (await markers()).filter((r) => r.event_id === 'evt_conc_D_pi');

    console.log('[D] responses:', first.statusCode, second.statusCode);
    console.log('[D] balance delta:', balance - before, '| markers:', JSON.stringify(rows));
    console.log('[D] error logs:', JSON.stringify(errorLogs()));

    expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
    expect(keys.filter((k) => k === 'manual_purchase:pi_conc_D')).toHaveLength(1);
    expect(balance).toBe(before + TOPUP_MINOR);
    // A 200 with NO marker is precisely the incident signature.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.processed_at).not.toBeNull();
  });

  /**
   * The one mechanism that can turn a completed handler into a rolled-back transaction with
   * no application error: the server connection dies (or a pooler evicts it) between the
   * last statement and COMMIT. Postgres discards the work; the question this pins is whether
   * the CLIENT notices. If `postgres-js` swallowed it, the route would answer 200 with
   * nothing persisted — the incident signature exactly.
   */
  it('E: killing the backend mid-transaction must NOT produce a 200 with nothing persisted', async () => {
    const before = await walletBalance();
    const pi = 'pi_conc_E';
    // Throwaway client: a terminated backend leaves `postgres-js` writing to a dead socket,
    // so the damage must not land on the pool the other tests share.
    const doomed = harness.createConcurrentDb(url, { max: 1 });
    harness._setDb(doomed.db);
    const holder = await holdWalletRowLock();

    const piRes = inject(app, paymentIntentSucceeded('evt_conc_E_pi', pi));
    await waitForBlocked(1, 'payment_intent parked before its wallet UPDATE');
    const [parked] = await blockedBackends();

    const restoreCrashHandling = quarantineTerminatedSocketCrash();
    await adminSql`SELECT pg_terminate_backend(${parked!.pid})`;
    await holder.release();

    let status: number;
    let threw: string | null = null;
    try {
      status = (await piRes).statusCode;
    } catch (err) {
      status = -1;
      threw = err instanceof Error ? err.message : String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, 300)); // let the dead-socket immediate fire
    restoreCrashHandling();
    // `doomed` is deliberately NOT `end()`-ed — see quarantineTerminatedSocketCrash.
    harness._setDb(prodDb);

    const keys = await ledgerKeys();
    const balance = await walletBalance();
    const rows = (await markers()).filter((r) => r.event_id === 'evt_conc_E_pi');
    const persisted = keys.includes(`manual_purchase:${pi}`);

    console.log('[E] killed pid', parked!.pid, '→ status', status, 'threw:', threw);
    console.log('[E] persisted:', persisted, '| balance delta:', balance - before);
    console.log('[E] markers:', JSON.stringify(rows), '| error logs:', JSON.stringify(errorLogs()));

    // THE INVARIANT. A 200 is a promise that the credit is durable: either the money landed,
    // or the caller was NOT told 200 (a 500 makes Stripe redeliver, which recovers it).
    if (!persisted) {
      expect(balance).toBe(before);
      expect(rows).toHaveLength(0);
      expect(status).not.toBe(200);
    }
  });

  /** Same probe, but a statement CANCEL (57014) rather than a backend kill. */
  it('F: cancelling the in-flight statement must NOT produce a 200 with nothing persisted', async () => {
    const before = await walletBalance();
    const pi = 'pi_conc_F';
    const doomed = harness.createConcurrentDb(url, { max: 1 });
    harness._setDb(doomed.db);
    const holder = await holdWalletRowLock();

    const piRes = inject(app, paymentIntentSucceeded('evt_conc_F_pi', pi));
    await waitForBlocked(1, 'payment_intent parked before its wallet UPDATE');
    const [parked] = await blockedBackends();

    await adminSql`SELECT pg_cancel_backend(${parked!.pid})`;
    await holder.release();

    let status: number;
    let threw: string | null = null;
    try {
      status = (await piRes).statusCode;
    } catch (err) {
      status = -1;
      threw = err instanceof Error ? err.message : String(err);
    }
    await doomed.client.end({ timeout: 5 }).catch(() => undefined);
    harness._setDb(prodDb);

    const keys = await ledgerKeys();
    const balance = await walletBalance();
    const rows = (await markers()).filter((r) => r.event_id === 'evt_conc_F_pi');
    const persisted = keys.includes(`manual_purchase:${pi}`);

    console.log('[F] cancelled pid', parked!.pid, '→ status', status, 'threw:', threw);
    console.log('[F] persisted:', persisted, '| balance delta:', balance - before);
    console.log('[F] markers:', JSON.stringify(rows), '| error logs:', JSON.stringify(errorLogs()));

    if (!persisted) {
      expect(balance).toBe(before);
      expect(rows).toHaveLength(0);
      expect(status).not.toBe(200);
    }
  });
});

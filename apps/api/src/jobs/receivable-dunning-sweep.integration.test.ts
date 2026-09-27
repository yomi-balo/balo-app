import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * BAL-474 F9 (service level) + the dunning claim race — ONE wallet-grain notice stating the
 * top-up that clears the hold (ADR-1040 Amendment 7, plan §G / D6.2, D7.1, D7.2, D8.1, D8.4),
 * against a real Postgres.
 *
 * What lives here, and why here: `packages/db` cannot import `apps/api`, so every F9 case that
 * drives `notify.ts` (the claim, the publisher, both heal entry points) or the sweep job is in
 * this file. The pure `readHoldStatus` figure cases and the fairness-order case are in
 * `packages/db` and are NOT repeated.
 *
 *   · R3-F1 — a `receivable_opened` notice is NEVER throttled, and it never stamps: a new debt
 *     two hours after a notice gets a second notice at once, and the next morning's sweep still
 *     selects the wallet.
 *   · R3-F6 — a covered-but-held wallet (a covering credit that cleared nothing) is HEALED by the
 *     claim — an audited system clear — never dunned for A$0.00.
 *   · D8.1 — the booking guard's `healCoveredHoldNow` heals the same way, and every heal's
 *     cleared notice carries a per-write identity (D8.4), never a per-wallet key.
 *
 * ⚠ THE DEBTS ARE BUILT AT THE REPOSITORY LEVEL, deliberately. `openReceivableAndDun` would
 * publish its own `receivable_opened` notice at the wall-clock instant; these cases need to
 * control WHEN each notice is published (14:00, 16:00, the next day's 09:00). So each debt is
 * the repository write that path makes — settle the presence session, then, in ONE
 * wallet-locked transaction, mark it `failed` and open its receivable — and each notice is
 * published explicitly with a derived `now`. Every instant is derived from `new Date()` at
 * test time; no calendar date is hard-coded.
 *
 * ⚠ THE CLAIM RACE (plan §9 Concurrency, V4-F8) CANNOT RUN ON THE STANDARD HARNESS: one
 * `max: 1` connection inside one transaction makes two claims re-enter the same advisory lock
 * sequentially, so the case would pass with the lock deleted. Its describe block takes the
 * documented escape hatch (`createConcurrentDb` + `_setDb`), commits for real on three raw
 * connections, orders them deterministically through `pg_blocking_pids` (never a fixed sleep),
 * and deletes every row it wrote.
 *
 * Mocks, and only this one: the BullMQ queue, so each publish is captured with its real
 * `correlationId` (and `buildJobId` stays real). The repositories, the coverage module and the
 * notify module are the production code.
 */

interface QueuedJob {
  readonly queue: string;
  readonly name: string;
  readonly data: unknown;
}

const { queued, mockGetQueue } = vi.hoisted(() => {
  const jobs: QueuedJob[] = [];
  return {
    queued: jobs,
    mockGetQueue: vi.fn((queue: string) => ({
      add: vi.fn(async (name: string, data: unknown) => {
        jobs.push({ queue, name, data });
        return { id: `job-${String(jobs.length)}` };
      }),
    })),
  };
});

vi.mock('../lib/queue.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/queue.js')>()),
  getQueue: mockGetQueue,
}));

import {
  acquireWalletLock,
  and,
  auditEvents,
  companies,
  creditLedger,
  creditLedgerRepository,
  creditReceivables,
  creditReceivablesRepository,
  creditSessions,
  creditSessionsRepository,
  creditWallets,
  creditWalletsRepository,
  db,
  eq,
  expertProfiles,
  inArray,
  meetingsRepository,
  or,
  users,
  verticals,
  type AuditEvent,
  type CreditReceivable,
  type Database,
} from '@balo/db';
import { deriveSessionEstimate } from '@balo/shared/credit';
import { seedBookingParties } from '../test/fixtures/booking-graph.js';
import {
  claimHoldDunningNotice,
  DUNNING_CADENCE_HOURS,
  healCoveredHoldNow,
  publishHoldDunningNotice,
} from '../services/credit-session/notify.js';
import { runReceivableDunningSweep } from './receivable-dunning-sweep.js';

// ── The plan's rates (§A.4): client 700/min, expert 500/min, floor 15 ─────────────────────

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
/** A$300.00/h raw expert rate. */
const EXPERT_HOURLY_MINOR = 30_000;
/** 40% — with the rate above, `deriveSessionEstimate` yields exactly the plan's 700 / 500. */
const BALO_FEE_BPS = 4_000;
const FLOOR_MINUTES = 15;
const PLAN_RATES = deriveSessionEstimate({
  expertHourlyMinor: EXPERT_HOURLY_MINOR,
  estimatedMinutes: 1,
  baloFeeBps: BALO_FEE_BPS,
});

const HEAL_ACTION = 'credit_receivable.cleared_on_coverage_heal';
const DUNNING_EVENT = 'session.settlement_failed';
const RECEIVABLE_CLEARED_EVENT = 'credit.receivable.cleared';

function minutesAfter(at: Date, minutes: number): Date {
  return new Date(at.getTime() + minutes * MS_PER_MINUTE);
}

function hoursAfter(at: Date, hours: number): Date {
  return new Date(at.getTime() + hours * MS_PER_HOUR);
}

/** 00:00 UTC of the day `at` falls on. */
function utcMidnightOf(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

// ── Fixture (harness-bound) ───────────────────────────────────────────────────

interface Ctx {
  readonly companyId: string;
  readonly memberId: string;
  readonly expertProfileId: string;
  readonly engagementId: string;
  readonly walletId: string;
}

/** A client company, a live member, an expert at the plan's rate, a case engagement, and a
 *  CARD-LESS wallet at `balanceMinor` (no mandate, `notify_only`) — the dunning population. */
async function seedCardlessWallet(balanceMinor: number): Promise<Ctx> {
  const parties = await seedBookingParties();
  await db
    .update(expertProfiles)
    .set({ rateCents: EXPERT_HOURLY_MINOR })
    .where(eq(expertProfiles.id, parties.expertProfileId));
  const [wallet] = await db
    .insert(creditWallets)
    .values({ companyId: parties.companyId, balanceMinor })
    .returning({ id: creditWallets.id });
  if (wallet === undefined) {
    throw new Error('fixture: wallet insert returned no row');
  }
  return {
    companyId: parties.companyId,
    memberId: parties.memberUserId,
    expertProfileId: parties.expertProfileId,
    engagementId: parties.caseEngagementId,
    walletId: wallet.id,
  };
}

async function bookCaseMeeting(ctx: Ctx, startsAt: Date): Promise<string> {
  const { meeting } = await meetingsRepository.create({
    scheduledStart: startsAt,
    scheduledEnd: minutesAfter(startsAt, 30),
    contexts: [{ contextType: 'case', contextId: ctx.engagementId }],
    actorUserId: ctx.memberId,
  });
  return meeting.id;
}

/** The admission-seam open: presence-sourced and overdraft-tolerant (plan §B.1). */
async function openAdmittedSession(
  ctx: Ctx,
  meetingId: string,
  estimatedMinutes: number
): Promise<string> {
  const res = await creditSessionsRepository.open({
    walletId: ctx.walletId,
    companyId: ctx.companyId,
    expertProfileId: ctx.expertProfileId,
    initiatingMemberId: ctx.memberId,
    estimatedMinutes,
    baloFeeBps: BALO_FEE_BPS,
    meetingId,
    engagementId: ctx.engagementId,
    durationSource: 'presence',
    fundingPolicy: 'overdraft_tolerant',
    openedBy: 'client',
  });
  if (!res.ok) {
    throw new Error(`expected open ok, got ${res.code}`);
  }
  return res.session.id;
}

/**
 * Settle a never-metered presence session as `held` at `billableMinutes`, then record the failed
 * settlement exactly as `openReceivableAndDun` writes it — in ONE transaction under the wallet
 * lock, stamp `failed` and open the receivable for THIS session's share — WITHOUT that path's
 * post-commit dunning publish (each case publishes at an instant it controls).
 */
async function settleIntoReceivable(
  ctx: Ctx,
  sessionId: string,
  meetingId: string,
  settlement: { billableMinutes: number; now: Date }
): Promise<CreditReceivable> {
  const settled = await creditSessionsRepository.settleFromPresence({
    sessionId,
    meetingId,
    billableMinutes: settlement.billableMinutes,
    actualMinutes: settlement.billableMinutes,
    billingFloorMinutes: FLOOR_MINUTES,
    topUpFromTickSeq: 1,
    topUpToTickSeq: settlement.billableMinutes,
    minutesAlreadyDrawn: 0,
    shape: 'held',
    floorApplied: false,
    outcome: 'completed',
    actorUserId: null,
    now: settlement.now,
  });
  return db.transaction(async (tx) => {
    await acquireWalletLock(tx, ctx.walletId);
    await creditSessionsRepository.markSettlementResult(tx, { sessionId, status: 'failed' });
    const { receivable } = await creditReceivablesRepository.open(
      {
        companyId: ctx.companyId,
        walletId: ctx.walletId,
        sessionId,
        amountMinor: settled.overdraftMinor,
        reason: 'settlement_declined',
      },
      tx
    );
    return receivable;
  });
}

/**
 * A covering CASH credit that clears nothing: posted straight through the ledger primitive, so
 * the webhook's coverage clear never runs — the covered-but-held state R3-F6 is about.
 */
async function coverWithoutClearing(ctx: Ctx, amountMinor: number, key: string): Promise<void> {
  await creditLedgerRepository.postEntry({
    walletId: ctx.walletId,
    entryType: 'purchase',
    reason: 'manual_purchase',
    amountMinor,
    memberId: ctx.memberId,
    idempotencyKey: `manual_purchase:${key}`,
  });
}

async function walletBalance(walletId: string): Promise<number> {
  const wallet = await creditWalletsRepository.findById(walletId);
  if (wallet === undefined) {
    throw new Error(`wallet ${walletId} is missing`);
  }
  return wallet.balanceMinor;
}

async function receivableById(id: string): Promise<CreditReceivable> {
  const [row] = await db.select().from(creditReceivables).where(eq(creditReceivables.id, id));
  if (row === undefined) {
    throw new Error(`receivable ${id} is missing`);
  }
  return row;
}

async function healRows(receivableId: string): Promise<AuditEvent[]> {
  return db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.action, HEAL_ACTION), eq(auditEvents.entityId, receivableId)));
}

function payloadOf(data: unknown): Record<string, unknown> {
  if (typeof data === 'object' && data !== null && 'payload' in data) {
    const { payload } = data as { payload: unknown };
    if (typeof payload === 'object' && payload !== null) {
      return payload as Record<string, unknown>;
    }
  }
  throw new Error('a queued notification job carried no payload object');
}

/** Every payload published for `event` on this wallet since the last reset, in publish order. */
function publishesFor(event: string, walletId: string): Array<Record<string, unknown>> {
  return queued
    .filter((job) => job.queue === 'notification-events' && job.name === event)
    .map((job) => payloadOf(job.data))
    .filter((payload) => payload.walletId === walletId);
}

// ── F9, service level ─────────────────────────────────────────────────────────

describe('INVARIANT (integration): dunning states the top-up that clears the hold — the claim, the heal and the sweep (plan §G, F9)', () => {
  beforeEach(() => {
    queued.length = 0;
    mockGetQueue.mockClear();
  });

  it('⚠ FIXTURE GUARD: the plan rates — A$300/h at a 40% fee is 700/min to the client, 500/min to the expert', () => {
    expect(PLAN_RATES.clientRateMinorPerMinute).toBe(700);
    expect(PLAN_RATES.expertRateMinorPerMinute).toBe(500);
    expect(PLAN_RATES.baloFeeBps).toBe(BALO_FEE_BPS);
  });

  it('R3-F1 — a notice at 14:00, a new debt at 16:00 ⇒ a second notice at once carrying the new figure, and the next day’s 09:00 sweep still selects the wallet (no off-cycle stamp)', async () => {
    const midnight = utcMidnightOf(new Date());
    const at1400 = hoursAfter(midnight, 14);
    const at1600 = hoursAfter(midnight, 16);
    const nextDay0900 = hoursAfter(midnight, 24 + 9);
    const ctx = await seedCardlessWallet(4_000);

    // R1 10,000: S1 held 20 (14,000) from +4,000.
    const m1 = await bookCaseMeeting(ctx, minutesAfter(at1400, -90));
    const s1 = await openAdmittedSession(ctx, m1, 5);
    const r1 = await settleIntoReceivable(ctx, s1, m1, {
      billableMinutes: 20,
      now: minutesAfter(at1400, -30),
    });
    expect(r1.amountMinor).toBe(10_000);

    await publishHoldDunningNotice({
      walletId: ctx.walletId,
      companyId: ctx.companyId,
      trigger: 'receivable_opened',
      correlationKey: r1.id,
      now: at1400,
    });
    const afterFirst = publishesFor(DUNNING_EVENT, ctx.walletId);
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]).toMatchObject({
      correlationId: `hold_dunning:${r1.id}`,
      companyId: ctx.companyId,
      trigger: 'receivable_opened',
      topUpNeededMinor: 10_000,
      asOfIso: at1400.toISOString(),
    });

    // R2 14,000 at 16:00: S2 held 20 on the held wallet ⇒ −24,000.
    const m2 = await bookCaseMeeting(ctx, minutesAfter(at1600, -30));
    const s2 = await openAdmittedSession(ctx, m2, 30);
    const r2 = await settleIntoReceivable(ctx, s2, m2, {
      billableMinutes: 20,
      now: minutesAfter(at1600, -5),
    });
    expect(r2.amountMinor).toBe(14_000);
    expect(await walletBalance(ctx.walletId)).toBe(-24_000);

    await publishHoldDunningNotice({
      walletId: ctx.walletId,
      companyId: ctx.companyId,
      trigger: 'receivable_opened',
      correlationKey: r2.id,
      now: at1600,
    });
    const afterSecond = publishesFor(DUNNING_EVENT, ctx.walletId);
    expect(afterSecond).toHaveLength(2);
    expect(afterSecond[1]).toMatchObject({
      correlationId: `hold_dunning:${r2.id}`,
      trigger: 'receivable_opened',
      topUpNeededMinor: 24_000,
      asOfIso: at1600.toISOString(),
    });

    // Neither off-cycle notice stamped the daily cadence, so the 09:00 due set includes the wallet.
    expect(await creditReceivablesRepository.lastDailyDunningAt(ctx.walletId, db)).toBeUndefined();
    const due = await creditReceivablesRepository.listWalletsDueForDailyDunning(
      hoursAfter(nextDay0900, -DUNNING_CADENCE_HOURS)
    );
    expect(due).toContainEqual(
      expect.objectContaining({ walletId: ctx.walletId, companyId: ctx.companyId })
    );

    await runReceivableDunningSweep(nextDay0900);
    const afterSweep = publishesFor(DUNNING_EVENT, ctx.walletId);
    expect(afterSweep).toHaveLength(3);
    expect(afterSweep[2]).toMatchObject({
      correlationId: `hold_dunning:${ctx.walletId}:${String(nextDay0900.getTime())}`,
      trigger: 'daily_reminder',
      topUpNeededMinor: 24_000,
      asOfIso: nextDay0900.toISOString(),
    });
    // …and it is the DAILY arm that stamps.
    const stamped = await creditReceivablesRepository.lastDailyDunningAt(ctx.walletId, db);
    expect(stamped?.getTime()).toBe(nextDay0900.getTime());
  });

  it('R3-F6 — a covered-but-held wallet is healed by the claim: receivables cleared, one cleared_on_coverage_heal row per receivable (actor NULL), no dunning, and one receivable-cleared keyed on the first cleared receivable id', async () => {
    const now = new Date();
    const ctx = await seedCardlessWallet(4_000);

    const m1 = await bookCaseMeeting(ctx, minutesAfter(now, -90));
    const s1 = await openAdmittedSession(ctx, m1, 5);
    const r1 = await settleIntoReceivable(ctx, s1, m1, {
      billableMinutes: 20,
      now: minutesAfter(now, -60),
    });
    expect(r1.amountMinor).toBe(10_000);

    // A covering cash credit that cleared nothing ⇒ balance 0, the hold still on.
    await coverWithoutClearing(ctx, 10_000, `cover_${r1.id}`);
    expect(await walletBalance(ctx.walletId)).toBe(0);
    expect((await receivableById(r1.id)).status).toBe('open');

    await runReceivableDunningSweep(now);

    expect((await receivableById(r1.id)).status).toBe('cleared');
    const heals = await healRows(r1.id);
    expect(heals).toHaveLength(1);
    const [heal] = heals;
    expect(heal?.actorUserId).toBeNull();
    expect(heal?.metadata).toMatchObject({ walletId: ctx.walletId });

    expect(publishesFor(DUNNING_EVENT, ctx.walletId)).toHaveLength(0);
    const cleared = publishesFor(RECEIVABLE_CLEARED_EVENT, ctx.walletId);
    expect(cleared).toHaveLength(1);
    expect(cleared[0]).toMatchObject({
      correlationId: `receivable_cleared:${r1.id}`,
      clearedBy: 'coverage_heal',
    });
  });

  it('R3-F6 (two receivables) — one heal row PER receivable, each stamped with the trigger, and ONE notice for the whole wallet keyed on a cleared receivable id', async () => {
    const now = new Date();
    const ctx = await seedCardlessWallet(4_000);

    const m1 = await bookCaseMeeting(ctx, minutesAfter(now, -180));
    const s1 = await openAdmittedSession(ctx, m1, 5);
    const r1 = await settleIntoReceivable(ctx, s1, m1, {
      billableMinutes: 20,
      now: minutesAfter(now, -150),
    });
    const m2 = await bookCaseMeeting(ctx, minutesAfter(now, -90));
    const s2 = await openAdmittedSession(ctx, m2, 5);
    const r2 = await settleIntoReceivable(ctx, s2, m2, {
      billableMinutes: 20,
      now: minutesAfter(now, -60),
    });
    expect((await receivableById(r1.id)).status).toBe('open');
    expect((await receivableById(r2.id)).status).toBe('open');

    await coverWithoutClearing(ctx, r1.amountMinor + r2.amountMinor, `cover_both_${r1.id}`);
    expect(await walletBalance(ctx.walletId)).toBe(0);

    await runReceivableDunningSweep(now);

    expect((await receivableById(r1.id)).status).toBe('cleared');
    expect((await receivableById(r2.id)).status).toBe('cleared');
    for (const receivable of [r1, r2]) {
      const rows = await healRows(receivable.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.actorUserId).toBeNull();
      expect(rows[0]?.metadata).toMatchObject({
        walletId: ctx.walletId,
        trigger: 'dunning_claim',
        receivableAmountMinor: receivable.amountMinor,
      });
    }

    expect(publishesFor(DUNNING_EVENT, ctx.walletId)).toHaveLength(0);
    const cleared = publishesFor(RECEIVABLE_CLEARED_EVENT, ctx.walletId);
    expect(cleared).toHaveLength(1);
    expect(cleared[0]).toMatchObject({
      receivableCount: 2,
      clearedMinor: r1.amountMinor + r2.amountMinor,
      clearedBy: 'coverage_heal',
    });
    // Keyed on the FIRST cleared receivable — one of the two ids, never a per-wallet key.
    expect([`receivable_cleared:${r1.id}`, `receivable_cleared:${r2.id}`]).toContain(
      cleared[0]?.correlationId
    );
  });

  it('D8.1 — healCoveredHoldNow (booking_guard) heals the same wallet with the same rows, and a second heal on that wallet later gets a DIFFERENT correlationId', async () => {
    const now = new Date();
    const ctx = await seedCardlessWallet(4_000);

    const m1 = await bookCaseMeeting(ctx, minutesAfter(now, -90));
    const s1 = await openAdmittedSession(ctx, m1, 5);
    const r1 = await settleIntoReceivable(ctx, s1, m1, {
      billableMinutes: 20,
      now: minutesAfter(now, -60),
    });
    await coverWithoutClearing(ctx, r1.amountMinor, `cover_${r1.id}`);
    expect(await walletBalance(ctx.walletId)).toBe(0);
    expect((await receivableById(r1.id)).status).toBe('open');

    const firstHeal = await healCoveredHoldNow({
      walletId: ctx.walletId,
      trigger: 'booking_guard',
      now,
    });
    expect(firstHeal.healed).toBe(true);
    expect((await receivableById(r1.id)).status).toBe('cleared');
    const firstRows = await healRows(r1.id);
    expect(firstRows).toHaveLength(1);
    expect(firstRows[0]?.actorUserId).toBeNull();
    expect(publishesFor(DUNNING_EVENT, ctx.walletId)).toHaveLength(0);
    const afterFirst = publishesFor(RECEIVABLE_CLEARED_EVENT, ctx.walletId);
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]).toMatchObject({
      correlationId: `receivable_cleared:${r1.id}`,
      clearedBy: 'coverage_heal',
    });

    // Later: a new debt on the same wallet, covered again without a clear, healed again.
    const m2 = await bookCaseMeeting(ctx, minutesAfter(now, 5));
    const s2 = await openAdmittedSession(ctx, m2, 30);
    const r2 = await settleIntoReceivable(ctx, s2, m2, {
      billableMinutes: 20,
      now: minutesAfter(now, 30),
    });
    await coverWithoutClearing(ctx, r2.amountMinor, `cover_${r2.id}`);
    expect(await walletBalance(ctx.walletId)).toBe(0);

    const secondHeal = await healCoveredHoldNow({
      walletId: ctx.walletId,
      trigger: 'booking_guard',
      now: minutesAfter(now, 60),
    });
    expect(secondHeal.healed).toBe(true);
    expect((await receivableById(r2.id)).status).toBe('cleared');
    const secondRows = await healRows(r2.id);
    expect(secondRows).toHaveLength(1);
    expect(secondRows[0]?.actorUserId).toBeNull();

    const afterSecond = publishesFor(RECEIVABLE_CLEARED_EVENT, ctx.walletId);
    expect(afterSecond).toHaveLength(2);
    const [firstNotice, secondNotice] = afterSecond;
    expect(secondNotice?.correlationId).toBe(`receivable_cleared:${r2.id}`);
    expect(secondNotice?.correlationId).not.toBe(firstNotice?.correlationId);
  });
});

// ── The dunning claim race (plan §9 Concurrency, V4-F8 / D8.8) ────────────────

/**
 * Loaded through a VARIABLE specifier: a static deep import would pull `packages/db/src/**` into
 * `apps/api`'s `tsc --noEmit` program and break its `rootDir`. The module shares its `_setDb`
 * with `@balo/db` (whose `main` is raw TypeScript), so installing a client here re-points the
 * `db` binding `notify.ts` reads.
 */
const CONCURRENT_CLIENT_MODULE = '../../../../packages/db/src/test/concurrent-client';

/** Minimal structural view of a `postgres-js` client (the module arrives untyped). */
type RawSql = (<T>(strings: TemplateStringsArray, ...values: unknown[]) => Promise<T[]>) & {
  end(options?: { timeout?: number }): Promise<void>;
};

interface ConcurrentClientModule {
  _setDb: (next: unknown) => void;
  createConcurrentDb: (
    url: string,
    options?: Record<string, unknown>
  ) => { db: unknown; client: RawSql };
}

/** Poll budget for "is B blocked on A yet?" — 400 × 25ms = 10s, inside the 30s test timeout. */
const BLOCK_POLL_INTERVAL_MS = 25;
const BLOCK_POLL_ATTEMPTS = 400;

describe('the dunning claim race — a deterministic two-connection lock order (plan §9 Concurrency, V4-F8)', () => {
  let harness: ConcurrentClientModule;
  /** A — holds the wallet lock in an open transaction and stamps, like a racing sweep's claim. */
  let aDb: Database;
  let aClient: RawSql;
  let aPid: number;
  /** B — the connection `claimHoldDunningNotice` runs on (installed with `_setDb`). */
  let bDb: Database;
  let bClient: RawSql;
  let bPid: number;
  /** Warden — seeds, observes `pg_blocking_pids`, reads committed state, cleans up. */
  let wardenDb: Database;
  let wardenClient: RawSql;

  const seeded = {
    userIds: [] as string[],
    companyIds: [] as string[],
    expertProfileIds: [] as string[],
    walletIds: [] as string[],
    sessionIds: [] as string[],
    receivableIds: [] as string[],
  };
  const openHolds: Array<() => Promise<void>> = [];
  const inFlight: Array<Promise<unknown>> = [];

  function contend<T>(statement: Promise<T>): Promise<T> {
    inFlight.push(statement.catch(() => undefined));
    return statement;
  }

  async function backendPid(client: RawSql): Promise<number> {
    const [row] = await client<{ pid: number }>`select pg_backend_pid() as pid`;
    if (row === undefined) {
      throw new Error('pg_backend_pid() returned no row');
    }
    return row.pid;
  }

  /**
   * Block until Postgres reports `waiterPid` waiting on a lock held by `holderPid`. THIS CALL IS
   * THE DETERMINISM: exhausting the budget throws, so a race that failed to materialise fails
   * loudly instead of degrading into the sequential case.
   */
  async function waitUntilBlockedBy(waiterPid: number, holderPid: number): Promise<void> {
    for (let attempt = 0; attempt < BLOCK_POLL_ATTEMPTS; attempt += 1) {
      const [row] = await wardenClient<{ blockers: number[] }>`
        select coalesce(pg_blocking_pids(${waiterPid}::int), '{}'::int[]) as blockers
      `;
      if (row !== undefined && row.blockers.includes(holderPid)) {
        return;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, BLOCK_POLL_INTERVAL_MS);
      });
    }
    throw new Error(
      `backend ${String(waiterPid)} never blocked on backend ${String(holderPid)} within ` +
        `${String(BLOCK_POLL_ATTEMPTS * BLOCK_POLL_INTERVAL_MS)}ms — the claim did not wait on ` +
        'the wallet lock A holds.'
    );
  }

  /**
   * Run `work` inside a transaction on `target` and leave that transaction OPEN — holding every
   * lock it took — until `commit()` is called.
   */
  async function holdOpen<T>(
    target: Database,
    work: (tx: Parameters<Parameters<Database['transaction']>[0]>[0]) => Promise<T>
  ): Promise<{ result: T; commit: () => Promise<void> }> {
    let release: (() => void) | undefined;
    let settle: ((value: T) => void) | undefined;
    let fail: ((reason: unknown) => void) | undefined;
    const ready = new Promise<T>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    let txError: unknown;
    const txSettled = target
      .transaction(async (tx) => {
        const value = await work(tx);
        settle?.(value);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      })
      .catch((error: unknown) => {
        txError = error;
        fail?.(error);
      });
    const result = await ready;
    const commit = async (): Promise<void> => {
      release?.();
      await txSettled;
      if (txError !== undefined) {
        throw txError;
      }
    };
    openHolds.push(commit);
    return { result, commit };
  }

  /**
   * A COMMITTED held wallet: a company with a card-less wallet at −10,000, one failed presence
   * session, and its open receivable of 10,000 (never dunned). Raw inserts on the warden — the
   * harness-bound repositories cannot write rows the other two connections can see.
   */
  async function seedHeldWallet(
    endedAt: Date
  ): Promise<{ walletId: string; receivableId: string }> {
    const marker = randomUUID();
    const [member] = await wardenDb
      .insert(users)
      .values({
        workosId: `bal474_claim_member_${marker}`,
        email: `bal474-claim-member-${marker}@test.local`,
      })
      .returning({ id: users.id });
    const [expertUser] = await wardenDb
      .insert(users)
      .values({
        workosId: `bal474_claim_expert_${marker}`,
        email: `bal474-claim-expert-${marker}@test.local`,
      })
      .returning({ id: users.id });
    if (member === undefined || expertUser === undefined) {
      throw new Error('seed: user insert returned no row');
    }
    seeded.userIds.push(member.id, expertUser.id);

    const [company] = await wardenDb
      .insert(companies)
      .values({ name: `BAL-474 claim race ${marker}`, isPersonal: false })
      .returning({ id: companies.id });
    if (company === undefined) {
      throw new Error('seed: company insert returned no row');
    }
    seeded.companyIds.push(company.id);

    const [vertical] = await wardenDb
      .select({ id: verticals.id })
      .from(verticals)
      .where(eq(verticals.slug, 'salesforce'));
    if (vertical === undefined) {
      throw new Error('seed: the salesforce vertical seeded by global-setup is missing');
    }
    const [profile] = await wardenDb
      .insert(expertProfiles)
      .values({
        userId: expertUser.id,
        verticalId: vertical.id,
        type: 'freelancer',
        rateCents: EXPERT_HOURLY_MINOR,
      })
      .returning({ id: expertProfiles.id });
    if (profile === undefined) {
      throw new Error('seed: expert profile insert returned no row');
    }
    seeded.expertProfileIds.push(profile.id);

    const [wallet] = await wardenDb
      .insert(creditWallets)
      .values({ companyId: company.id, balanceMinor: -10_000 })
      .returning({ id: creditWallets.id });
    if (wallet === undefined) {
      throw new Error('seed: wallet insert returned no row');
    }
    seeded.walletIds.push(wallet.id);

    const [session] = await wardenDb
      .insert(creditSessions)
      .values({
        walletId: wallet.id,
        companyId: company.id,
        expertProfileId: profile.id,
        initiatingMemberId: member.id,
        status: 'ended',
        settlementStatus: 'failed',
        durationSource: 'presence',
        estimatedMinutes: FLOOR_MINUTES,
        expertRateMinorPerHour: EXPERT_HOURLY_MINOR,
        baloFeeBps: BALO_FEE_BPS,
        clientRateMinorPerMinute: PLAN_RATES.clientRateMinorPerMinute,
        expertRateMinorPerMinute: PLAN_RATES.expertRateMinorPerMinute,
        effectiveCeilingMinor: 15_000,
        overdraftSettledMinor: 10_000,
        endedAt,
      })
      .returning({ id: creditSessions.id });
    if (session === undefined) {
      throw new Error('seed: credit session insert returned no row');
    }
    seeded.sessionIds.push(session.id);

    const [receivable] = await wardenDb
      .insert(creditReceivables)
      .values({
        companyId: company.id,
        walletId: wallet.id,
        sessionId: session.id,
        amountMinor: 10_000,
        reason: 'settlement_declined',
      })
      .returning({ id: creditReceivables.id });
    if (receivable === undefined) {
      throw new Error('seed: receivable insert returned no row');
    }
    seeded.receivableIds.push(receivable.id);

    return { walletId: wallet.id, receivableId: receivable.id };
  }

  /**
   * Delete everything this block committed, in the one order the RESTRICT foreign keys permit.
   * It must not throw: a throw here strands the harness's own per-test transaction downstream.
   */
  async function deleteSeededRows(): Promise<void> {
    const receivableIds = seeded.receivableIds.splice(0);
    const sessionIds = seeded.sessionIds.splice(0);
    const walletIds = seeded.walletIds.splice(0);
    const expertProfileIds = seeded.expertProfileIds.splice(0);
    const companyIds = seeded.companyIds.splice(0);
    const userIds = seeded.userIds.splice(0);

    const auditScope = [
      receivableIds.length > 0 ? inArray(auditEvents.entityId, receivableIds) : undefined,
      sessionIds.length > 0 ? inArray(auditEvents.entityId, sessionIds) : undefined,
      walletIds.length > 0 ? inArray(auditEvents.entityId, walletIds) : undefined,
      userIds.length > 0 ? inArray(auditEvents.actorUserId, userIds) : undefined,
    ].filter((clause) => clause !== undefined);
    if (auditScope.length > 0) {
      await wardenDb.delete(auditEvents).where(or(...auditScope));
    }
    if (walletIds.length > 0) {
      await wardenDb
        .delete(creditReceivables)
        .where(inArray(creditReceivables.walletId, walletIds));
      await wardenDb.delete(creditLedger).where(inArray(creditLedger.walletId, walletIds));
    }
    if (sessionIds.length > 0) {
      await wardenDb.delete(creditSessions).where(inArray(creditSessions.id, sessionIds));
    }
    if (walletIds.length > 0) {
      await wardenDb.delete(creditWallets).where(inArray(creditWallets.id, walletIds));
    }
    if (expertProfileIds.length > 0) {
      await wardenDb.delete(expertProfiles).where(inArray(expertProfiles.id, expertProfileIds));
    }
    if (companyIds.length > 0) {
      await wardenDb.delete(companies).where(inArray(companies.id, companyIds));
    }
    if (userIds.length > 0) {
      await wardenDb.delete(users).where(inArray(users.id, userIds));
    }
  }

  beforeAll(async () => {
    const url = process.env.TEST_DATABASE_URL;
    if (url === undefined || url.length === 0) {
      throw new Error(
        'TEST_DATABASE_URL is not set. Integration tests must be run via "pnpm test:integration".'
      );
    }
    harness = (await import(CONCURRENT_CLIENT_MODULE)) as ConcurrentClientModule;
    const a = harness.createConcurrentDb(url, { max: 1 });
    const b = harness.createConcurrentDb(url, { max: 1 });
    const warden = harness.createConcurrentDb(url, { max: 1 });
    aDb = a.db as Database;
    aClient = a.client;
    bDb = b.db as Database;
    bClient = b.client;
    wardenDb = warden.db as Database;
    wardenClient = warden.client;
    aPid = await backendPid(aClient);
    bPid = await backendPid(bClient);
    // The premise of the whole block, asserted rather than assumed.
    expect(new Set([aPid, bPid]).size).toBe(2);
  });

  beforeEach(() => {
    // The harness's own beforeEach just bound `db` to its per-test transaction; the claim must
    // run on B, a real connection that can block on A.
    harness._setDb(bDb);
  });

  afterEach(async () => {
    for (const commit of openHolds.splice(0)) {
      await commit().catch(() => undefined);
    }
    await Promise.allSettled(inFlight.splice(0));
    await deleteSeededRows();
  });

  afterAll(async () => {
    await deleteSeededRows().catch(() => undefined);
    await Promise.all([
      aClient?.end({ timeout: 5 }),
      bClient?.end({ timeout: 5 }),
      wardenClient?.end({ timeout: 5 }),
    ]);
  });

  it('a daily claim that starts while another connection holds the wallet lock and stamps BLOCKS on that lock, then returns already_reminded once it commits', async () => {
    const now = new Date();
    const { walletId, receivableId } = await seedHeldWallet(minutesAfter(now, -60));

    // A: the wallet lock, then the daily stamp — held open, uncommitted. A's stamp is a MINUTE BEFORE
    // B's `now`, so the two instants differ and the final read can tell whose stamp survived.
    const stampedByA = minutesAfter(now, -1);
    const held = await holdOpen(aDb, async (tx) => {
      await acquireWalletLock(tx, walletId);
      return creditReceivablesRepository.stampDailyDunning(walletId, stampedByA, tx);
    });

    // B: the claim, issued and NOT awaited — it must be parked behind A before A commits.
    const claim = contend(claimHoldDunningNotice({ walletId, trigger: 'daily_reminder', now }));
    await waitUntilBlockedBy(bPid, aPid);

    await held.commit();
    const outcome = await claim;

    expect(outcome.kind).toBe('already_reminded');
    // B read A's committed stamp and wrote nothing of its own: the stamp is A's instant, not B's `now`.
    const [committed] = await wardenDb
      .select({ lastDunningAt: creditReceivables.lastDunningAt })
      .from(creditReceivables)
      .where(eq(creditReceivables.id, receivableId));
    expect(committed?.lastDunningAt?.getTime()).toBe(stampedByA.getTime());
    expect(committed?.lastDunningAt?.getTime()).not.toBe(now.getTime());
  });
});

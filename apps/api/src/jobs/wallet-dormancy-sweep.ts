import { Worker, type Job } from 'bullmq';
import { creditWalletsRepository, creditLedgerRepository, type CreditWallet } from '@balo/db';
import { DORMANCY_REMINDER_WINDOWS_DAYS } from '@balo/shared/pricing';
import { createLogger } from '@balo/shared/logging';
import { trackServer, CREDIT_SERVER_EVENTS } from '@balo/analytics/server';
import { createRedisConnection } from '../lib/redis.js';
import { getQueue } from '../lib/queue.js';
import { notificationEvents } from '../notifications/publisher.js';

/**
 * BAL-380 (ADR-1040 Lane 3) — the daily wallet dormancy sweep. ONE repeatable BullMQ job
 * doing TWO concerns each tick (D1):
 *
 *  1. Dormancy reminders — for each pre-expiry band in `DORMANCY_REMINDER_WINDOWS_DAYS`
 *     (60d + 30d), match wallets whose ABSOLUTE rolling `expires_at` sits in that band's
 *     1-day window (`(now+(w-1)d, now+w d]`, D2) with a positive balance, and publish a
 *     warm, non-countdown `credit.dormancy_reminder` to the company's billing admins. The
 *     cron cadence equals the band width, so a wallet crosses each band on ~one tick.
 *
 *  2. Expiry — match wallets whose `expires_at <= now` with a positive balance and post
 *     the guarded, locked, idempotent expiry entry via `expireDormantBalance`. The expiry
 *     sweep (NOT a separate `expires_at<=now` reminder window) emits the "balance expired"
 *     notice (D4), keyed on the ledger idempotency key, so one entry ⇒ one notice.
 *
 * IDEMPOTENCY: reminders ride a deterministic correlationId
 * `${walletId}:dormancy_reminder:${window}:${expiresAtDate}` (D3) — retries within a tick
 * dedup via the BullMQ jobId, and a new dormancy cycle a year later (activity rolled
 * `expires_at`) re-reminds because `expiresAtDate` changed. Expiry is idempotent in the
 * DB primitive: once expired the balance is 0, so the wallet drops out of the eligibility
 * query forever; a replay returns `already_expired` (notice re-published idempotently, NO
 * analytics double-count). Per-row try/catch — one bad wallet never aborts the batch.
 *
 * No money moves in the reminder pass (read-only + publish), so it takes no lock; the
 * captured `balanceMinor`/`expiresAt` are as-of the sweep (payload precedent). All wallet
 * lock/ledger logic lives in `@balo/db` — this job stays thin.
 */
export const WALLET_DORMANCY_SWEEP_QUEUE = 'wallet-dormancy-sweep';
export const WALLET_DORMANCY_SWEEP_CRON = '0 3 * * *'; // daily 03:00 UTC

const DAY_MS = 24 * 60 * 60 * 1000;

// Structured logger for Axiom visibility of this money-adjacent daily job (it posts
// expiry ledger entries). Named `logger` to avoid colliding with the `log` message
// callback that forwards to BullMQ's job-UI log. Both are used: `job.log` for the BullMQ
// job UI, `logger` for Axiom.
const logger = createLogger('wallet-dormancy-sweep');

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Publish ONE dormancy reminder for a (wallet, band) and emit `_sent`. Throws on failure
 * so the caller's per-row try/catch isolates it. `balanceMinor`/`expiresAt` are carried
 * in the payload (display facts captured at sweep time — the engine does not re-hydrate).
 */
async function publishDormancyReminder(
  wallet: CreditWallet,
  expiresAt: Date,
  band: 60 | 30
): Promise<void> {
  const expiresAtDate = expiresAt.toISOString().slice(0, 10);
  await notificationEvents.publish('credit.dormancy_reminder', {
    correlationId: `${wallet.id}:dormancy_reminder:${band}:${expiresAtDate}`,
    walletId: wallet.id,
    companyId: wallet.companyId,
    window: band, // 60 | 30 → copy + analytics
    balanceMinor: wallet.balanceMinor,
    expiresAt: expiresAt.toISOString(),
  });
  trackServer(CREDIT_SERVER_EVENTS.DORMANCY_REMINDER_SENT, {
    window: band,
    company_id: wallet.companyId,
    wallet_id: wallet.id,
    distinct_id: wallet.companyId, // the company is the natural subject
  });
}

/**
 * Expire ONE wallet (guarded, locked, idempotent in `@balo/db`) and publish the "expired"
 * notice on `expired | already_expired` (idempotent by the ledger correlationId). Analytics
 * fires ONLY on `expired` — the real money event; `already_expired` is a replay and must
 * never double-count. Returns `true` iff this wallet actually expired this tick. Throws on
 * failure so the caller's per-row try/catch isolates it.
 */
async function expireAndNotify(walletId: string, now: Date): Promise<boolean> {
  const result = await creditLedgerRepository.expireDormantBalance({ walletId, now });

  if (result.outcome === 'expired' || result.outcome === 'already_expired') {
    await notificationEvents.publish('credit.balance_expired', {
      correlationId: result.entry.idempotencyKey, // = dormancy_expiry:${walletId}:${asOf}
      walletId,
      companyId: result.companyId,
      expiresAt: result.expiresAt.toISOString(),
      expiredMinor: result.entry.amountMinor < 0 ? -result.entry.amountMinor : 0,
    });
  }

  if (result.outcome === 'expired') {
    trackServer(CREDIT_SERVER_EVENTS.BALANCE_EXPIRED, {
      expired_minor: result.expiredMinor,
      company_id: result.companyId,
      wallet_id: walletId,
      distinct_id: result.companyId,
    });
    return true;
  }
  return false;
}

/** The 60d + 30d reminder pass. Returns the count of successful publishes. */
async function runReminderPass(now: Date, log: (message: string) => void): Promise<number> {
  let reminders = 0;
  for (const band of DORMANCY_REMINDER_WINDOWS_DAYS) {
    const until = new Date(now.getTime() + band * DAY_MS); //  expires_at <= now + band days
    const after = new Date(now.getTime() + (band - 1) * DAY_MS); // > now + (band-1) days (1-day band)
    const wallets = await creditWalletsRepository.findWalletsExpiringBetween(after, until);
    for (const wallet of wallets) {
      const { expiresAt } = wallet;
      if (expiresAt === null) continue; // defensive — the query already excludes NULL expiries
      try {
        await publishDormancyReminder(wallet, expiresAt, band);
        reminders += 1;
      } catch (error) {
        const message = errorMessage(error);
        log(`dormancy reminder (${band}d) failed for wallet ${wallet.id}: ${message}`);
        logger.error({ walletId: wallet.id, band, error: message }, 'Dormancy reminder failed');
      }
    }
  }
  return reminders;
}

/** The expiry pass. Returns the count of wallets actually expired this tick. */
async function runExpiryPass(now: Date, log: (message: string) => void): Promise<number> {
  let expired = 0;
  const wallets = await creditWalletsRepository.findExpirableWallets(now);
  for (const wallet of wallets) {
    try {
      if (await expireAndNotify(wallet.id, now)) expired += 1;
    } catch (error) {
      const message = errorMessage(error);
      log(`dormancy expiry failed for wallet ${wallet.id}: ${message}`);
      logger.error({ walletId: wallet.id, error: message }, 'Dormancy expiry failed');
    }
  }
  return expired;
}

/**
 * The sweep body (exported for unit testing without a Redis-backed Worker). Runs the
 * reminder pass then the expiry pass; each row is isolated in its own try/catch. Returns
 * the counts for the summary log.
 */
export async function runWalletDormancySweep(
  now: Date,
  log: (message: string) => void = () => {}
): Promise<{ reminders: number; expired: number }> {
  const reminders = await runReminderPass(now, log);
  const expired = await runExpiryPass(now, log);
  logger.info({ reminders, expired }, 'Wallet dormancy sweep complete');
  return { reminders, expired };
}

/** Start the wallet-dormancy sweep worker. */
export function startWalletDormancySweepWorker(): Worker {
  return new Worker(
    WALLET_DORMANCY_SWEEP_QUEUE,
    async (job: Job) => {
      const { reminders, expired } = await runWalletDormancySweep(new Date(), (m) => job.log(m));
      job.log(
        `wallet dormancy sweep: ${reminders} reminders published, ${expired} balances expired`
      );
    },
    {
      connection: createRedisConnection(),
      concurrency: 1,
    }
  );
}

/** Register the repeatable wallet-dormancy sweep (daily 03:00 UTC). */
export async function registerWalletDormancySweepCron(): Promise<void> {
  const queue = getQueue(WALLET_DORMANCY_SWEEP_QUEUE);
  await queue.add(
    'sweep',
    {},
    {
      repeat: { pattern: WALLET_DORMANCY_SWEEP_CRON },
      removeOnComplete: true,
    }
  );
}

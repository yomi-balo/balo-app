import { Worker, type Job } from 'bullmq';
import { adminAlertsRepository, adminSweepTicksRepository } from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import {
  ADMIN_ALERT_KINDS,
  ADMIN_ALERT_STORM_THRESHOLD,
  ADMIN_ALERT_STORM_SAMPLE_LIMIT,
  ADMIN_ALERT_FINDER_BATCH_LIMIT,
  ADMIN_ALERT_SWEEP_SENTINEL_ENTITY_ID,
  ADMIN_ALERT_CADENCES,
  adminAlertKindsForCadence,
  stormKindFor,
  type AdminAlertCadence,
  type AdminAlertDetail,
  type AdminAlertKind,
} from '@balo/shared/admin-alerts';
import { createRedisConnection } from '../lib/redis.js';
import { getQueue } from '../lib/queue.js';
import { ADMIN_ALERT_FINDERS } from './admin-alert-finders.js';

/**
 * BAL-548 / ADR-1055 — the pending-actions queue sweep. THREE repeatable jobs, one per cadence
 * (1m / 5m / 15m), on ONE queue. Per finder kind for that cadence:
 * `adminAlertsRepository.reconcileKind` does the WHOLE per-kind reconcile in one transaction —
 * this module never re-implements insert/bump/resolve.
 *
 * ⚠ THE CADENCE IS THE ROW'S CLOSE LATENCY, rendered on Home as "swept Ns ago" — not a free
 * knob. Slowing 1m widens the window a money problem sits unseen.
 */
export const ADMIN_ALERT_SWEEP_QUEUE = 'admin-alert-sweep';

export const ADMIN_ALERT_SWEEP_CRONS: Readonly<Record<AdminAlertCadence, string>> = {
  '1m': '* * * * *',
  '5m': '*/5 * * * *',
  '15m': '*/15 * * * *',
};

/**
 * 🚩 STATIC LITERAL job names — rulings addendum §A3, verified against all fourteen existing
 * repeatable registrations in `apps/api/src/jobs/` (not one passes a `jobId`). `buildJobId`
 * exists for DYNAMICALLY constructed ids (a correlationId, an entity id); a repeatable has no
 * dynamic part to escape, and passing a custom `jobId` to a repeatable is the wedging risk the
 * plan flagged for no reason to take. The pattern IS the identity — same shape as
 * `review-nudge-sweep.ts:356` and all thirteen of its siblings.
 */
export const ADMIN_ALERT_SWEEP_JOB_NAMES: Readonly<Record<AdminAlertCadence, string>> = {
  '1m': 'sweep-1m',
  '5m': 'sweep-5m',
  '15m': 'sweep-15m',
};

const logger = createLogger('admin-alert-sweep');

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorClassName(error: unknown): string {
  return error instanceof Error ? error.constructor.name : 'Unknown';
}

export interface AdminAlertSweepTickResult {
  readonly cadence: AdminAlertCadence;
  readonly kinds: number;
  readonly inserted: number;
  readonly bumped: number;
  readonly resolved: number;
  readonly stormed: number;
  readonly failures: number;
}

interface BatchFilledEntry {
  readonly kind: string;
  readonly limit: number;
}

interface FinderFailureEntry {
  readonly kind: string;
  readonly errorClass: string;
  readonly message: string;
}

/**
 * `sweep.failed`'s evidence snapshot — a description of the SWEEP itself, not of any one
 * entity. Written once, on the sentinel, when one or more finders threw this tick.
 */
function buildSweepFailedDetail(
  cadence: AdminAlertCadence,
  failures: readonly FinderFailureEntry[]
): AdminAlertDetail {
  const kindList = failures.map((f) => f.kind).join(', ');
  return {
    title: 'The pending-actions sweep could not run every check',
    entityLabel: `${cadence} sweep`,
    evidence: `${failures.length} finder(s) threw this tick and were NOT reconciled (no inserts, no closes): ${kindList}.`,
    facts: failures.map((f) => [f.kind, f.errorClass] as const),
  };
}

/** One kind's tally, folded into the tick's running totals. */
interface KindTally {
  readonly inserted: number;
  readonly bumped: number;
  readonly resolved: number;
  readonly stormed: boolean;
}

/**
 * ONE finder kind, resolved and reconciled — or `skipped`. THROWS on any failure (a missing
 * finder implementation, the finder itself, or `reconcileKind`); the caller's per-kind
 * try/catch is what makes one bad kind never abort the tick.
 *
 * ⚠ A missing `ADMIN_ALERT_FINDERS` implementation is a THROW, never a skip — the XOR
 * invariant (`packages/db/src/invariants/admin-alert-kinds-have-exactly-one-writer.test.ts`)
 * makes this unreachable, and a throw is how it stays that way.
 */
async function reconcileOneKind(
  kind: AdminAlertKind,
  now: Date
): Promise<{ tally: KindTally; batchFilled: boolean } | { skipped: true }> {
  const finderName = ADMIN_ALERT_KINDS[kind].finder;
  if (finderName === null) {
    // Unreachable given `adminAlertKindsForCadence` only returns finder kinds, and the XOR
    // invariant (`finder === null` iff `cadence === null`) makes this combination impossible.
    throw new Error(`admin-alert-sweep: "${kind}" has no finder — it must not be swept`);
  }
  const finder = ADMIN_ALERT_FINDERS[finderName];
  if (finder === undefined) {
    // The XOR invariant makes this unreachable too (ADMIN_ALERT_FINDERS' keys are asserted
    // equal to the registry's finder names) — a throw is how it stays that way.
    throw new Error(
      `admin-alert-sweep: no finder implementation named "${finderName}" for kind "${kind}"`
    );
  }

  const outcome = await finder({ now, limit: ADMIN_ALERT_FINDER_BATCH_LIMIT });

  if (outcome.skipped !== undefined) {
    // NO reconcile at all — no insert, no bump, and crucially NO RESOLVE. Resolving on a skip
    // would mass-close every open row for a feature that was deliberately turned off.
    logger.warn({ kind, reason: outcome.skipped }, 'admin_alert_sweep_kind_skipped');
    return { skipped: true };
  }

  const result = await adminAlertsRepository.reconcileKind({
    kind,
    found: outcome.findings,
    stormThreshold: ADMIN_ALERT_STORM_THRESHOLD,
    stormSampleLimit: ADMIN_ALERT_STORM_SAMPLE_LIMIT,
    stormKind: stormKindFor(kind),
    sentinelEntityId: ADMIN_ALERT_SWEEP_SENTINEL_ENTITY_ID,
    now,
    // A-F2 — a saturated finder batch means `outcome.findings` is a PARTIAL truth; the
    // repository short-circuits its resolve arm on this flag rather than mass-closing
    // whatever fell outside the cap.
    batchFilled: outcome.batchFilled,
  });

  return {
    tally: {
      inserted: result.inserted,
      bumped: result.bumped,
      resolved: result.resolved,
      stormed: result.stormed,
    },
    batchFilled: outcome.batchFilled,
  };
}

/** ONE `logger.warn`, iff at least one kind's batch filled this tick — never per-kind. */
function emitBatchFilledWarning(cadence: AdminAlertCadence, batchFilled: BatchFilledEntry[]): void {
  if (batchFilled.length === 0) {
    return;
  }
  logger.warn(
    { cadence, arms: batchFilled },
    'admin_alert_sweep_batch_filled — NO SILENT CAPS. A full batch means entities were DROPPED from this tick.'
  );
}

/**
 * ONE `logger.error` plus ONE best-effort `sweep.failed` raise, iff at least one finder threw
 * this tick — never per-kind (the `credit-session-meter-sweep.ts:429-449` lesson).
 */
async function emitFinderFailures(
  cadence: AdminAlertCadence,
  failures: FinderFailureEntry[]
): Promise<void> {
  if (failures.length === 0) {
    return;
  }
  logger.error(
    { cadence, count: failures.length, failures },
    'admin_alert_sweep_finder_failed — one or more finders threw; the affected kinds were NOT reconciled this tick (no inserts, no closes)'
  );
  try {
    await adminAlertsRepository.raise({
      kind: 'sweep.failed',
      entityType: 'sweep',
      entityId: ADMIN_ALERT_SWEEP_SENTINEL_ENTITY_ID,
      detail: buildSweepFailedDetail(cadence, failures),
    });
  } catch (raiseError) {
    // ⚠ An alarm about the sweep must never itself fail the sweep.
    logger.error(
      { cadence, error: errorMessage(raiseError) },
      'admin_alert_sweep_failed_to_raise_sweep_failed'
    );
  }
}

/** The heartbeat, ALWAYS — even after finder failures, since a tick that ran and partly
 *  failed DID sweep; suppressing this would make the page claim the sweep is dead when it is not. */
async function markTickSafely(cadence: AdminAlertCadence, now: Date): Promise<void> {
  try {
    await adminSweepTicksRepository.markTick(cadence, now);
  } catch (tickError) {
    logger.error(
      { cadence, error: errorMessage(tickError) },
      'admin_alert_sweep_failed_to_mark_tick'
    );
  }
}

/**
 * THE SWEEP BODY — exported for unit testing without a Redis-backed Worker (house docblock
 * sentence). Per kind, ISOLATED (a try/catch per kind — one bad finder never aborts the tick),
 * {@link reconcileOneKind} resolves the finder, calls it, and reconciles; failures accumulate
 * and are reported ONCE per tick by {@link emitBatchFilledWarning} and
 * {@link emitFinderFailures}. {@link markTickSafely} stamps the heartbeat ALWAYS, even after
 * failures.
 */
export async function runAdminAlertSweep(
  cadence: AdminAlertCadence,
  now: Date,
  jobLog: (message: string) => void = () => {}
): Promise<AdminAlertSweepTickResult> {
  const kinds = adminAlertKindsForCadence(cadence);

  let inserted = 0;
  let bumped = 0;
  let resolved = 0;
  let stormed = 0;
  const batchFilled: BatchFilledEntry[] = [];
  const failures: FinderFailureEntry[] = [];

  for (const kind of kinds) {
    try {
      const outcome = await reconcileOneKind(kind, now);
      if ('skipped' in outcome) {
        continue;
      }
      if (outcome.batchFilled) {
        batchFilled.push({ kind, limit: ADMIN_ALERT_FINDER_BATCH_LIMIT });
      }
      inserted += outcome.tally.inserted;
      bumped += outcome.tally.bumped;
      resolved += outcome.tally.resolved;
      if (outcome.tally.stormed) stormed += 1;
    } catch (error) {
      failures.push({ kind, errorClass: errorClassName(error), message: errorMessage(error) });
    }
  }

  emitBatchFilledWarning(cadence, batchFilled);
  await emitFinderFailures(cadence, failures);
  await markTickSafely(cadence, now);

  logger.info(
    {
      cadence,
      kinds: kinds.length,
      inserted,
      bumped,
      resolved,
      stormed,
      failures: failures.length,
    },
    'Admin alert sweep complete'
  );
  jobLog(
    `admin alert sweep (${cadence}): ${kinds.length} kind(s), ${inserted} inserted, ${bumped} bumped, ${resolved} resolved, ${stormed} stormed, ${failures.length} failed`
  );

  return {
    cadence,
    kinds: kinds.length,
    inserted,
    bumped,
    resolved,
    stormed,
    failures: failures.length,
  };
}

/** `concurrency: 1` — house precedent; every job in `jobs/` is serial. */
export function startAdminAlertSweepWorker(): Worker {
  return new Worker(
    ADMIN_ALERT_SWEEP_QUEUE,
    async (job: Job) => {
      const { cadence } = job.data as { cadence: AdminAlertCadence };
      await runAdminAlertSweep(cadence, new Date(), (m) => job.log(m));
    },
    { connection: createRedisConnection(), concurrency: 1 }
  );
}

export async function registerAdminAlertSweepCron(): Promise<void> {
  const queue = getQueue(ADMIN_ALERT_SWEEP_QUEUE);
  for (const cadence of ADMIN_ALERT_CADENCES) {
    await queue.add(
      ADMIN_ALERT_SWEEP_JOB_NAMES[cadence],
      { cadence },
      { repeat: { pattern: ADMIN_ALERT_SWEEP_CRONS[cadence] }, removeOnComplete: true }
    );
  }
}

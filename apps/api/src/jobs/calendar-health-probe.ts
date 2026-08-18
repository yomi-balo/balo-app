import { Worker, type Job } from 'bullmq';
import type { FastifyBaseLogger } from 'fastify';
import { calendarRepository, type CalendarConnection } from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import {
  trackServer,
  CALENDAR_SERVER_EVENTS,
  toCalendarEventProvider,
} from '@balo/analytics/server';
import { createRedisConnection } from '../lib/redis.js';
import { getQueue } from '../lib/queue.js';
import {
  ApirocError,
  callApiroc,
  classifyCredentialFailure,
  getApirocClient,
} from '../lib/apiroc/index.js';
import { provisionConnection } from '../services/calendar/apiroc-connection.js';
import { applyCredentialFailure } from '../services/calendar/credential-status.js';
import {
  enqueueAvailabilityCacheRebuild,
  STALENESS_CHECK_THRESHOLD_MS,
} from './availability-cache.js';

const log = createLogger('calendar-health-probe');

/**
 * BAL-396 §9/§10.5 — THE PLATFORM'S ONLY PROACTIVE CALENDAR-BREAKAGE SIGNAL.
 *
 * Every other Apiroc call site is REACTIVE — it discovers a broken credential only when a
 * booking or a sync happens to touch it. This sweep is the only thing that finds a dead
 * credential BEFORE a client ever hits it, which is the ticket's named mandatory property:
 * a connection whose `calendars.list` fails ends the tick `EXPIRED`, notified, with ZERO
 * calls to `isWindowAvailableForExpert`.
 *
 * ⚠⚠ A CHEAP DATA CALL, NEVER `endUserAccounts.get()`. Status polling PROVABLY cannot detect
 * a revoke: the vendor's own status stays `ACTIVE` with both tokens present immediately after
 * a revoke, and only flips once a data call has already failed (apiroc skill, Constraint 10,
 * [live]). `calendars.list(..., { pageSize: 1 })` is the cheapest real data call there is.
 *
 * ⚠ SERIAL, BATCH-BOUNDED, ONE TICK AT A TIME — house precedent, every job in `jobs/` is
 * `concurrency: 1` with a serial `for` (`meeting-lifecycle-sweep.ts`). At most ONE Apiroc
 * request is ever in flight, so peak load is a Balo-set constant independent of expert count;
 * growth stretches COVERAGE (whether every live connection is proven within its interval),
 * not burst. A filled batch WARNS rather than silently capping.
 *
 * ⚠⚠ THE MASS-FAILURE CIRCUIT BREAKER IS THE POINT OF THIS FILE. A platform-key fault or a
 * vendor-wide outage can produce marker-bearing 401/403s for EVERY connection in one tick —
 * and misclassifying "the integration is down" as "every expert must reconnect" would email
 * every connected expert at once, unrecoverably (no un-send exists). So every credential
 * STATUS write and notification is computed WITHOUT WRITING ANYTHING in the classification
 * loop, and only AFTER the whole batch is classified does this decide: if the
 * reconnect-required share crosses the breaker, NO reconnect-required verdict is flipped and
 * NOBODY is notified — only a loud `apiroc_probe_mass_failure_suspected` log.
 * `applyCredentialFailure` — the ONE place a credential is marked broken
 * (`services/calendar/credential-status.ts`) — is still called for EVERY classified failure
 * either way, breaker tripped or not: its non-reconnect branches (`platform_auth_failure` /
 * `transient` / `other`) never flip status or notify regardless, so routing them through it
 * is always safe and is what keeps that marker reachable during exactly the mass-key-fault
 * scenario the breaker exists to catch.
 *
 * ⚠ NO PROVIDER LITERAL IN THIS FILE. `jobs/` is inside Scan B
 * (`invariants/sync-token-parity.test.ts`) — the `'google' | 'microsoft'` narrowing needed
 * for analytics payloads goes through `toCalendarEventProvider` (`@balo/analytics/server`),
 * never a local branch on `provider`.
 */
export const CALENDAR_HEALTH_PROBE_QUEUE = 'calendar-health-probe';
export const CALENDAR_HEALTH_PROBE_CRON = '*/15 * * * *'; // every 15 minutes

/**
 * Probe a connection at most this often.
 *
 * ⚠⚠ round-2 fix #8 — COUPLED, BY REQUIREMENT, TO `availability-cache.ts`'s
 * `STALENESS_CHECK_THRESHOLD_MS`. See that constant's docblock for the full failure mode:
 * lowering this value to or below the staleness threshold silently re-arms a permanent-no-op
 * bug in a DIFFERENT file, with no type, lint, or test failure anywhere else. The assertion
 * below turns that silent coupling into a loud one — it throws at MODULE LOAD (import time,
 * every process start and every test file that imports this module), not at some later
 * runtime path that might never execute.
 */
export const PROBE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

if (PROBE_INTERVAL_MS <= STALENESS_CHECK_THRESHOLD_MS) {
  throw new Error(
    `calendar-health-probe: PROBE_INTERVAL_MS (${PROBE_INTERVAL_MS}ms) must stay strictly ` +
      `greater than availability-cache's STALENESS_CHECK_THRESHOLD_MS ` +
      `(${STALENESS_CHECK_THRESHOLD_MS}ms) — otherwise findStaleConnections silently returns ` +
      `[] forever. See both constants' docblocks (BAL-396 round-2 fix #8).`
  );
}

/** ⚠ THE CALLER MUST WARN WHEN THIS FILLS — the no-silent-caps rule (precedent:
 *  MEETING_LIFECYCLE_BATCH_LIMIT, jobs/meeting-lifecycle-sweep.ts). */
export const CALENDAR_HEALTH_PROBE_BATCH_LIMIT = 100;

/** ⚠ THE MASS-MISCLASSIFICATION BREAKER — see the file docblock. */
const MASS_FAILURE_MIN_SAMPLE = 5;
const MASS_FAILURE_RATIO = 0.5;

/**
 * ⚠⚠ round-2 fix #7 — the ratio breaker is DISABLED on a small fleet by construction:
 * `Math.max(5, 0.5 * candidates.length)` never drops below 5, so a rotated platform API key
 * that only breaks 4 due connections (`4 >= 5` false) sails straight through and flips every
 * one of them EXPIRED, cache-cleared, and emailed — for a fault that is entirely Balo's, with
 * no un-send. A batch where EVERY candidate ends up reconnect-required is independently
 * suspicious once there is more than one connection free to disagree: real, INDEPENDENT
 * revokes landing on every connection due in the same 15-minute probe window is implausible.
 * A single-connection batch is deliberately excluded from this check — one expert revoking
 * access is an ordinary, expected event and must still flip normally, every tick.
 */
const MASS_FAILURE_UNIFORM_MIN_SAMPLE = 2;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A `FastifyBaseLogger`-shaped adapter over the scoped Pino logger, so this sweep can call
 * `enqueueAvailabilityCacheRebuild` (a route/service helper typed against Fastify's logger)
 * without a Fastify request in hand. Only `.error` is ever invoked by that helper.
 */
const enqueueLogger = log as unknown as FastifyBaseLogger;

/** One connection whose data call failed with a classified `ApirocError`, DEFERRED — not yet
 *  written anywhere. See the mass-failure breaker in the file docblock. */
interface DeferredFailure {
  readonly connection: CalendarConnection;
  readonly err: ApirocError;
  readonly reconnectRequired: boolean;
}

/**
 * The probe call for ONE connection, plus the heal path when it succeeds. Throws the raw
 * `ApirocError` on a failed data call — the caller classifies and defers the write.
 *
 * ⚠ NO NULL GUARD ON `endUserAccountId` — removed in the BAL-396 fix round. Migration 0069
 * made the column `NOT NULL`, so every candidate `listConnectionsDueForHealthCheck` can
 * return already carries a pointer.
 */
async function probeAndHeal(connection: CalendarConnection, now: Date): Promise<boolean> {
  const { endUserAccountId } = connection;

  await callApiroc('calendars.list', () =>
    getApirocClient().calendars.list(endUserAccountId, { pageSize: 1 })
  );
  await calendarRepository.markCredentialChecked(connection.id, now);

  // ⚠⚠ BAL-396 FIX ROUND — RE-PROVISION AN "ACTIVE BUT UNREADABLE" CONNECTION TOO, NOT ONLY
  // A `SYNC_PENDING` ONE. `provisionConnection` can persist `ACTIVE` with ZERO sub-calendar
  // rows if a past `calendars.list` succeeded with no writable calendars — before this fix
  // round it did; see that function's docblock. That is a PERMANENTLY-UNBOOKABLE absorbing
  // state: `listBusyReadTargets` reports `provisioned: false`, the booking gate fails CLOSED
  // forever, and nothing else in this file would ever touch a connection whose STATUS reads
  // ACTIVE. Checking sub-calendar presence here is what closes that gap.
  const wasSyncPending = connection.credentialStatus === 'SYNC_PENDING';
  const needsReprovision =
    wasSyncPending ||
    (connection.credentialStatus === 'ACTIVE' &&
      (await calendarRepository.findSubCalendarsByConnectionId(connection.id)).length === 0);

  if (needsReprovision) {
    const status = await provisionConnection(connection);
    if (status === 'SYNC_PENDING') {
      // `provisionConnection`'s own re-list failed again, or still found zero writable
      // calendars — nothing more to do this tick; the next one retries.
      return false;
    }
    // `provisionConnection` already wrote `ACTIVE` (and, via `setCredentialStatusForProvider`,
    // already cleared `reconnectNotifiedAt` — do NOT clear it again here).
    await enqueueAvailabilityCacheRebuild(connection.expertProfileId, enqueueLogger);
    // ⚠⚠ round-2 fix #12 — `SYNC_PENDING_AUTO_RESOLVED` must mean what its name says. Before
    // this fix it fired for BOTH branches of `needsReprovision`, including the ACTIVE-with-
    // zero-sub-calendars branch above, which was never `SYNC_PENDING` at all — the metric no
    // longer meant what it claimed. Gate the event on the connection actually HAVING BEEN
    // `SYNC_PENDING`; the other (never-`SYNC_PENDING`, healed-in-place) case gets its own,
    // honestly-named log line instead of a metric that would misrepresent it.
    if (wasSyncPending) {
      trackServer(CALENDAR_SERVER_EVENTS.SYNC_PENDING_AUTO_RESOLVED, {
        distinct_id: connection.expertProfileId,
      });
    } else {
      log.info(
        { connectionId: connection.id, expertProfileId: connection.expertProfileId },
        'apiroc_active_zero_calendars_healed'
      );
    }
    return true;
  }

  if (connection.credentialStatus === 'ACTIVE') {
    // Already healthy and already provisioned — nothing to heal.
    return false;
  }

  // EXPIRED / REVOKED, and the probe's data call just succeeded — reconnected out of band.
  // `setCredentialStatus` ALREADY clears `reconnectNotifiedAt` when the new status is
  // `'ACTIVE'` — no separate clear call.
  await calendarRepository.setCredentialStatus(connection.id, 'ACTIVE');
  await enqueueAvailabilityCacheRebuild(connection.expertProfileId, enqueueLogger);
  const eventProvider = toCalendarEventProvider(connection.provider);
  if (eventProvider) {
    trackServer(CALENDAR_SERVER_EVENTS.RECONNECT_RESOLVED, {
      provider: eventProvider,
      distinct_id: connection.expertProfileId,
    });
  }
  return true;
}

/**
 * Probe ONE candidate connection and classify the outcome — extracted from the sweep loop
 * purely to keep `runCalendarHealthProbe`'s cognitive complexity down; behaviour is unchanged.
 *
 * ⚠ EVERY CLASSIFIED-FAILURE STATUS/NOTIFY VERDICT IS DEFERRED — this never writes credential
 * STATUS itself; it only classifies and returns a `DeferredFailure` for the caller to apply
 * (or not) after the whole batch is seen. See the mass-failure breaker in the file docblock.
 *
 * ⚠⚠ BAL-396 FIX ROUND — STAMP THE ATTEMPT NOW, NOT DEFERRED, on a classified failure. This is
 * the probe's SCAN KEY (`markCredentialChecked`'s docblock), never a credential STATUS write,
 * so it is outside the mass-failure breaker's deferred-write discipline. Skipping this on
 * failure is exactly how a permanently-dead connection sorted FIRST in
 * `listConnectionsDueForHealthCheck` FOREVER and starved every healthy connection out of the
 * batch.
 */
async function probeCandidate(
  connection: CalendarConnection,
  now: Date,
  jobLog: (message: string) => void
): Promise<{ recovered: boolean; deferredFailure?: DeferredFailure }> {
  try {
    const recovered = await probeAndHeal(connection, now);
    return { recovered };
  } catch (err: unknown) {
    const message = errorMessage(err);
    jobLog(`calendar health probe failed for connection ${connection.id}: ${message}`);
    if (!(err instanceof ApirocError)) {
      // Not a classified vendor failure (e.g. the guard above, or a re-thrown programmer
      // error) — log loudly and leave the connection alone; the next tick retries.
      log.error(
        {
          connectionId: connection.id,
          expertProfileId: connection.expertProfileId,
          error: message,
        },
        'apiroc_health_probe_unexpected_error'
      );
      return { recovered: false };
    }
    await calendarRepository.markCredentialChecked(connection.id, now);
    const verdict = classifyCredentialFailure(err);
    return {
      recovered: false,
      deferredFailure: {
        connection,
        err,
        reconnectRequired: verdict.kind === 'reconnect_required',
      },
    };
  }
}

/** Verdict of the mass-failure breaker over one batch's deferred failures — see the file
 *  docblock and `MASS_FAILURE_UNIFORM_MIN_SAMPLE`'s docblock for the two independent checks
 *  this combines. Extracted from the sweep body purely to keep its cognitive complexity down;
 *  behaviour is unchanged. */
interface MassFailureVerdict {
  reconnectRequired: DeferredFailure[];
  massFailureThreshold: number;
  massFailureSuspected: boolean;
}

function evaluateMassFailure(
  candidateCount: number,
  deferredFailures: readonly DeferredFailure[]
): MassFailureVerdict {
  const reconnectRequired = deferredFailures.filter((f) => f.reconnectRequired);
  const massFailureThreshold = Math.max(
    MASS_FAILURE_MIN_SAMPLE,
    MASS_FAILURE_RATIO * candidateCount
  );
  // round-2 fix #7 — the ratio check alone is blind on a small fleet (see the constant's
  // docblock); a uniformly-failing batch trips the breaker independently of sample size.
  const uniformFailure =
    candidateCount >= MASS_FAILURE_UNIFORM_MIN_SAMPLE &&
    reconnectRequired.length === candidateCount;
  const massFailureSuspected = reconnectRequired.length >= massFailureThreshold || uniformFailure;
  return { reconnectRequired, massFailureThreshold, massFailureSuspected };
}

/**
 * Breaker TRIPPED — flip nothing, notify nobody for reconnect-required verdicts; only the
 * non-reconnect verdicts (which never flip status or notify regardless) still route through
 * `applyCredentialFailure`. See the file docblock.
 */
async function applyDeferredFailuresBreakerTripped(
  deferredFailures: readonly DeferredFailure[],
  candidateCount: number,
  reconnectRequiredCount: number,
  massFailureThreshold: number,
  result: CalendarHealthProbeResult
): Promise<void> {
  // ⚠⚠ FLIP NOTHING, NOTIFY NOBODY — RECONNECT-REQUIRED VERDICTS ONLY. See the file
  // docblock. A `platform_auth_failure` / `transient` / `other` verdict never flips
  // credential status or notifies anyone regardless of the breaker
  // (`applyCredentialFailure`'s non-reconnect branches only log), so routing those through
  // it even while the breaker is tripped is safe — and it is what keeps
  // `apiroc_platform_auth_failure` reachable during exactly the mass-key-fault scenario
  // it exists to catch.
  log.error(
    {
      probed: candidateCount,
      reconnectRequiredCount,
      threshold: massFailureThreshold,
    },
    'apiroc_probe_mass_failure_suspected'
  );
  for (const failure of deferredFailures) {
    if (failure.reconnectRequired) continue;
    await applyCredentialFailure(failure.connection, failure.err, 'health_probe');
    result.unclassifiedFailed += 1;
  }
}

/**
 * Breaker NOT tripped — every deferred failure routes through `applyCredentialFailure`, not
 * only the reconnect-required ones.
 *
 * ⚠⚠ BAL-396 FIX ROUND — EVERY DEFERRED FAILURE ROUTES THROUGH `applyCredentialFailure`,
 * NOT ONLY THE RECONNECT-REQUIRED ONES. Before this fix, `credential-status.ts`'s
 * `platform_auth_failure` / `transient` / `other` branches (including the
 * `apiroc_platform_auth_failure` marker) were UNREACHABLE in production — this job is
 * that function's ONLY caller. `result.failed` also counted ONLY applied reconnect
 * failures, so a tick where every call 401s on a bad platform key logged
 * `apiroc_health_probe_completed { failed: 0 }` — indistinguishable from a genuinely
 * healthy sweep. `unclassifiedFailed` is what makes that visible now.
 */
async function applyAllDeferredFailures(
  deferredFailures: readonly DeferredFailure[],
  result: CalendarHealthProbeResult
): Promise<void> {
  for (const failure of deferredFailures) {
    await applyCredentialFailure(failure.connection, failure.err, 'health_probe');
    if (failure.reconnectRequired) {
      result.failed += 1;
    } else {
      result.unclassifiedFailed += 1;
    }
  }
}

export interface CalendarHealthProbeResult {
  probed: number;
  /** Reconnect-required verdicts actually APPLIED (status flipped, expert notified). */
  failed: number;
  /**
   * ⚠⚠ BAL-396 FIX ROUND. Classified failures routed through `applyCredentialFailure` that
   * did NOT flip credential status — `platform_auth_failure` / `transient` / `other`
   * verdicts. Counted separately from `failed` (reconnect-required only) so a tick where
   * every call 401s on a bad PLATFORM key can never log `failed: 0` and read as a healthy
   * sweep — see the file docblock and `applyCredentialFailure`.
   */
  unclassifiedFailed: number;
  recovered: number;
  batchFilled: boolean;
  massFailureSuspected: boolean;
}

/** The sweep body (exported for unit testing without a Redis-backed Worker). */
export async function runCalendarHealthProbe(
  now: Date,
  jobLog: (message: string) => void = () => {}
): Promise<CalendarHealthProbeResult> {
  const checkedBefore = new Date(now.getTime() - PROBE_INTERVAL_MS);
  const candidates = await calendarRepository.listConnectionsDueForHealthCheck(
    checkedBefore,
    CALENDAR_HEALTH_PROBE_BATCH_LIMIT
  );

  const batchFilled = candidates.length === CALENDAR_HEALTH_PROBE_BATCH_LIMIT;
  if (batchFilled) {
    // ⚠ NO SILENT CAPS. A full batch means connections were DROPPED from this tick.
    log.warn(
      { limit: CALENDAR_HEALTH_PROBE_BATCH_LIMIT },
      'apiroc_health_probe_batch_filled — connections were dropped from this tick'
    );
  }

  const result: CalendarHealthProbeResult = {
    probed: candidates.length,
    failed: 0,
    unclassifiedFailed: 0,
    recovered: 0,
    batchFilled,
    massFailureSuspected: false,
  };
  if (candidates.length === 0) {
    log.info(result, 'apiroc_health_probe_completed');
    return result;
  }

  // ⚠ EVERY CLASSIFIED-FAILURE STATUS/NOTIFY VERDICT IS DEFERRED — `probeCandidate` never
  // writes credential STATUS itself; it only classifies and defers. See the mass-failure
  // breaker in the file docblock for why.
  //
  // ⚠ round-2 fix #13 — this does NOT mean "no connection's credential status is ever
  // written inside this loop" — `probeAndHeal`'s SUCCESS path calls `provisionConnection`
  // (which writes status via `setCredentialStatusForProvider`) and `setCredentialStatus`
  // directly, both un-deferred. That is deliberate and harmless: a SUCCESSFUL data call
  // carries no misclassification risk, so the breaker — which exists only to stop a
  // platform-wide FAILURE from being misread as mass expert-side revocation — has nothing to
  // guard against on that path. The deferred-write discipline applies to failure verdicts
  // only.
  const deferredFailures: DeferredFailure[] = [];

  for (const connection of candidates) {
    const { recovered, deferredFailure } = await probeCandidate(connection, now, jobLog);
    if (recovered) {
      result.recovered += 1;
    }
    if (deferredFailure) {
      deferredFailures.push(deferredFailure);
    }
  }

  const { reconnectRequired, massFailureThreshold, massFailureSuspected } = evaluateMassFailure(
    candidates.length,
    deferredFailures
  );
  result.massFailureSuspected = massFailureSuspected;

  if (massFailureSuspected) {
    await applyDeferredFailuresBreakerTripped(
      deferredFailures,
      candidates.length,
      reconnectRequired.length,
      massFailureThreshold,
      result
    );
  } else {
    await applyAllDeferredFailures(deferredFailures, result);
  }

  log.info(result, 'apiroc_health_probe_completed');
  return result;
}

/** Start the calendar health probe worker (concurrency 1 — serialised, house precedent). */
export function startCalendarHealthProbeWorker(): Worker {
  return new Worker(
    CALENDAR_HEALTH_PROBE_QUEUE,
    async (job: Job) => {
      const result = await runCalendarHealthProbe(new Date(), (m) => job.log(m));
      job.log(
        `calendar health probe: ${result.probed} probed, ${result.failed} failed, ${result.unclassifiedFailed} unclassifiedFailed, ${result.recovered} recovered, batchFilled=${result.batchFilled}, massFailureSuspected=${result.massFailureSuspected}`
      );
    },
    {
      connection: createRedisConnection(),
      concurrency: 1,
    }
  );
}

/** Register the repeatable 15-minute health-probe sweep. */
export async function registerCalendarHealthProbeCron(): Promise<void> {
  const queue = getQueue(CALENDAR_HEALTH_PROBE_QUEUE);
  await queue.add(
    'probe',
    {},
    {
      repeat: { pattern: CALENDAR_HEALTH_PROBE_CRON },
      removeOnComplete: true,
    }
  );
}

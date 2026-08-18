import crypto from 'node:crypto';
import {
  calendarRepository,
  calendarSubscriptionsRepository,
  type CalendarConnection,
} from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import {
  ApirocError,
  callApiroc,
  classifyCredentialFailure,
  getApirocClient,
  paginateApiroc,
} from '../../lib/apiroc/index.js';
import { encryptCalendarSecret } from '../../lib/calendar-encryption.js';
import {
  APIROC_WEBHOOK_PATH_PREFIX,
  buildSubscriptionWebhookUrl,
  resolveWebhookBaseUrl,
  subscriptionRowIdFromWebhookUrl,
} from './webhook-url.js';
import {
  buildSubscriptionPlan,
  parseVendorExpiration,
  SUBSCRIPTION_PLAN_MAX_ACTIONS,
  type PlanCreate,
  type PlanDelete,
  type VendorSubscriptionView,
} from './subscription-plan.js';

const log = createLogger('calendar-subscription-reconcile');

/**
 * BAL-468 §8.8 — the first paginated call site in the repo that passes a page size at all.
 * The vendor's default is 400; explicit here so the forced-small-page test can pin real
 * multi-page termination against this call site (see `subscription-reconcile.test.ts`).
 */
export const APIROC_SUBSCRIPTION_LIST_PAGE_LIMIT = 100;

export type ReconcileSkipReason =
  | 'connection_not_active'
  | 'webhook_not_configured'
  | 'cipher_not_configured'
  | 'credential_failed_mid_sweep';

export interface ReconcileOutcome {
  readonly skipped: ReconcileSkipReason | null;
  readonly created: number;
  readonly renewed: number;
  readonly deleted: number;
  readonly deleteFailures: number;
  readonly unverifiedDeletes: number;
  readonly stamped: number;
  readonly missingAtVendor: number;
  readonly cappedActions: number;
}

function skipOutcome(reason: ReconcileSkipReason): ReconcileOutcome {
  return {
    skipped: reason,
    created: 0,
    renewed: 0,
    deleted: 0,
    deleteFailures: 0,
    unverifiedDeletes: 0,
    stamped: 0,
    missingAtVendor: 0,
    cappedActions: 0,
  };
}

function isReconnectRequired(err: unknown): boolean {
  return err instanceof ApirocError && classifyCredentialFailure(err).kind === 'reconnect_required';
}

/**
 * ⚠⚠ ABSENCE AT THE VENDOR **IS** PROOF OF CLEANUP — and treating it as a failure instead is
 * what creates undead rows.
 *
 * A delete is otherwise only ever proven by the vendor accepting it. But the vendor
 * legitimately forgets a subscription: that is the state EVERY row lands in after the 7-day
 * TTL lapses, and the `vendor_missing` case the plan already names as real. Firing a delete
 * for an id the vendor no longer has answers not-found, which used to increment
 * `deleteFailures` and DELIBERATELY LEAVE THE ROW LIVE — so the next pass re-derived it as
 * `superseded`, retried the same impossible delete, and so on forever. The row kept its stale
 * `expiration`, so monitor arm 1 alerted on it every single day, at error level, with an
 * admin notification, and the self-heal could never clear it. Unbounded accumulation of
 * undead rows plus a permanent unfixable page.
 *
 * Two closures, belt and braces:
 *   · `vendorHasSubscription` — skip the call entirely when the fresh vendor list we ALREADY
 *     fetched does not contain the id;
 *   · this predicate — treat a not-found answer from the call as success anyway, for the row
 *     that lapsed between the list and the delete.
 */
function isNotFound(err: unknown): boolean {
  return err instanceof ApirocError && err.kind === 'not_found';
}

async function listVendorSubscriptions(
  endUserAccountId: string
): Promise<VendorSubscriptionView[]> {
  const client = getApirocClient();
  return paginateApiroc('calendarSubscriptions.list', (pageToken) =>
    client.calendarSubscriptions.list(endUserAccountId, {
      limit: APIROC_SUBSCRIPTION_LIST_PAGE_LIMIT,
      ...(pageToken ? { pageToken } : {}),
    })
  );
}

interface ExecutionCounters {
  created: number;
  renewed: number;
  deleted: number;
  deleteFailures: number;
}

/**
 * ⚠⚠ THE ROW ID IS MINTED BEFORE THE VENDOR CALL (§8.5). Create-then-delete, in that order
 * (§8.6) — a failed delete leaves the superseded row LIVE, never soft-deleted, so it is
 * retried as `superseded` on the next pass rather than orphaned.
 */
async function executeCreate(
  connection: CalendarConnection,
  plan: PlanCreate,
  counters: ExecutionCounters,
  /** `true` when the fresh vendor list still contains this id. See `isNotFound`. */
  vendorHasSubscription: (webhookSubscriptionId: string) => boolean
): Promise<'ok' | 'credential_failed'> {
  const rowId = crypto.randomUUID();
  const webhookUrl = buildSubscriptionWebhookUrl(rowId);
  const client = getApirocClient();

  let created: { webhookSubscriptionId: string; endpointSecret: string };
  try {
    created = await callApiroc('calendarSubscriptions.create', () =>
      client.calendarSubscriptions.create(connection.endUserAccountId, {
        calendarId: plan.calendarId,
        webhookUrl,
        subscriptionType: 'event',
      })
    );
  } catch (err: unknown) {
    if (isReconnectRequired(err)) return 'credential_failed';
    log.error(
      {
        connectionId: connection.id,
        calendarId: plan.calendarId,
        operation: 'calendarSubscriptions.create',
        error: err instanceof Error ? err.message : String(err),
      },
      'apiroc_subscription_create_failed'
    );
    return 'ok';
  }

  await calendarSubscriptionsRepository.insertSubscription({
    id: rowId,
    connectionId: connection.id,
    calendarId: plan.calendarId,
    webhookSubscriptionId: created.webhookSubscriptionId,
    endpointSecret: encryptCalendarSecret(created.endpointSecret),
    webhookUrl,
  });

  const { supersedes } = plan;
  if (supersedes === null) {
    counters.created += 1;
    return 'ok';
  }

  counters.renewed += 1;
  // Already gone at the vendor → nothing to delete; the row is cleaned up locally. See
  // `isNotFound`'s docblock for the undead-row loop this closes.
  if (!vendorHasSubscription(supersedes.webhookSubscriptionId)) {
    await calendarSubscriptionsRepository.softDeleteById(supersedes.rowId);
    counters.deleted += 1;
    return 'ok';
  }
  try {
    await callApiroc('calendarSubscriptions.delete', () =>
      client.calendarSubscriptions.delete(
        connection.endUserAccountId,
        supersedes.webhookSubscriptionId
      )
    );
    await calendarSubscriptionsRepository.softDeleteById(supersedes.rowId);
    counters.deleted += 1;
  } catch (err: unknown) {
    if (isReconnectRequired(err)) return 'credential_failed';
    if (isNotFound(err)) {
      await calendarSubscriptionsRepository.softDeleteById(supersedes.rowId);
      counters.deleted += 1;
      return 'ok';
    }
    counters.deleteFailures += 1;
    log.warn(
      {
        connectionId: connection.id,
        webhookSubscriptionId: supersedes.webhookSubscriptionId,
        reason: err instanceof Error ? err.message : String(err),
        context: 'renewal',
      },
      'apiroc_subscription_delete_failed'
    );
  }
  return 'ok';
}

async function executeDelete(
  connection: CalendarConnection,
  plan: PlanDelete,
  counters: ExecutionCounters,
  /** `true` when the fresh vendor list still contains this id. See `isNotFound`. */
  vendorHasSubscription: (webhookSubscriptionId: string) => boolean
): Promise<'ok' | 'credential_failed'> {
  const client = getApirocClient();
  // Already gone at the vendor → nothing to delete. See `isNotFound`'s docblock.
  if (!vendorHasSubscription(plan.webhookSubscriptionId)) {
    if (plan.rowId !== null) {
      await calendarSubscriptionsRepository.softDeleteById(plan.rowId);
    }
    counters.deleted += 1;
    return 'ok';
  }
  try {
    await callApiroc('calendarSubscriptions.delete', () =>
      client.calendarSubscriptions.delete(connection.endUserAccountId, plan.webhookSubscriptionId)
    );
  } catch (err: unknown) {
    if (isReconnectRequired(err)) return 'credential_failed';
    if (isNotFound(err)) {
      if (plan.rowId !== null) {
        await calendarSubscriptionsRepository.softDeleteById(plan.rowId);
      }
      counters.deleted += 1;
      return 'ok';
    }
    counters.deleteFailures += 1;
    log.warn(
      {
        connectionId: connection.id,
        webhookSubscriptionId: plan.webhookSubscriptionId,
        reason: err instanceof Error ? err.message : String(err),
        context: plan.reason,
      },
      'apiroc_subscription_delete_failed'
    );
    return 'ok';
  }
  if (plan.rowId !== null) {
    await calendarSubscriptionsRepository.softDeleteById(plan.rowId);
  }
  counters.deleted += 1;
  return 'ok';
}

/**
 * The IDs a fresh vendor read must NOT still contain, for the verification pass to consider
 * cleanup proven: every planned delete, plus every row a renewal was meant to supersede.
 */
function intendedDeleteIds(plan: {
  readonly deletes: readonly PlanDelete[];
  readonly creates: readonly PlanCreate[];
}): Set<string> {
  const supersededIds = plan.creates
    .map((c) => c.supersedes)
    .filter((s): s is { rowId: string; webhookSubscriptionId: string } => s !== null)
    .map((s) => s.webhookSubscriptionId);
  return new Set<string>([...plan.deletes.map((d) => d.webhookSubscriptionId), ...supersededIds]);
}

/**
 * Guards 1–3. Never throws — the caller turns a non-null `skip` straight into `skipOutcome`.
 */
function checkReconcilePreconditions(
  connection: CalendarConnection
): { skip: ReconcileSkipReason } | { skip: null; webhookUrlPrefix: string } {
  // Guard 1 — reconnect-first ordering is structurally enforced here: deleting a subscription
  // while the credential is EXPIRED is forbidden at the vendor (403), and that is precisely
  // why a non-ACTIVE connection never reaches a vendor call at all.
  if (connection.deletedAt !== null || connection.credentialStatus !== 'ACTIVE') {
    log.info(
      { connectionId: connection.id, reason: 'connection_not_active' },
      'apiroc_subscription_reconcile_skipped'
    );
    return { skip: 'connection_not_active' };
  }

  // Guard 2 — the feature's on-switch.
  const webhookBaseUrl = resolveWebhookBaseUrl();
  if (webhookBaseUrl === null) {
    log.warn({ connectionId: connection.id }, 'apiroc_webhook_not_configured');
    return { skip: 'webhook_not_configured' };
  }

  // Guard 3 — a create whose secret cannot be persisted would leave a pointless orphan.
  if (!process.env.CALENDAR_ENCRYPTION_KEY) {
    log.warn(
      { connectionId: connection.id, reason: 'cipher_not_configured' },
      'apiroc_subscription_reconcile_skipped'
    );
    return { skip: 'cipher_not_configured' };
  }

  return { skip: null, webhookUrlPrefix: `${webhookBaseUrl}${APIROC_WEBHOOK_PATH_PREFIX}` };
}

/**
 * Serial execution — creates before deletes (§8.6): coverage before tidiness, and no gap in
 * change-push coverage during a renewal's brief create/delete overlap. `counters` is mutated
 * in place. Returns the operation that hit a credential failure, or `null` if the whole plan
 * executed.
 */
async function executeReconciliationPlan(
  connection: CalendarConnection,
  plan: { readonly creates: readonly PlanCreate[]; readonly deletes: readonly PlanDelete[] },
  counters: ExecutionCounters,
  vendorHasSubscription: (webhookSubscriptionId: string) => boolean
): Promise<'calendarSubscriptions.create' | 'calendarSubscriptions.delete' | null> {
  for (const create of plan.creates) {
    const outcome = await executeCreate(connection, create, counters, vendorHasSubscription);
    if (outcome === 'credential_failed') return 'calendarSubscriptions.create';
  }
  for (const del of plan.deletes) {
    const outcome = await executeDelete(connection, del, counters, vendorHasSubscription);
    if (outcome === 'credential_failed') return 'calendarSubscriptions.delete';
  }
  return null;
}

interface VerificationOutcome {
  readonly ok: boolean;
  readonly stamped: number;
  readonly missingAtVendor: number;
  readonly unverifiedDeletes: number;
}

/**
 * Verification pass — a SECOND, fresh vendor read. Cleanup is verified, not best-effort.
 * `ok: false` ⇒ the caller must return `skipOutcome('credential_failed_mid_sweep')`.
 */
async function verifyReconciliationOutcome(
  connection: CalendarConnection,
  plan: { readonly creates: readonly PlanCreate[]; readonly deletes: readonly PlanDelete[] }
): Promise<VerificationOutcome> {
  let stamped = 0;
  let missingAtVendor = 0;
  let unverifiedDeletes = 0;
  try {
    const [freshVendorRecords, liveRowsNow] = await Promise.all([
      listVendorSubscriptions(connection.endUserAccountId),
      calendarSubscriptionsRepository.listLiveByConnectionId(connection.id),
    ]);
    const freshById = new Map(freshVendorRecords.map((r) => [r.id, r]));
    const now = new Date();

    for (const liveRow of liveRowsNow) {
      const record = freshById.get(liveRow.webhookSubscriptionId);
      if (record === undefined) {
        missingAtVendor += 1;
        log.warn(
          { connectionId: connection.id, calendarSubscriptionId: liveRow.id },
          'apiroc_subscription_missing_at_vendor'
        );
        continue;
      }
      await calendarSubscriptionsRepository.stampVendorState(
        liveRow.id,
        parseVendorExpiration(record.expiration),
        now
      );
      stamped += 1;
    }

    for (const id of intendedDeleteIds(plan)) {
      if (freshById.has(id)) {
        unverifiedDeletes += 1;
        log.error(
          { connectionId: connection.id, webhookSubscriptionId: id },
          'apiroc_subscription_delete_unverified'
        );
      }
    }
  } catch (err: unknown) {
    if (isReconnectRequired(err)) {
      log.warn(
        { connectionId: connection.id, operation: 'calendarSubscriptions.list' },
        'apiroc_subscription_reconcile_credential_failure'
      );
      return { ok: false, stamped, missingAtVendor, unverifiedDeletes };
    }
    log.error(
      { connectionId: connection.id, error: err instanceof Error ? err.message : String(err) },
      'apiroc_subscription_reconcile_verification_failed'
    );
  }
  return { ok: true, stamped, missingAtVendor, unverifiedDeletes };
}

/**
 * BAL-468 §8 — THE SINGLE SUBSCRIPTION-RECONCILIATION FUNCTION. Never throws for an expected
 * condition — every outcome is a typed answer (`ReconcileOutcome`), mirroring
 * `provisionConnection`'s "SYNC_PENDING on failure, never a throw" contract in the same
 * directory. Provider-agnostic by construction — this module never names a provider (Scan B).
 */
export async function reconcileConnectionSubscriptions(
  connection: CalendarConnection,
  options: { readonly force: boolean }
): Promise<ReconcileOutcome> {
  const preconditions = checkReconcilePreconditions(connection);
  if (preconditions.skip !== null) return skipOutcome(preconditions.skip);
  const { webhookUrlPrefix } = preconditions;

  const [subCalendars, baloRows] = await Promise.all([
    calendarRepository.findSubCalendarsByConnectionId(connection.id),
    calendarSubscriptionsRepository.listLiveByConnectionId(connection.id),
  ]);
  const desiredCalendarIds = subCalendars.filter((c) => c.conflictCheck).map((c) => c.calendarId);

  let vendorRecords: VendorSubscriptionView[];
  try {
    vendorRecords = await listVendorSubscriptions(connection.endUserAccountId);
  } catch (err: unknown) {
    if (isReconnectRequired(err)) {
      log.warn(
        { connectionId: connection.id, operation: 'calendarSubscriptions.list' },
        'apiroc_subscription_reconcile_credential_failure'
      );
      return skipOutcome('credential_failed_mid_sweep');
    }
    // Transient / server_error / rate_limited — no decision base to act on. Let BullMQ retry.
    throw err;
  }

  // Rule 6's global orphan check.
  //
  // ⚠⚠ THE ID MUST COME FROM `subscriptionRowIdFromWebhookUrl`, NOT FROM A BARE `slice`. That
  // helper is the ONE derivation of "row id from a vendor-echoed URL" — the route uses it too,
  // so sharing it is what makes the two provably identical. It also rejects a non-uuid tail,
  // which a `slice` happily passes through: any URL under our prefix with a normalising
  // trailing slash, an appended query string, or a hand-created subscription yields something
  // like `"<uuid>/"`, Postgres answers `22P02 invalid input syntax for type uuid`, and the
  // throw escapes this function (it is outside every `try` below). BullMQ then burns its 3
  // attempts and drops the job, the health probe re-enqueues it every tick, and it fails
  // identically forever — so that connection's subscriptions never renew and lapse at the
  // 7-day vendor TTL. Monitor arm 1 does alert, so it degrades loudly rather than silently,
  // but it stays broken until a human intervenes.
  //
  // `listLiveByIds` with an empty array short-circuits to `[]` with no query.
  const candidateOrphanIds = vendorRecords
    .map((r) => subscriptionRowIdFromWebhookUrl(r.url, webhookUrlPrefix))
    .filter((id): id is string => id !== null);
  const knownLiveRows = await calendarSubscriptionsRepository.listLiveByIds(candidateOrphanIds);
  const knownLiveRowIds = new Set(knownLiveRows.map((r) => r.id));

  const plan = buildSubscriptionPlan({
    desiredCalendarIds,
    baloRows,
    vendorRecords,
    knownLiveRowIds,
    webhookUrlPrefix,
    now: new Date(),
    force: options.force,
  });

  if (plan.cappedActions > 0) {
    log.warn(
      {
        connectionId: connection.id,
        cappedActions: plan.cappedActions,
        // ⚠ the CONSTANT, never a literal — a hard-coded 25 makes this log line silently lie
        // the moment the cap is retuned two files away.
        max: SUBSCRIPTION_PLAN_MAX_ACTIONS,
      },
      'apiroc_subscription_plan_capped'
    );
  }

  for (const stamp of plan.stamps) {
    await calendarSubscriptionsRepository.stampVendorState(
      stamp.rowId,
      stamp.expiration,
      new Date()
    );
  }

  const counters: ExecutionCounters = { created: 0, renewed: 0, deleted: 0, deleteFailures: 0 };

  // Built from the vendor read ABOVE — the same list the orphan rule uses. A delete for an id
  // absent from it is a no-op at the vendor, so it is settled locally instead. See `isNotFound`.
  const vendorSubscriptionIds = new Set(vendorRecords.map((r) => r.id));
  const vendorHasSubscription = (webhookSubscriptionId: string): boolean =>
    vendorSubscriptionIds.has(webhookSubscriptionId);

  const credentialFailedOperation = await executeReconciliationPlan(
    connection,
    plan,
    counters,
    vendorHasSubscription
  );
  if (credentialFailedOperation !== null) {
    log.warn(
      { connectionId: connection.id, operation: credentialFailedOperation },
      'apiroc_subscription_reconcile_credential_failure'
    );
    return skipOutcome('credential_failed_mid_sweep');
  }

  const verification = await verifyReconciliationOutcome(connection, plan);
  if (!verification.ok) {
    return skipOutcome('credential_failed_mid_sweep');
  }

  const outcome: ReconcileOutcome = {
    skipped: null,
    created: counters.created,
    renewed: counters.renewed,
    deleted: counters.deleted,
    deleteFailures: counters.deleteFailures,
    unverifiedDeletes: verification.unverifiedDeletes,
    stamped: verification.stamped,
    missingAtVendor: verification.missingAtVendor,
    cappedActions: plan.cappedActions,
  };
  log.info({ connectionId: connection.id, ...outcome }, 'apiroc_subscription_reconcile_completed');
  return outcome;
}

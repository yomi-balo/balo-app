import {
  calendarRepository,
  calendarSubscriptionsRepository,
  type CalendarConnection,
} from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import { getApirocClient, callApiroc, paginateApiroc } from '../../lib/apiroc/index.js';

const log = createLogger('apiroc-connection');

/**
 * BAL-396 §10.2 — connect/provision/disconnect. Deliberately PROVIDER-AGNOSTIC: the parity
 * table (apiroc skill) is encoded as tolerant parsing, never as a branch on `provider`
 * (Objection 3; `invariants/sync-token-parity.test.ts` Scan B bans a provider literal or a
 * `provider ===` / `switch (provider` form anywhere under this directory).
 */

// ── §1 — persist the pointer ────────────────────────────────────

export interface PersistApirocConnectionArgs {
  readonly expertProfileId: string;
  readonly provider: string;
  readonly endUserAccountId: string;
}

/** §1 — persist the pointer. No tokens, ever (apiroc skill, Constraint 1). */
export async function persistApirocConnection(
  args: PersistApirocConnectionArgs
): Promise<CalendarConnection> {
  return calendarRepository.upsertApirocConnection({
    expertProfileId: args.expertProfileId,
    provider: args.provider,
    endUserAccountId: args.endUserAccountId,
  });
}

// ── §4 — provisioning (list writable calendars, default the target) ────────

interface ListedCalendar {
  readonly calendarId: string;
  readonly name: string;
  readonly isPrimary: boolean;
  readonly readOnly: boolean;
  readonly color: string | null;
}

/**
 * `calendars.list`, paginated TO EXHAUSTION via the shared `paginateApiroc` helper
 * (apiroc skill, Constraint 9) — see its docblock for the termination and `callApiroc`-per-page
 * rules.
 */
async function listAllCalendars(endUserAccountId: string): Promise<ListedCalendar[]> {
  const client = getApirocClient();
  const calendars = await paginateApiroc('calendars.list', (pageToken) =>
    client.calendars.list(endUserAccountId, pageToken ? { pageToken } : undefined)
  );

  return calendars.map((cal) => ({
    calendarId: cal.id,
    name: cal.name,
    // ⚠ TREAT ABSENT AND EXPLICIT `false` IDENTICALLY (apiroc skill provider-parity table):
    // one provider omits the field on a non-primary calendar, the other sends `false`
    // explicitly. No provider branch either way.
    isPrimary: cal.isPrimary === true,
    readOnly: cal.readOnly === true,
    color: cal.hexColor ?? null,
  }));
}

/**
 * §4 — first (or repeat) provisioning: list writable calendars, store them, default the
 * target calendar to the primary one. Returns the resulting credential status.
 *
 * ⚠ `SYNC_PENDING` ON A `calendars.list` FAILURE, NEVER A THROW. A `calendars.list` failure
 * here (5xx / network / timeout — NOT a credential failure, which is a 401/403 the caller
 * handles separately) means the vendor account exists but Balo has not finished
 * provisioning. Persisting `SYNC_PENDING` is what the existing card already renders, and it
 * is what the health probe's healer targets (`calendar-health-probe.ts`) — discarding the
 * row instead would strand an End User Account at Apiroc that Balo holds no pointer to.
 *
 * ⚠⚠ `SYNC_PENDING` ALSO ON **ZERO WRITABLE CALENDARS** (BAL-396 fix round) — NOT `ACTIVE`.
 * A `calendars.list` call that SUCCEEDS with an empty 200, or with every calendar
 * `readOnly`, used to still persist `ACTIVE`: `replaceSubCalendars(id, [])` wipes every
 * sub-calendar row, `listBusyReadTargets` then reports `provisioned: false`, and the
 * booking gate fails CLOSED on every window — a PERMANENTLY-UNBOOKABLE absorbing state,
 * because the probe's heal path only re-provisions a connection whose STATUS is non-ACTIVE
 * (see `calendar-health-probe.ts`). Persisting `SYNC_PENDING` instead keeps this connection
 * inside that heal path exactly like a `calendars.list` failure does.
 *
 * ⚠ THE TARGET CALENDAR IS ONLY DEFAULTED WHEN UNSET. A re-provision (the health probe's heal
 * path) must never clobber a target the expert already chose.
 *
 * ⚠ CONFLICT-CHECK CHOICES ARE PRESERVED ACROSS A RE-PROVISION (BAL-396 fix round). This
 * runs on EVERY OAuth reconnect callback, and `replaceSubCalendars` deletes-then-inserts —
 * so writing `conflictCheck: cal.isPrimary` unconditionally silently reverted any calendar
 * the expert had opted into or out of conflict-checking, on every reconnect. A calendar id
 * that survives the re-list keeps its stored preference; only a genuinely NEW calendar id
 * gets the primary-only default.
 */
export async function provisionConnection(
  connection: CalendarConnection
): Promise<'ACTIVE' | 'SYNC_PENDING'> {
  const { endUserAccountId } = connection;

  let calendars: ListedCalendar[];
  try {
    calendars = await listAllCalendars(endUserAccountId);
  } catch (err: unknown) {
    log.warn(
      {
        connectionId: connection.id,
        expertProfileId: connection.expertProfileId,
        error: err instanceof Error ? err.message : String(err),
      },
      'apiroc_provisioning_failed_sync_pending'
    );
    await calendarRepository.setCredentialStatusForProvider(
      connection.expertProfileId,
      connection.provider,
      'SYNC_PENDING'
    );
    // ⚠ round-2 fix #6 — `SYNC_PENDING` makes this connection unreadable to
    // `vendor-busy.ts`'s `isUnreadable`, which makes every booking against this expert 409.
    // `clearAvailabilityCache` (the only other caller: `credential-status.ts`'s EXPIRED/
    // REVOKED flip) is what stops the expert being ADVERTISED as available on stale
    // last-known-good data while unbookable — without it here, `earliest_available_at` keeps
    // its stale pre-breakage value (the rebuild job's write is SKIPPED once the vendor read
    // starts throwing) and the expert stays in search results, 409ing on every attempt.
    await calendarRepository.clearAvailabilityCache(connection.expertProfileId);
    return 'SYNC_PENDING';
  }

  // Balo creates no calendars (apiroc skill, Constraint 7) — only the writable ones are
  // stored as candidates for the conflict-check toggle / target calendar.
  const writable = calendars.filter((cal) => !cal.readOnly);

  if (writable.length === 0) {
    log.warn(
      {
        connectionId: connection.id,
        expertProfileId: connection.expertProfileId,
        calendarsListed: calendars.length,
      },
      'apiroc_connection_provisioning_incomplete'
    );
    // ⚠ round-2 fix #4 — DO NOT call `replaceSubCalendars(connection.id, [])` here. This
    // branch runs on EVERY re-provision (including a healthy reconnect's re-list), and a
    // single TRANSIENT `calendars.list` response with an empty/all-read-only page would
    // otherwise wipe exactly the sub-calendar rows — and the conflict-check preferences on
    // them — that this file's round-1 fix set out to preserve. Leave existing rows in place
    // and let the health probe's heal path (`calendar-health-probe.ts`) re-provision once a
    // real writable-calendar list comes back. The `SYNC_PENDING` status set below already
    // makes `vendor-busy.ts`'s `isUnreadable` reject this connection's read (credentialStatus
    // !== ACTIVE) regardless of the now-untouched `provisioned` row-presence flag, so nothing
    // depends on the wipe.
    await calendarRepository.setCredentialStatusForProvider(
      connection.expertProfileId,
      connection.provider,
      'SYNC_PENDING'
    );
    // ⚠ round-2 fix #6 — see the identical call (and its full rationale) in the
    // `calendars.list` failure branch above; this is the SAME absorbing-cache hazard, reached
    // via a SUCCESSFUL `calendars.list` with zero writable calendars instead of a thrown
    // error.
    await calendarRepository.clearAvailabilityCache(connection.expertProfileId);
    return 'SYNC_PENDING';
  }

  // Existing sub-calendar rows, read BEFORE `replaceSubCalendars` deletes them — the source
  // of truth for which calendar ids the expert already made a conflict-check choice about.
  const existing = await calendarRepository.findSubCalendarsByConnectionId(connection.id);
  const existingConflictCheck = new Map(existing.map((sub) => [sub.calendarId, sub.conflictCheck]));

  await calendarRepository.replaceSubCalendars(
    connection.id,
    writable.map((cal) => ({
      calendarId: cal.calendarId,
      name: cal.name,
      provider: connection.provider,
      profileName: connection.providerEmail,
      isPrimary: cal.isPrimary,
      // A calendar Balo already knew about keeps whatever the expert last chose; a
      // genuinely NEW calendar defaults to the apiroc skill provider-parity table's rule —
      // primary conflict-checked, everything else off (matches today's Cronofy default).
      //
      // ⚠ round-2 fix #3 — `cal.isPrimary ||` is a FLOOR, not a fallback: `api.ts:281`
      // refuses to let an expert disable conflict-checking on a PRIMARY calendar, because
      // `listBusyReadTargets` filters on this flag and a primary excluded from free/busy
      // makes the expert's real commitments invisible. Without the floor, a calendar that
      // was non-primary when the expert turned conflict-check off (allowed) and later
      // becomes primary at the provider re-provisions as `isPrimary: true, conflictCheck:
      // false` — silently and indefinitely violating that invariant. The floor re-asserts it
      // on every re-provision; a non-primary calendar still keeps whatever was last chosen.
      conflictCheck: cal.isPrimary || (existingConflictCheck.get(cal.calendarId) ?? false),
      color: cal.color,
    }))
  );

  if (connection.targetCalendarId === null) {
    const primary = writable.find((cal) => cal.isPrimary);
    if (primary) {
      await calendarRepository.updateTargetCalendarIdForProvider(
        connection.expertProfileId,
        connection.provider,
        primary.calendarId
      );
    }
  }

  await calendarRepository.setCredentialStatusForProvider(
    connection.expertProfileId,
    connection.provider,
    'ACTIVE'
  );
  return 'ACTIVE';
}

// ── §6 — per-provider teardown ──────────────────────────────────

/**
 * BAL-468 §10 — best-effort, per-subscription vendor deletes, BEFORE the End User Account
 * delete: deleting the account may or may not cascade its subscriptions at the vendor
 * (unverified), and after the account delete the account id no longer addresses anything.
 * Never throws — a failure here is logged and the teardown continues; a stale vendor
 * subscription keeps delivering for up to 7 days to a URL that will 404 after step 4 below,
 * and Svix disables that endpoint after ~5 days. Blast radius is one calendar's trigger.
 */
async function deleteVendorSubscriptionsBestEffort(connection: CalendarConnection): Promise<void> {
  const liveRows = await calendarSubscriptionsRepository.listLiveByConnectionId(connection.id);
  if (liveRows.length === 0) return;

  const client = getApirocClient();
  for (const row of liveRows) {
    try {
      await callApiroc('calendarSubscriptions.delete', () =>
        client.calendarSubscriptions.delete(connection.endUserAccountId, row.webhookSubscriptionId)
      );
    } catch (err: unknown) {
      log.warn(
        {
          connectionId: connection.id,
          webhookSubscriptionId: row.webhookSubscriptionId,
          reason: err instanceof Error ? err.message : String(err),
          context: 'disconnect',
        },
        'apiroc_subscription_delete_failed'
      );
    }
  }
}

/**
 * §6 — per-provider teardown (see `routes/calendar/api.ts`'s disconnect handler for the full
 * sequence, including the availability-cache rebuild and analytics, which are that route's
 * job, not this service's).
 *
 * Vendor deletion is BEST EFFORT and ORDERED FIRST: if the vendor call fails, Balo's side is
 * still removed — leaving a row the expert asked to disconnect is the worse failure.
 *
 * ⚠ NO NULL GUARD ON `endUserAccountId` — removed in the BAL-396 fix round. Migration 0069
 * made the column `NOT NULL`, so every live row (the only kind `findConnectionByExpertAndProvider`
 * can return) already carries a pointer; the vendor call always runs.
 *
 * BAL-468 §10 — new ordering: (1) best-effort per-subscription vendor deletes, (2) best-effort
 * End User Account delete (unchanged), (3) `softDeleteByConnectionId` — NOT OPTIONAL, without it
 * the monitor alerts forever on rows for a disconnected connection and the webhook route would
 * keep resolving and processing deliveries for an expert who unhooked their calendar — (4)/(5)
 * the existing sub-calendar and connection teardown (unchanged).
 */
export async function disconnectProvider(expertProfileId: string, provider: string): Promise<void> {
  const connection = await calendarRepository.findConnectionByExpertAndProvider(
    expertProfileId,
    provider
  );
  if (!connection) return;

  await deleteVendorSubscriptionsBestEffort(connection);

  try {
    const client = getApirocClient();
    await callApiroc('endUserAccounts.delete', () =>
      client.endUserAccounts.delete(connection.endUserAccountId)
    );
  } catch (err: unknown) {
    log.warn(
      {
        connectionId: connection.id,
        expertProfileId,
        error: err instanceof Error ? err.message : String(err),
      },
      'apiroc_disconnect_vendor_delete_failed'
    );
  }

  await calendarSubscriptionsRepository.softDeleteByConnectionId(connection.id);
  await calendarRepository.deleteSubCalendarsByConnectionId(connection.id);
  await calendarRepository.softDeleteConnectionForProvider(expertProfileId, provider);
}

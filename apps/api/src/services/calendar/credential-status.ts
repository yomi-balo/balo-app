import { calendarRepository, type CalendarConnection } from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import {
  trackServer,
  CALENDAR_SERVER_EVENTS,
  toCalendarEventProvider,
} from '@balo/analytics/server';
import {
  getApirocClient,
  callApiroc,
  classifyCredentialFailure,
  type ApirocError,
} from '../../lib/apiroc/index.js';
import type { CredentialVerdict } from '../../lib/apiroc/reconnect.js';
import { notificationEvents } from '../../notifications/publisher.js';

const log = createLogger('credential-status');

/**
 * BAL-396 §10.4 — THE ONE PLACE A CREDENTIAL IS MARKED BROKEN. Provider-agnostic (no
 * provider literal, no `provider ===` / `switch (provider` form — Scan B,
 * `invariants/sync-token-parity.test.ts`); the analytics payload's `'google' | 'microsoft'`
 * literal union is resolved through `toCalendarEventProvider` (`@balo/analytics/server`) so
 * this file never has to name a provider itself.
 *
 * ⚠ `detectedBy` IS `'health_probe'` ONLY — narrowed in the BAL-396 fix round.
 * `CALENDAR_SERVER_EVENTS.CREDENTIALS_REVOKED`'s `detected_by` field used to also accept
 * `'data_call'`, for a hoped-for future booking-path caller that catches an `ApirocError`
 * directly. No such caller exists: the health probe is this function's ONLY production
 * caller, so `'data_call'` was dead on arrival and the "probe-detected vs booking-detected"
 * metric BAL-396 asks for could not actually be computed. Widen this back to
 * `'health_probe' | 'data_call'` (here and in `CalendarServerEventMap`) the same time a
 * booking-path call site is added — not before.
 */
export async function applyCredentialFailure(
  connection: CalendarConnection,
  err: ApirocError,
  detectedBy: 'health_probe'
): Promise<CredentialVerdict> {
  const verdict = classifyCredentialFailure(err);

  if (verdict.kind === 'reconnect_required') {
    await flipToReconnectRequired(connection, detectedBy);
    return verdict;
  }

  if (verdict.kind === 'platform_auth_failure') {
    log.error(
      {
        connectionId: connection.id,
        expertProfileId: connection.expertProfileId,
        operation: err.operation,
        status: err.status,
      },
      'apiroc_platform_auth_failure'
    );
    return verdict;
  }

  // 'transient' | 'other' — log at warn; leave the row alone.
  log.warn(
    {
      connectionId: connection.id,
      expertProfileId: connection.expertProfileId,
      kind: verdict.kind,
      operation: err.operation,
      status: err.status,
    },
    'apiroc_credential_failure_not_actioned'
  );
  return verdict;
}

/**
 * Re-read `endUserAccounts.get()` to CONFIRM which non-ACTIVE status to persist. A failed
 * confirmation never aborts the flip — the data call that got us here IS the evidence — so
 * this always resolves to a status, never throws.
 *
 * ⚠ `REVOKED` ONLY WHEN THE VENDOR SAYS SO. Every other outcome — the re-read says `ACTIVE`
 * (the status LAGS, apiroc skill Constraint 10), the re-read says `EXPIRED`, or the re-read
 * itself fails — persists `EXPIRED`. `REVOKED` is reachable on Google in principle but the
 * skill's credential-expiry table never observed it in practice; treating anything short of
 * an explicit `REVOKED` answer as `EXPIRED` is the conservative default.
 *
 * ⚠ NO NULL GUARD ON `endUserAccountId` — removed in the BAL-396 fix round. Migration 0069
 * made the column `NOT NULL`, so a live `CalendarConnection` always carries a pointer.
 */
async function confirmNonActiveStatus(endUserAccountId: string): Promise<'EXPIRED' | 'REVOKED'> {
  try {
    const client = getApirocClient();
    const account = await callApiroc('endUserAccounts.get', () =>
      client.endUserAccounts.get(endUserAccountId)
    );
    return account.status === 'REVOKED' ? 'REVOKED' : 'EXPIRED';
  } catch {
    return 'EXPIRED';
  }
}

async function flipToReconnectRequired(
  connection: CalendarConnection,
  detectedBy: 'health_probe'
): Promise<void> {
  const status = await confirmNonActiveStatus(connection.endUserAccountId);

  await calendarRepository.setCredentialStatus(connection.id, status);
  await calendarRepository.clearAvailabilityCache(connection.expertProfileId);

  // ⚠ round-2 fix #9 — this is the single most consequential state change in this feature
  // (an expert silently going unbookable) and it previously emitted NO LOG LINE AT ALL. The
  // PostHog `trackServer` call below is a no-op without `POSTHOG_API_KEY` (dev/CI), and the
  // notification publish below is best-effort and swallowed on failure — neither is a
  // structured, always-on operational record. `apiroc_credential_reconnect_required` is that
  // record.
  log.warn(
    {
      connectionId: connection.id,
      expertProfileId: connection.expertProfileId,
      provider: connection.provider,
      status,
      detectedBy,
    },
    'apiroc_credential_reconnect_required'
  );

  // Notify at most once per breakage — the caller owns suppression, the engine does not
  // (BAL-396 §7.2). `reconnectNotifiedAt` is cleared by `upsertApirocConnection` on
  // reconnect and by the health probe's recovery path, which is what lets a SECOND breakage
  // notify again.
  if (connection.reconnectNotifiedAt === null) {
    try {
      await notificationEvents.publish('calendar.auth_error', {
        correlationId: connection.id,
        expertProfileId: connection.expertProfileId,
        provider: connection.provider,
      });
      await calendarRepository.markReconnectNotified(connection.id, new Date());
    } catch (publishErr: unknown) {
      log.error(
        {
          connectionId: connection.id,
          expertProfileId: connection.expertProfileId,
          error: publishErr instanceof Error ? publishErr.message : String(publishErr),
        },
        'Failed to publish calendar.auth_error notification event'
      );
    }
  }

  const eventProvider = toCalendarEventProvider(connection.provider);
  if (eventProvider) {
    trackServer(CALENDAR_SERVER_EVENTS.CREDENTIALS_REVOKED, {
      provider: eventProvider,
      detected_by: detectedBy,
      distinct_id: connection.expertProfileId,
    });
  }
}

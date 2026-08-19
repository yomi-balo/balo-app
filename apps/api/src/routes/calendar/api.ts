import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  calendarRepository,
  type CalendarConnection as DbCalendarConnection,
  type CalendarSubCalendar,
} from '@balo/db';
import { requireInternalAuth } from '../../lib/internal-auth.js';
import { disconnectProvider } from '../../services/calendar/apiroc-connection.js';
import { enqueueAvailabilityCacheRebuild } from '../../jobs/availability-cache.js';
import { trackServer, CALENDAR_SERVER_EVENTS } from '@balo/analytics/server';
import type { CalendarProvider, SubCalendar, CalendarConnection } from './types.js';

// ── Validation schemas ──────────────────────────────────────────

const expertProfileIdSchema = z.object({
  expertProfileId: z.string().uuid(),
});

const disconnectBodySchema = z.object({
  expertProfileId: z.string().uuid(),
  provider: z.enum(['google', 'microsoft']).optional(),
});

const toggleConflictCheckSchema = z.object({
  expertProfileId: z.string().uuid(),
  calendarId: z.string().min(1),
  conflictCheck: z.boolean(),
});

const setTargetCalendarSchema = z.object({
  expertProfileId: z.string().uuid(),
  targetCalendarId: z.string().min(1),
  provider: z.enum(['google', 'microsoft']).optional(),
});

// ── Helper: map DB data to frontend types ───────────────────────

/**
 * BAL-396 fix round, Finding 7 — the `office365` translation was Cronofy-only, and migration
 * 0069 (`DELETE FROM calendar_connections WHERE end_user_account_id IS NULL`) removed every
 * Cronofy-era row, the only source of that value; Apiroc always writes lowercase `google` /
 * `microsoft` directly (`services/calendar/apiroc-connection.ts`). No CHECK constrains
 * `provider` (a bare `text` column), so this still narrows defensively rather than asserting —
 * `google` is the fallback only because a garbage value has no better answer, never because a
 * Cronofy row is still expected here.
 */
function mapProvider(provider: string): CalendarProvider {
  return provider === 'microsoft' ? 'microsoft' : 'google';
}

function mapSubCalendar(sub: CalendarSubCalendar): SubCalendar {
  return {
    id: sub.calendarId,
    name: sub.name,
    provider: mapProvider(sub.provider),
    primary: sub.isPrimary,
    conflictChecking: sub.conflictCheck,
    color: sub.color ?? undefined,
  };
}

/**
 * BAL-397 — the real DB vocabulary reaches the client verbatim. `status` is renamed to
 * `credentialStatus` so nobody mistakes the new four-value union (`ACTIVE | SYNC_PENDING |
 * EXPIRED | REVOKED`) for the retired three-value one on sight.
 */
function mapConnectionSummary(
  connection: DbCalendarConnection,
  subCalendars: CalendarSubCalendar[]
): CalendarConnection {
  return {
    // BAL-396 fix round 2, Finding 6 — see the `CalendarConnection.provider` docblock (types.ts).
    provider: mapProvider(connection.provider),
    credentialStatus: connection.credentialStatus,
    providerEmail: connection.providerEmail,
    lastSyncedAt: connection.lastSyncedAt?.toISOString() ?? null,
    targetCalendarId: connection.targetCalendarId,
    subCalendars: subCalendars.map(mapSubCalendar),
  };
}

/**
 * BAL-396 §8.4 — "same resolution-by-calendar-id" for the two per-calendar mutations that
 * were not given an explicit `provider` field. An expert may hold more than one live
 * connection (ADR-1021 amendment 18 Aug 2026 §1), so "the" connection is no longer
 * well-defined by `expertProfileId` alone; this resolves it FROM the calendar id instead,
 * checking each live connection in turn.
 */
async function findConnectionOwningCalendar(
  expertProfileId: string,
  calendarId: string
): Promise<{ connection: DbCalendarConnection; subCalendar: CalendarSubCalendar } | undefined> {
  const connections = await calendarRepository.listConnectionsByExpertProfileId(expertProfileId);
  for (const connection of connections) {
    const subCalendar = await calendarRepository.findSubCalendarByCalendarId(
      connection.id,
      calendarId
    );
    if (subCalendar) return { connection, subCalendar };
  }
  return undefined;
}

// ── Routes ──────────────────────────────────────────────────────

export async function calendarApiRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /api/calendar/connection
   * Returns the expert's calendar connections — the per-provider summary array BAL-397's
   * multi-connection UI consumes. The legacy single-connection `connection` key (oldest live
   * connection, any provider) is GONE — `apps/web` no longer has a single-connection card to
   * feed it, and `findConnectionWithSubCalendars` is deleted as its only caller.
   */
  fastify.get(
    '/api/calendar/connection',
    { preHandler: [requireInternalAuth] },
    async (request, reply) => {
      const parsed = expertProfileIdSchema.safeParse(request.query);

      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Invalid query parameters',
          details: parsed.error.issues.map((i: { message: string }) => i.message),
        });
      }

      const { expertProfileId } = parsed.data;

      try {
        const allConnections =
          await calendarRepository.listConnectionsByExpertProfileId(expertProfileId);

        const connections = await Promise.all(
          allConnections.map(async (connection) => {
            const subCalendars = await calendarRepository.findSubCalendarsByConnectionId(
              connection.id
            );
            return mapConnectionSummary(connection, subCalendars);
          })
        );

        return reply.send({ connections });
      } catch (err: unknown) {
        request.log.error(
          {
            expertProfileId,
            error: err instanceof Error ? err.message : String(err),
          },
          'Failed to fetch calendar connection'
        );
        return reply.status(500).send({ error: 'Failed to fetch calendar connection' });
      }
    }
  );

  /**
   * POST /api/calendar/disconnect
   * `provider` present → disconnect that provider only. Absent → disconnect every live
   * connection, then `softDeleteConnection` as a backstop for anything the per-provider loop
   * did not name. (Migration 0069 already removes every Cronofy-era row at the DB level —
   * this backstop is not for those; it is a defensive catch-all for a connection the
   * per-provider loop above did not enumerate.)
   *
   * ⚠ THE `provider`-ABSENT ARM HAS NO SHIPPED CALLER AS OF BAL-397. It used to back a
   * "Disconnect all calendars" affordance; that copy is gone — `calendar-disconnect-confirm.tsx`
   * is per-provider now — and the web action (`_actions/disconnect-calendar.ts`) Zod-validates
   * `provider` as REQUIRED precisely so an omitted field cannot silently escalate one
   * provider's disconnect into an account-wide one. `.optional()` stays here as the documented
   * whole-account contract for a future caller; do not treat it as reachable from the settings
   * UI.
   */
  fastify.post(
    '/api/calendar/disconnect',
    { preHandler: [requireInternalAuth] },
    async (request, reply) => {
      const parsed = disconnectBodySchema.safeParse(request.body);

      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Invalid request body',
          details: parsed.error.issues.map((i: { message: string }) => i.message),
        });
      }

      const { expertProfileId, provider } = parsed.data;

      try {
        if (provider) {
          await disconnectProvider(expertProfileId, provider);
        } else {
          const connections =
            await calendarRepository.listConnectionsByExpertProfileId(expertProfileId);
          for (const connection of connections) {
            await disconnectProvider(expertProfileId, connection.provider);
          }
          await calendarRepository.softDeleteConnection(expertProfileId);
        }

        // Recompute from whatever remains (with `provider` absent, that is nothing) —
        // an ENQUEUE, not a clear: with two providers connected, disconnecting one must
        // recompute from the remaining one, not blank the cache.
        await enqueueAvailabilityCacheRebuild(expertProfileId, request.log);

        trackServer(CALENDAR_SERVER_EVENTS.DISCONNECTED, {
          ...(provider ? { provider } : {}),
          distinct_id: expertProfileId,
        });

        return reply.send({ success: true });
      } catch (err: unknown) {
        request.log.error(
          {
            expertProfileId,
            provider,
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
          },
          'Failed to disconnect calendar'
        );
        return reply.status(500).send({ error: 'Failed to disconnect calendar' });
      }
    }
  );

  /**
   * POST /api/calendar/toggle-conflict-check
   * Toggles conflict checking for a sub-calendar. Cannot disable on the primary calendar.
   * Resolves the owning connection FROM the calendar id (§8.4) — no provider in the body.
   */
  fastify.post(
    '/api/calendar/toggle-conflict-check',
    { preHandler: [requireInternalAuth] },
    async (request, reply) => {
      const parsed = toggleConflictCheckSchema.safeParse(request.body);

      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Invalid request body',
          details: parsed.error.issues.map((i: { message: string }) => i.message),
        });
      }

      const { expertProfileId, calendarId, conflictCheck } = parsed.data;

      try {
        const found = await findConnectionOwningCalendar(expertProfileId, calendarId);
        if (!found) {
          return reply.status(404).send({ error: 'Sub-calendar not found' });
        }
        const { connection, subCalendar } = found;

        if (subCalendar.isPrimary && !conflictCheck) {
          return reply
            .status(400)
            .send({ error: 'Cannot disable conflict checking on primary calendar' });
        }

        await calendarRepository.updateConflictCheck(connection.id, calendarId, conflictCheck);

        // BAL-396 fix round, Finding 5 — `listBusyReadTargets` filters on `conflict_check`, so
        // toggling it changes what the booking gate reads. Without this, toggling ON makes the
        // booking gate stricter than the (now stale) advertise cache — 409s on advertised slots
        // — and toggling OFF leaves the expert under-advertised until the next unrelated
        // rebuild. Matches the disconnect handler's rebuild call above.
        await enqueueAvailabilityCacheRebuild(expertProfileId, request.log);

        return reply.send({ success: true });
      } catch (err: unknown) {
        request.log.error(
          {
            expertProfileId,
            calendarId,
            error: err instanceof Error ? err.message : String(err),
          },
          'Failed to toggle conflict check'
        );
        return reply.status(500).send({ error: 'Failed to toggle conflict check' });
      }
    }
  );

  /**
   * POST /api/calendar/set-target-calendar
   * Sets the target calendar for event writes. `provider` optional — when absent, the
   * owning connection is resolved from the calendar id (§8.4) and written per-provider.
   */
  fastify.post(
    '/api/calendar/set-target-calendar',
    { preHandler: [requireInternalAuth] },
    async (request, reply) => {
      const parsed = setTargetCalendarSchema.safeParse(request.body);

      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Invalid request body',
          details: parsed.error.issues.map((i: { message: string }) => i.message),
        });
      }

      const { expertProfileId, targetCalendarId, provider } = parsed.data;

      try {
        let resolvedProvider: string;

        if (provider) {
          const connection = await calendarRepository.findConnectionByExpertAndProvider(
            expertProfileId,
            provider
          );
          if (!connection) {
            return reply.status(404).send({ error: 'No calendar connection found' });
          }
          const subCalendar = await calendarRepository.findSubCalendarByCalendarId(
            connection.id,
            targetCalendarId
          );
          if (!subCalendar) {
            return reply
              .status(404)
              .send({ error: 'Calendar not found in connected sub-calendars' });
          }
          resolvedProvider = provider;
        } else {
          const found = await findConnectionOwningCalendar(expertProfileId, targetCalendarId);
          if (!found) {
            return reply
              .status(404)
              .send({ error: 'Calendar not found in connected sub-calendars' });
          }
          resolvedProvider = found.connection.provider;
        }

        await calendarRepository.updateTargetCalendarIdForProvider(
          expertProfileId,
          resolvedProvider,
          targetCalendarId
        );
        return reply.send({ success: true });
      } catch (err: unknown) {
        request.log.error(
          {
            expertProfileId,
            targetCalendarId,
            error: err instanceof Error ? err.message : String(err),
          },
          'Failed to set target calendar'
        );
        return reply.status(500).send({ error: 'Failed to set target calendar' });
      }
    }
  );
}

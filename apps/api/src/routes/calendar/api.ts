import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { calendarRepository } from '@balo/db';
import { requireInternalAuth } from '../../lib/internal-auth.js';
import { disconnectCalendar, listAndStoreCalendars } from '../../services/cronofy/oauth.js';
import { withCronofyRetry } from '../../services/cronofy/retry.js';
import { getValidAccessToken } from '../../services/cronofy/token-manager.js';
import { getCronofyUserClient } from '../../lib/cronofy.js';
import { trackServer, CALENDAR_SERVER_EVENTS } from '@balo/analytics/server';
import type { CalendarProvider, SubCalendar, CalendarConnection } from './types.js';

// ── Validation schemas ──────────────────────────────────────────

const expertProfileIdSchema = z.object({
  expertProfileId: z.string().uuid(),
});

const toggleConflictCheckSchema = z.object({
  expertProfileId: z.string().uuid(),
  calendarId: z.string().min(1),
  conflictCheck: z.boolean(),
});

const setTargetCalendarSchema = z.object({
  expertProfileId: z.string().uuid(),
  targetCalendarId: z.string().min(1),
});

// ── Helper: map DB data to frontend types ───────────────────────

function mapProvider(provider: string): CalendarProvider {
  if (provider === 'google' || provider === 'microsoft') return provider;
  // Cronofy uses 'office365' internally — map back to 'microsoft'
  if (provider === 'office365') return 'microsoft';
  return 'google';
}

function mapConnectionToFrontend(
  connection: Awaited<ReturnType<typeof calendarRepository.findConnectionWithSubCalendars>>
): CalendarConnection | null {
  if (!connection) return null;

  return {
    status: connection.status as CalendarConnection['status'],
    providerEmail: connection.providerEmail,
    lastSyncedAt: connection.lastSyncedAt?.toISOString() ?? null,
    targetCalendarId: connection.targetCalendarId,
    subCalendars: connection.subCalendars.map(
      (sub): SubCalendar => ({
        id: sub.calendarId,
        name: sub.name,
        provider: mapProvider(sub.provider),
        primary: sub.isPrimary,
        conflictChecking: sub.conflictCheck,
        color: sub.color ?? undefined,
      })
    ),
  };
}

// ── Routes ──────────────────────────────────────────────────────

export async function calendarApiRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /api/calendar/connection
   * Returns the expert's calendar connection with sub-calendars.
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
        const connection = await calendarRepository.findConnectionWithSubCalendars(expertProfileId);
        return reply.send({ connection: mapConnectionToFrontend(connection) });
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
   * Disconnects the expert's calendar (revoke, cleanup, soft-delete).
   */
  fastify.post(
    '/api/calendar/disconnect',
    { preHandler: [requireInternalAuth] },
    async (request, reply) => {
      const parsed = expertProfileIdSchema.safeParse(request.body);

      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Invalid request body',
          details: parsed.error.issues.map((i: { message: string }) => i.message),
        });
      }

      const { expertProfileId } = parsed.data;

      try {
        await disconnectCalendar(expertProfileId);

        trackServer(CALENDAR_SERVER_EVENTS.DISCONNECTED, {
          distinct_id: expertProfileId,
        });

        return reply.send({ success: true });
      } catch (err: unknown) {
        request.log.error(
          {
            expertProfileId,
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
   * Toggles conflict checking for a sub-calendar.
   * Cannot disable on primary calendar.
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
        const connection =
          await calendarRepository.findConnectionByExpertProfileId(expertProfileId);
        if (!connection) {
          return reply.status(404).send({ error: 'No calendar connection found' });
        }

        const subCalendar = await calendarRepository.findSubCalendarByCalendarId(
          connection.id,
          calendarId
        );
        if (!subCalendar) {
          return reply.status(404).send({ error: 'Sub-calendar not found' });
        }

        // Primary calendar conflictCheck cannot be disabled
        if (subCalendar.isPrimary && !conflictCheck) {
          return reply
            .status(400)
            .send({ error: 'Cannot disable conflict checking on primary calendar' });
        }

        await calendarRepository.updateConflictCheck(connection.id, calendarId, conflictCheck);
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
   * Sets the target calendar for event writes.
   * Validates the calendar exists in the expert's sub-calendars.
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

      const { expertProfileId, targetCalendarId } = parsed.data;

      try {
        const connection =
          await calendarRepository.findConnectionByExpertProfileId(expertProfileId);
        if (!connection) {
          return reply.status(404).send({ error: 'No calendar connection found' });
        }

        const subCalendar = await calendarRepository.findSubCalendarByCalendarId(
          connection.id,
          targetCalendarId
        );
        if (!subCalendar) {
          return reply.status(404).send({ error: 'Calendar not found in connected sub-calendars' });
        }

        await calendarRepository.updateTargetCalendarId(expertProfileId, targetCalendarId);
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

  /**
   * POST /api/calendar/refresh-calendars
   * Re-fetches calendars from Cronofy and updates sub-calendars in DB.
   * Uses withCronofyRetry for automatic token refresh on 401.
   */
  fastify.post(
    '/api/calendar/refresh-calendars',
    { preHandler: [requireInternalAuth] },
    async (request, reply) => {
      const parsed = expertProfileIdSchema.safeParse(request.body);

      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Invalid request body',
          details: parsed.error.issues.map((i: { message: string }) => i.message),
        });
      }

      const { expertProfileId } = parsed.data;

      try {
        await withCronofyRetry(expertProfileId, async (accessToken) => {
          await listAndStoreCalendars(expertProfileId, accessToken);
        });

        return reply.send({ success: true });
      } catch (err: unknown) {
        request.log.error(
          {
            expertProfileId,
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
          },
          'Failed to refresh calendars'
        );
        return reply.status(500).send({ error: 'Failed to refresh calendars' });
      }
    }
  );

  /**
   * GET /api/calendar/relink
   * Generates a fresh Cronofy profile relink URL for an expert in sync_pending state.
   * The link_token embedded in the relink URL has a 5-minute TTL,
   * so we call Cronofy userinfo fresh each time to get a new one.
   */
  fastify.get(
    '/api/calendar/relink',
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
        const connection =
          await calendarRepository.findConnectionByExpertProfileId(expertProfileId);
        if (!connection) {
          return reply.status(404).send({ error: 'No calendar connection found' });
        }
        if (connection.status !== 'sync_pending') {
          return reply.status(400).send({ error: 'Connection is not in sync_pending state' });
        }

        const accessToken = await getValidAccessToken(expertProfileId);
        const userClient = getCronofyUserClient(accessToken);
        const userInfo = await userClient.userInfo();
        const profile = userInfo.profiles?.[0];

        if (!profile?.profile_relink_url) {
          return reply.status(400).send({
            error: 'No relink URL available — profile may already be synced',
          });
        }

        trackServer(CALENDAR_SERVER_EVENTS.RELINK_URL_GENERATED, {
          distinct_id: expertProfileId,
        });

        return reply.send({ relinkUrl: profile.profile_relink_url });
      } catch (err: unknown) {
        request.log.error(
          { expertProfileId, error: err instanceof Error ? err.message : String(err) },
          'Failed to generate relink URL'
        );
        return reply.status(500).send({ error: 'Failed to generate relink URL' });
      }
    }
  );
}

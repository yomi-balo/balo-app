import type { FastifyInstance, FastifyBaseLogger } from 'fastify';
import { calendarRepository, type CalendarConnection } from '@balo/db';
import { getQueue } from '../../lib/queue.js';
import { AVAILABILITY_CACHE_QUEUE } from '../../jobs/availability-cache.js';
import { trackServer, CALENDAR_SERVER_EVENTS } from '@balo/analytics/server';
import { getValidAccessToken } from '../../services/cronofy/token-manager.js';
import { listAndStoreCalendars, registerPushChannel } from '../../services/cronofy/oauth.js';
import { getCronofyUserClient } from '../../lib/cronofy.js';

// ── Webhook types ───────────────────────────────────────────────

interface CronofyWebhookBody {
  notification: {
    type: 'change' | 'verification' | 'profile_disconnected' | 'profile_connected';
    changes_since?: string;
  };
  channel: {
    channel_id: string;
    callback_url: string;
  };
}

// ── Notification handlers ───────────────────────────────────────

async function enqueueAvailabilityCacheRebuild(
  expertProfileId: string,
  log: FastifyBaseLogger
): Promise<void> {
  try {
    const queue = getQueue(AVAILABILITY_CACHE_QUEUE);
    await queue.add(
      'rebuild-availability-cache',
      { expertProfileId },
      {
        jobId: `availability-${expertProfileId}`,
        removeOnComplete: true,
        removeOnFail: false,
      }
    );
  } catch (err: unknown) {
    log.error(
      { expertProfileId, error: err instanceof Error ? err.message : String(err) },
      'Failed to enqueue availability cache rebuild job'
    );
  }
}

async function handleChange(connection: CalendarConnection, log: FastifyBaseLogger): Promise<void> {
  await calendarRepository.updateLastSyncedAt(connection.id);
  await enqueueAvailabilityCacheRebuild(connection.expertProfileId, log);
}

async function handleProfileDisconnected(
  connection: CalendarConnection,
  log: FastifyBaseLogger
): Promise<void> {
  await calendarRepository.updateConnectionStatus(connection.expertProfileId, 'auth_error');
  await calendarRepository.clearAvailabilityCache(connection.expertProfileId);
  // TODO(BAL-232 follow-up): Publish domain event for reconnect email via notification engine
  log.warn(
    { expertProfileId: connection.expertProfileId },
    'Calendar profile disconnected by provider — auth_error set, cache cleared'
  );
}

async function handleProfileConnected(
  connection: CalendarConnection,
  log: FastifyBaseLogger
): Promise<void> {
  const accessToken = await getValidAccessToken(connection.expertProfileId);
  const userClient = getCronofyUserClient(accessToken);
  const userInfo = await userClient.userInfo();
  const profile = userInfo.profiles?.[0];

  if (profile?.profile_initial_sync_required) {
    log.info(
      { expertProfileId: connection.expertProfileId },
      'profile_connected received but initial sync still required'
    );
    return;
  }

  await calendarRepository.updateConnectionStatus(connection.expertProfileId, 'connected');
  await listAndStoreCalendars(connection.expertProfileId, accessToken);
  await registerPushChannel(connection.expertProfileId, accessToken);
  await enqueueAvailabilityCacheRebuild(connection.expertProfileId, log);

  log.info(
    { expertProfileId: connection.expertProfileId },
    'Calendar profile connected — calendars listed, push channel registered'
  );
}

// ── Route ───────────────────────────────────────────────────────

export async function calendarWebhookRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post('/webhooks/cronofy', async (request, reply) => {
    void reply.status(200).send({ ok: true });

    try {
      const body = request.body as CronofyWebhookBody;
      const { notification, channel } = body;

      if (!notification?.type || !channel?.channel_id) {
        request.log.warn('Received malformed Cronofy webhook');
        return;
      }

      const expectedCallbackUrl = `${process.env.API_BASE_URL}/webhooks/cronofy`;
      if (channel.callback_url && channel.callback_url !== expectedCallbackUrl) {
        request.log.warn(
          { callbackUrl: channel.callback_url, expected: expectedCallbackUrl },
          'Webhook callback_url mismatch — rejecting'
        );
        return;
      }

      if (notification.type === 'verification') {
        request.log.info('Cronofy verification ping received');
        return;
      }

      const connection = await calendarRepository.findConnectionByChannelId(channel.channel_id);
      if (!connection) {
        request.log.warn({ channelId: channel.channel_id }, 'Webhook for unknown channel');
        return;
      }

      trackServer(CALENDAR_SERVER_EVENTS.WEBHOOK_RECEIVED, {
        notification_type: notification.type,
        distinct_id: connection.expertProfileId,
      });

      switch (notification.type) {
        case 'change':
          await handleChange(connection, request.log);
          break;
        case 'profile_disconnected':
          await handleProfileDisconnected(connection, request.log);
          break;
        case 'profile_connected':
          await handleProfileConnected(connection, request.log);
          break;
        default:
          request.log.info({ type: notification.type }, 'Unhandled Cronofy notification type');
      }
    } catch (err: unknown) {
      request.log.error(
        { error: err instanceof Error ? err.message : String(err) },
        'Unexpected error processing Cronofy webhook'
      );
    }
  });
}

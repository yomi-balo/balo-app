import type { FastifyInstance } from 'fastify';
import { calendarRepository } from '@balo/db';
import { getQueue } from '../../lib/queue.js';
import { AVAILABILITY_CACHE_QUEUE } from '../../jobs/availability-cache.js';
import { trackServer, CALENDAR_SERVER_EVENTS } from '@balo/analytics/server';

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

// ── Helpers ─────────────────────────────────────────────────────

async function enqueueAvailabilityCacheRebuild(
  expertProfileId: string,
  logger: { error: (ctx: Record<string, unknown>, msg: string) => void }
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
    logger.error(
      {
        expertProfileId,
        error: err instanceof Error ? err.message : String(err),
      },
      'Failed to enqueue availability cache rebuild job'
    );
  }
}

// ── Route ───────────────────────────────────────────────────────

export async function calendarWebhookRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * POST /webhooks/cronofy
   * Handles push notifications from Cronofy.
   * Responds 200 immediately — all processing is wrapped in try/catch
   * to prevent unhandled promise rejections after the response is sent.
   */
  fastify.post('/webhooks/cronofy', async (request, reply) => {
    // Always respond 200 immediately — Cronofy retries on non-2xx
    void reply.status(200).send({ ok: true });

    try {
      const body = request.body as CronofyWebhookBody;
      const { notification, channel } = body;

      if (!notification?.type || !channel?.channel_id) {
        request.log.warn('Received malformed Cronofy webhook');
        return;
      }

      // Validate callback_url matches our expected webhook URL to prevent spoofed payloads
      const expectedCallbackUrl = `${process.env.API_BASE_URL}/webhooks/cronofy`;
      if (channel.callback_url && channel.callback_url !== expectedCallbackUrl) {
        request.log.warn(
          { callbackUrl: channel.callback_url, expected: expectedCallbackUrl },
          'Webhook callback_url mismatch — rejecting'
        );
        return;
      }

      // Verification ping — sent when channel is first created
      if (notification.type === 'verification') {
        request.log.info('Cronofy verification ping received');
        return;
      }

      // Look up which expert this channel belongs to
      const connection = await calendarRepository.findConnectionByChannelId(channel.channel_id);

      if (!connection) {
        request.log.warn(
          { channelId: channel.channel_id },
          'Received webhook for unknown channel — orphaned'
        );
        return;
      }

      trackServer(CALENDAR_SERVER_EVENTS.WEBHOOK_RECEIVED, {
        notification_type: notification.type,
        distinct_id: connection.expertProfileId,
      });

      switch (notification.type) {
        case 'change': {
          await calendarRepository.updateLastSyncedAt(connection.id);
          await enqueueAvailabilityCacheRebuild(connection.expertProfileId, request.log);
          break;
        }

        case 'profile_disconnected': {
          await calendarRepository.updateConnectionStatus(connection.expertProfileId, 'auth_error');
          request.log.warn(
            { expertProfileId: connection.expertProfileId },
            'Calendar profile disconnected by provider'
          );
          break;
        }

        case 'profile_connected': {
          await calendarRepository.updateConnectionStatus(connection.expertProfileId, 'connected');
          await enqueueAvailabilityCacheRebuild(connection.expertProfileId, request.log);
          break;
        }

        default:
          request.log.info({ type: notification.type }, 'Unhandled Cronofy notification type');
      }
    } catch (err: unknown) {
      // Catch all errors after reply.send() to prevent unhandled promise rejections.
      // The response is already sent so we can only log.
      request.log.error(
        { error: err instanceof Error ? err.message : String(err) },
        'Unexpected error processing Cronofy webhook'
      );
    }
  });
}

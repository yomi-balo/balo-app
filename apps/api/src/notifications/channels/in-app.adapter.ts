import { Worker, type Job } from 'bullmq';
import { userNotificationsRepository } from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import { trackServer, NOTIFICATION_SERVER_EVENTS } from '@balo/analytics/server';
import { createRedisConnection } from '../../lib/redis.js';
import { getInAppTemplate } from './templates/in-app-templates.js';
import { logNotification } from './log.js';
import type { DeliveryPayload } from './types.js';

const log = createLogger('notification-in-app');

/** Exported for testability — called by the BullMQ worker. */
export async function processInAppJob(job: Job<DeliveryPayload>): Promise<void> {
  const payload = job.data;

  // 1. Render template
  const { title, body, actionUrl } = getInAppTemplate(payload.template, {
    ...payload.data,
    ...payload.payload,
  });

  // 2. Write to user_notifications table
  try {
    await userNotificationsRepository.insert({
      userId: payload.recipientId,
      event: payload.event,
      title,
      body: body ?? null,
      actionUrl: actionUrl ?? null,
      metadata: {
        correlationId: payload.payload.correlationId,
        template: payload.template,
      },
    });

    // 3. Log delivery to notification_log
    await logNotification(payload, 'in-app', 'sent');

    // 4. Track analytics
    trackServer(NOTIFICATION_SERVER_EVENTS.IN_APP_SENT, {
      template: payload.template,
      event: payload.event,
      distinct_id: payload.recipientId,
    });

    log.info(
      { template: payload.template, recipientId: payload.recipientId },
      'In-app notification sent'
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    await logNotification(payload, 'in-app', 'failed', errorMessage);

    trackServer(NOTIFICATION_SERVER_EVENTS.IN_APP_FAILED, {
      template: payload.template,
      event: payload.event,
      error_type: errorMessage,
      distinct_id: payload.recipientId,
    });

    log.error(
      {
        template: payload.template,
        recipientId: payload.recipientId,
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined,
      },
      'In-app notification delivery failed'
    );

    throw error; // Re-throw so BullMQ retries
  }
}

export function startInAppWorker(): Worker<DeliveryPayload> {
  const worker = new Worker<DeliveryPayload>('notification-in-app', processInAppJob, {
    connection: createRedisConnection(),
    concurrency: 20,
  });

  worker.on('failed', (job, err) => {
    log.error(
      {
        jobId: job?.id,
        template: job?.data?.template,
        error: err.message,
      },
      'In-app worker job failed'
    );
  });

  return worker;
}

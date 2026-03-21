import { Worker, type Job } from 'bullmq';
import { createLogger } from '@balo/shared/logging';
import { getRedis } from '../../lib/redis.js';
import { notificationRules } from './rules.js';
import { resolveContext } from './resolver.js';
import { dispatch } from './dispatcher.js';

const log = createLogger('notification-engine');

interface NotificationEventJobData {
  event: string;
  payload: Record<string, unknown>;
  publishedAt: string;
}

export function startNotificationEventWorker(): Worker<NotificationEventJobData> {
  const worker = new Worker<NotificationEventJobData>(
    'notification-events',
    async (job: Job<NotificationEventJobData>) => {
      const { event, payload } = job.data;

      log.info({ event, correlationId: payload.correlationId }, 'Processing notification event');

      // 1. Look up rules
      const rules = notificationRules[event];
      if (!rules || rules.length === 0) {
        log.warn({ event }, 'No notification rules found for event');
        return;
      }

      // 2. Hydrate context
      const context = await resolveContext(event, payload);

      // 3. Evaluate each rule and dispatch
      for (const rule of rules) {
        try {
          await dispatch(rule, context);
        } catch (error) {
          log.error(
            {
              event,
              template: rule.template,
              error: error instanceof Error ? error.message : String(error),
              stack: error instanceof Error ? error.stack : undefined,
            },
            'Failed to dispatch notification rule'
          );
          // Individual rule failure doesn't fail the whole event
        }
      }
    },
    {
      connection: getRedis(),
      concurrency: 10,
    }
  );

  worker.on('failed', (job, err) => {
    log.error({ jobId: job?.id, error: err.message }, 'Notification event processing failed');
  });

  return worker;
}

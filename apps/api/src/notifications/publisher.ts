import { getQueue } from '../lib/queue.js';
import type { NotificationEvent, EventPayloadMap } from './events.js';

export const notificationEvents = {
  async publish<E extends NotificationEvent>(event: E, payload: EventPayloadMap[E]): Promise<void> {
    const queue = getQueue('notification-events');
    await queue.add(
      event,
      {
        event,
        payload,
        publishedAt: new Date().toISOString(),
      },
      {
        jobId: `${event}--${payload.correlationId}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
      }
    );
  },
};

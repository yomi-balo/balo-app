import { getQueue } from '../lib/queue.js';
import type { NotificationEvent, EventPayloadMap } from './events.js';
import { cancelScheduledNotification, scheduleNotification } from './scheduling/schedule.js';

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

  /**
   * BAL-420 — defer a publish. Same import surface as `publish`, so feature code never has
   * to know that "later" is implemented by a Postgres row rather than by the queue.
   * See `scheduling/schedule.ts` for the contract.
   */
  schedule: scheduleNotification,

  /**
   * BAL-420 — void a pending deferred publish. IN-PROCESS ONLY, permanently (ADR-1047
   * Decision 11); returning 0 is normal.
   */
  cancel: cancelScheduledNotification,
};

import { notificationLogRepository } from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import type { NotificationChannel } from '../engine/rules.js';
import type { DeliveryPayload } from './types.js';

const logger = createLogger('notification-log');

export async function logNotification(
  payload: DeliveryPayload,
  channel: NotificationChannel,
  status: 'sent' | 'failed' | 'skipped',
  error?: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  try {
    await notificationLogRepository.insert({
      event: payload.event,
      correlationId: payload.payload.correlationId as string,
      recipientId: payload.recipientId,
      channel,
      template: payload.template,
      status,
      error: error ?? null,
      metadata: metadata ?? null,
    });
  } catch (logError) {
    logger.error(
      {
        event: payload.event,
        template: payload.template,
        error: logError instanceof Error ? logError.message : String(logError),
        stack: logError instanceof Error ? logError.stack : undefined,
      },
      'Failed to write notification log'
    );
  }
}

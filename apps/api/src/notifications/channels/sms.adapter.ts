import { Worker, type Job } from 'bullmq';
import { createRequire } from 'node:module';
import { createLogger } from '@balo/shared/logging';
import { trackServer, NOTIFICATION_SERVER_EVENTS } from '@balo/analytics/server';
import { createRedisConnection } from '../../lib/redis.js';
import { getSmsTemplate } from './templates/sms-templates.js';
import { logNotification } from './log.js';
import type { DeliveryPayload } from './types.js';

const log = createLogger('notification-sms');

const E164_REGEX = /^\+[1-9]\d{6,14}$/;

/** Mask phone number for analytics — show last 4 digits only. */
function maskPhone(phone: string): string {
  if (phone.length <= 4) return '****';
  return '****' + phone.slice(-4);
}

// Cached Brevo client — created lazily on first use
interface BrevoSmsClient {
  transactionalSms: {
    sendTransacSms: (params: Record<string, unknown>) => Promise<{ messageId?: number }>;
  };
}

let brevoClient: BrevoSmsClient | null = null;

async function getBrevoClient(): Promise<BrevoSmsClient> {
  if (brevoClient) return brevoClient;

  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    throw new Error('BREVO_API_KEY is not configured');
  }

  const { BrevoClient } = await import('@getbrevo/brevo');
  brevoClient = new BrevoClient({ apiKey }) as unknown as BrevoSmsClient;
  return brevoClient;
}

/** Exported for testability — called by the BullMQ worker. */
export async function processSmsJob(job: Job<DeliveryPayload>): Promise<void> {
  const payload = job.data;
  const { usersRepository } = createRequire(import.meta.url)('@balo/db');

  // 1. Resolve recipient phone
  const user = await usersRepository.findById(payload.recipientId);
  if (!user?.phone) {
    log.warn({ recipientId: payload.recipientId }, 'No phone for recipient');
    await logNotification(payload, 'sms', 'skipped', 'No phone number');
    trackServer(NOTIFICATION_SERVER_EVENTS.SMS_SKIPPED, {
      template: payload.template,
      skip_reason: 'No phone number',
      distinct_id: payload.recipientId,
    });
    return;
  }

  // 2. Validate E.164 format
  if (!E164_REGEX.test(user.phone)) {
    log.warn({ recipientId: payload.recipientId }, 'Invalid phone number format');
    await logNotification(payload, 'sms', 'skipped', 'Invalid phone number format');
    trackServer(NOTIFICATION_SERVER_EVENTS.SMS_SKIPPED, {
      template: payload.template,
      skip_reason: 'Invalid phone number format',
      distinct_id: payload.recipientId,
    });
    return;
  }

  // 3. Render template
  const body = getSmsTemplate(payload.template, {
    ...payload.data,
    ...payload.payload,
  });

  if (body.length > 160) {
    log.warn(
      { template: payload.template, length: body.length },
      'SMS body exceeds 160 characters — message may be split and billed as multiple SMS'
    );
  }

  // 4. Send via Brevo
  try {
    const client = await getBrevoClient();

    const result = await client.transactionalSms.sendTransacSms({
      sender: process.env.BREVO_SMS_SENDER ?? 'Balo',
      recipient: user.phone,
      content: body,
      type: 'transactional',
    });
    const messageId = result?.messageId;

    await logNotification(payload, 'sms', 'sent', undefined, {
      brevoMessageId: messageId,
    });
    trackServer(NOTIFICATION_SERVER_EVENTS.SMS_SENT, {
      template: payload.template,
      recipient_phone_masked: maskPhone(user.phone),
      distinct_id: payload.recipientId,
    });
    log.info({ template: payload.template, messageId }, 'SMS sent');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await logNotification(payload, 'sms', 'failed', errorMessage);
    trackServer(NOTIFICATION_SERVER_EVENTS.SMS_FAILED, {
      template: payload.template,
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
      'SMS delivery failed'
    );
    throw error; // Re-throw so BullMQ retries
  }
}

export function startSmsWorker(): Worker<DeliveryPayload> {
  const worker = new Worker<DeliveryPayload>('notification-sms', processSmsJob, {
    connection: createRedisConnection(),
    concurrency: 3,
  });

  worker.on('failed', (job, err) => {
    log.error(
      {
        jobId: job?.id,
        template: job?.data?.template,
        error: err.message,
      },
      'SMS worker job failed'
    );
  });

  return worker;
}

import { Worker, type Job } from 'bullmq';
import { usersRepository } from '@balo/db';
import { render } from '@react-email/render';
import { createLogger } from '@balo/shared/logging';
import { createRedisConnection } from '../../lib/redis.js';
import { getEmailTemplate } from './templates/index.js';
import { logNotification } from './log.js';
import type { DeliveryPayload } from './types.js';

const log = createLogger('notification-email');

// Cached Brevo client — created lazily on first use
interface BrevoEmailClient {
  transactionalEmails: {
    sendTransacEmail: (params: Record<string, unknown>) => Promise<{ messageId?: string }>;
  };
}

let brevoClient: BrevoEmailClient | null = null;

async function getBrevoClient(): Promise<BrevoEmailClient> {
  if (brevoClient) return brevoClient;

  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    throw new Error('BREVO_API_KEY is not configured');
  }

  const { BrevoClient } = await import('@getbrevo/brevo');
  brevoClient = new BrevoClient({ apiKey }) as BrevoEmailClient;
  return brevoClient;
}

/** Exported for testability — called by the BullMQ worker. */
export async function processEmailJob(job: Job<DeliveryPayload>): Promise<void> {
  const payload = job.data;

  // 1. Resolve recipient email
  const user = await usersRepository.findById(payload.recipientId);
  if (!user?.email) {
    log.warn({ recipientId: payload.recipientId }, 'No email for recipient');
    await logNotification(payload, 'email', 'skipped', 'No email address');
    return;
  }

  // 2. Render template
  const recipientName = user.firstName ?? 'there';
  const { component, subject } = getEmailTemplate(payload.template, {
    ...payload.data,
    ...payload.payload,
    recipientName,
  });

  const html = await render(component);

  // 3. Send via Brevo
  try {
    const client = await getBrevoClient();

    const result = await client.transactionalEmails.sendTransacEmail({
      htmlContent: html,
      sender: {
        email: process.env.BREVO_SENDER_EMAIL ?? 'notifications@balo.expert',
        name: 'Balo',
      },
      subject,
      to: [{ email: user.email, name: user.firstName ?? undefined }],
    });
    const messageId = result?.messageId;

    await logNotification(payload, 'email', 'sent', undefined, {
      brevoMessageId: messageId,
    });
    log.info({ template: payload.template, to: user.email, messageId }, 'Email sent');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await logNotification(payload, 'email', 'failed', errorMessage);
    log.error(
      {
        template: payload.template,
        recipientId: payload.recipientId,
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined,
      },
      'Email delivery failed'
    );
    throw error; // Re-throw so BullMQ retries
  }
}

export function startEmailWorker(): Worker<DeliveryPayload> {
  const worker = new Worker<DeliveryPayload>('notification-email', processEmailJob, {
    connection: createRedisConnection(),
    concurrency: 5,
  });

  worker.on('failed', (job, err) => {
    log.error(
      {
        jobId: job?.id,
        template: job?.data?.template,
        error: err.message,
      },
      'Email worker job failed'
    );
  });

  return worker;
}

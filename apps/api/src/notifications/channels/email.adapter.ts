import { Worker, type Job } from 'bullmq';
import { usersRepository } from '@balo/db';
import { render } from '@react-email/render';
import { createLogger } from '@balo/shared/logging';
import { createRedisConnection } from '../../lib/redis.js';
import { getR2ObjectBytes } from '../../lib/storage/r2.js';
import { getEmailTemplate } from './templates/index.js';
import { logNotification } from './log.js';
import type { DeliveryPayload } from './types.js';

const log = createLogger('notification-email');

/** A Brevo transactional-email attachment (base64 content + download name). */
interface BrevoAttachment {
  content: string;
  name: string;
}

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

/**
 * BAL-386: resolve each attachment spec's bytes from R2 and base64-encode them for
 * Brevo's `attachment` field. On any R2 read failure we log then THROW so the whole
 * job re-throws and BullMQ retries (the bytes are guaranteed present by apps/web's
 * force-generate at share time, so a miss is transient). Returns `undefined` when
 * there are no attachments so the non-attachment path is unchanged.
 */
async function resolveAttachments(
  payload: DeliveryPayload
): Promise<BrevoAttachment[] | undefined> {
  const specs = payload.attachments;
  if (!specs || specs.length === 0) return undefined;

  const resolved: BrevoAttachment[] = [];
  for (const spec of specs) {
    try {
      const bytes = await getR2ObjectBytes(spec.key);
      resolved.push({
        content: Buffer.from(bytes).toString('base64'),
        name: spec.filename,
      });
    } catch (error) {
      log.warn(
        {
          key: spec.key,
          template: payload.template,
          error: error instanceof Error ? error.message : String(error),
        },
        'Proposal PDF attachment read failed'
      );
      throw error; // Re-throw so the job fails and BullMQ retries.
    }
  }
  return resolved;
}

/** Exported for testability — called by the BullMQ worker. */
export async function processEmailJob(job: Job<DeliveryPayload>): Promise<void> {
  const payload = job.data;

  // 1. Resolve recipient email + display name.
  //    A literal `recipientEmail` (e.g. the ops/admin inbox) bypasses the user
  //    lookup; otherwise resolve the user by id.
  let toEmail: string;
  let recipientName: string;
  if (payload.recipientEmail) {
    toEmail = payload.recipientEmail;
    recipientName = 'team';
  } else {
    const user = await usersRepository.findById(payload.recipientId);
    if (!user?.email) {
      log.warn({ recipientId: payload.recipientId }, 'No email for recipient');
      await logNotification(payload, 'email', 'skipped', 'No email address');
      return;
    }
    toEmail = user.email;
    recipientName = user.firstName ?? 'there';
  }

  // 2. Render template
  const { component, subject } = getEmailTemplate(payload.template, {
    ...payload.data,
    ...payload.payload,
    recipientName,
  });

  const html = await render(component);

  // 3. Send via Brevo
  try {
    const client = await getBrevoClient();

    // BAL-386: resolve any R2-backed attachments to base64 BEFORE sending. A read
    // failure throws here → BullMQ retries; the non-attachment path passes undefined
    // and is unchanged.
    const attachment = await resolveAttachments(payload);

    const result = await client.transactionalEmails.sendTransacEmail({
      htmlContent: html,
      sender: {
        email: process.env.BREVO_SENDER_EMAIL ?? 'notifications@balo.expert',
        name: 'Balo',
      },
      subject,
      to: [{ email: toEmail, name: recipientName }],
      ...(attachment ? { attachment } : {}),
    });
    const messageId = result?.messageId;

    await logNotification(payload, 'email', 'sent', undefined, {
      brevoMessageId: messageId,
    });
    log.info({ template: payload.template, to: toEmail, messageId }, 'Email sent');
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

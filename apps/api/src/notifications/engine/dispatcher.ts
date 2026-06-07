import { createLogger } from '@balo/shared/logging';
import { getQueue } from '../../lib/queue.js';
import type { NotificationChannel, NotificationRule, RuleContext } from './rules.js';

const log = createLogger('notification-dispatcher');

/** Maps each notification channel to its BullMQ queue name. */
const CHANNEL_QUEUES: Record<NotificationChannel, string> = {
  email: 'notification-email',
  sms: 'notification-sms',
  'in-app': 'notification-in-app',
};

export async function dispatch(rule: NotificationRule, context: RuleContext): Promise<void> {
  // 1. Evaluate condition
  if (rule.condition && !rule.condition(context)) {
    log.debug({ template: rule.template }, 'Rule condition not met, skipping');
    return;
  }

  // 2. Resolve recipient. The `admin` recipient is special: it routes to a
  //    configured ops inbox (a bare email, not a user). For the email channel we
  //    resolve it to OPS_NOTIFICATION_EMAIL and bypass the user lookup downstream.
  let recipientId = resolveRecipient(rule.recipient, context);
  let recipientEmail: string | undefined;

  if (rule.recipient === 'admin' && rule.channel === 'email') {
    const opsEmail = process.env.OPS_NOTIFICATION_EMAIL;
    if (!opsEmail) {
      log.warn(
        { template: rule.template, event: context.event },
        'OPS_NOTIFICATION_EMAIL not configured — skipping admin notification'
      );
      return;
    }
    recipientEmail = opsEmail;
    // Use the ops email as the recipient identifier for dedup + logging since
    // there is no user id for an ops inbox.
    recipientId = opsEmail;
  }

  if (!recipientId) {
    log.warn(
      { template: rule.template, recipient: rule.recipient, event: context.event },
      'Could not resolve recipient — skipping dispatch'
    );
    return;
  }

  // 3. Build delivery payload
  const deliveryPayload = {
    recipientId,
    recipientEmail,
    template: rule.template,
    event: context.event,
    data: context.data,
    payload: context.payload,
  };

  // 4. Route to the correct channel queue with deterministic job ID for dedup
  const queueName = CHANNEL_QUEUES[rule.channel];
  const channelQueue = getQueue(queueName);
  const jobId = `${rule.template}--${recipientId}--${context.payload.correlationId}`;

  await channelQueue.add(rule.template, deliveryPayload, {
    jobId,
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
  });

  log.info(
    { channel: rule.channel, template: rule.template, recipientId },
    'Notification dispatched'
  );
}

function resolveRecipient(
  recipient: NotificationRule['recipient'],
  context: RuleContext
): string | undefined {
  switch (recipient) {
    case 'self': {
      const userId = context.payload.userId;
      return typeof userId === 'string' ? userId : undefined;
    }
    case 'expert': {
      const expert = context.data.expert as { user?: { id?: string } } | undefined;
      return expert?.user?.id;
    }
    case 'client': {
      const recipientId = context.payload.recipientId;
      if (typeof recipientId === 'string') return recipientId;
      const client = context.data.client as { id?: string } | undefined;
      return client?.id;
    }
    case 'admin':
      // Future: resolve admin user IDs from config or DB
      return undefined;
    default:
      return undefined;
  }
}

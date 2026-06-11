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

/**
 * Recipient kinds that resolve to a LIST of user ids (BAL-289). The dispatcher
 * fans these out into one delivery row per id, rather than the single-recipient
 * path used by everything else.
 */
const FANOUT_RECIPIENTS = new Set<NotificationRule['recipient']>([
  'non_selected_experts',
  'admins',
]);

/**
 * Build the delivery payload + job options and enqueue one channel job for a
 * single resolved recipient. Shared by both the single-recipient path and the
 * fan-out branch so dedup keys, retry policy, and logging stay identical.
 */
async function enqueueDelivery(
  rule: NotificationRule,
  context: RuleContext,
  recipientId: string,
  recipientEmail?: string
): Promise<void> {
  const deliveryPayload = {
    recipientId,
    recipientEmail,
    template: rule.template,
    event: context.event,
    data: context.data,
    payload: context.payload,
  };

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

export async function dispatch(rule: NotificationRule, context: RuleContext): Promise<void> {
  // 1. Evaluate condition
  if (rule.condition && !rule.condition(context)) {
    log.debug({ template: rule.template }, 'Rule condition not met, skipping');
    return;
  }

  // 1b. Fan-out recipients (BAL-289): resolve a list of user ids and enqueue one
  //     delivery per id, then return. This is additive — the single-recipient
  //     path below is unchanged for every other recipient kind.
  if (FANOUT_RECIPIENTS.has(rule.recipient)) {
    const recipientIds = resolveRecipientIds(rule.recipient, context);
    if (recipientIds.length === 0) {
      log.debug(
        { template: rule.template, recipient: rule.recipient, event: context.event },
        'No fan-out recipients resolved — skipping dispatch'
      );
      return;
    }
    for (const recipientId of recipientIds) {
      await enqueueDelivery(rule, context, recipientId);
    }
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

  // 3. Build the delivery payload + enqueue (deterministic job ID for dedup).
  await enqueueDelivery(rule, context, recipientId, recipientEmail);
}

/**
 * Resolve a fan-out recipient kind (BAL-289) to its list of user ids from the
 * hydrated context. Non-fan-out kinds return `[]` so the dispatcher never reaches
 * this from the single-recipient path. Non-string entries are filtered out
 * defensively.
 */
function resolveRecipientIds(
  recipient: NotificationRule['recipient'],
  context: RuleContext
): string[] {
  let source: unknown;
  switch (recipient) {
    case 'admins':
      source = context.data.adminUserIds;
      break;
    case 'non_selected_experts':
      source = context.data.nonSelectedExpertUserIds;
      break;
    default:
      return [];
  }
  if (!Array.isArray(source)) return [];
  return source.filter((id): id is string => typeof id === 'string');
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

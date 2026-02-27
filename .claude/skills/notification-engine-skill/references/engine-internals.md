# Engine Internals — Balo Notification Engine

## File Structure

```
packages/api/src/lib/notifications/
├── publisher.ts              # Event publishing (see event-publishing.md)
├── events.ts                 # Event registry (see event-publishing.md)
├── engine/
│   ├── worker.ts             # BullMQ worker — event processor
│   ├── rules.ts              # Event → notification rules mapping
│   ├── resolver.ts           # Hydrates data, evaluates conditions
│   ├── dispatcher.ts         # Creates per-channel delivery jobs
│   └── preferences.ts        # User notification preferences
├── channels/                 # Channel adapters (see channel-adapters.md)
│   ├── email.adapter.ts
│   ├── sms.adapter.ts
│   ├── in-app.adapter.ts
│   └── types.ts
└── index.ts
```

## Rules Configuration

Rules are the heart of the engine. They map events to notification deliveries.

### Rule Shape

```ts
// engine/rules.ts

export interface NotificationRule {
  /** Which channel to deliver on */
  channel: 'email' | 'sms' | 'in-app' | 'push';

  /** Who receives it — role-based, resolved from event payload */
  recipient: 'expert' | 'client' | 'admin' | 'both';

  /** Template identifier for this channel */
  template: string;

  /** When to deliver */
  timing:
    | 'immediate'
    | {
        type: 'before';
        /** Which payload field holds the anchor datetime */
        anchor: string;
        /** Minutes before the anchor to deliver */
        minutes: number;
      };

  /** Optional condition — evaluated at processing time */
  condition?: (context: RuleContext) => boolean;

  /** Priority: 'critical' skips user preference checks */
  priority?: 'normal' | 'critical';
}

export interface RuleContext {
  event: string;
  payload: Record<string, any>;
  /** Hydrated user/booking/case data */
  data: Record<string, any>;
  /** Computed helpers */
  minutesUntilAnchor?: number;
  recipientIsOnline?: boolean;
}
```

### Rules Registry

```ts
// engine/rules.ts

import type { NotificationRule } from './types';

export const notificationRules: Record<string, NotificationRule[]> = {
  // ──────────────────────────────────
  // BOOKING
  // ──────────────────────────────────

  'booking.confirmed': [
    {
      channel: 'email',
      recipient: 'expert',
      template: 'booking-confirmed-expert',
      timing: 'immediate',
    },
    {
      channel: 'email',
      recipient: 'client',
      template: 'booking-confirmed-client',
      timing: 'immediate',
    },
    {
      channel: 'in-app',
      recipient: 'expert',
      template: 'booking-confirmed',
      timing: 'immediate',
    },
    {
      channel: 'email',
      recipient: 'both',
      template: 'booking-reminder',
      timing: { type: 'before', anchor: 'scheduledAt', minutes: 30 },
    },
    {
      channel: 'sms',
      recipient: 'expert',
      template: 'booking-urgent-sms',
      timing: 'immediate',
      condition: (ctx) => (ctx.minutesUntilAnchor ?? Infinity) < 120,
    },
  ],

  'booking.cancelled': [
    {
      channel: 'email',
      recipient: 'expert',
      template: 'booking-cancelled-expert',
      timing: 'immediate',
      // Only notify expert if client cancelled (and vice versa)
      condition: (ctx) => ctx.payload.cancelledBy === 'client',
    },
    {
      channel: 'email',
      recipient: 'client',
      template: 'booking-cancelled-client',
      timing: 'immediate',
      condition: (ctx) => ctx.payload.cancelledBy === 'expert',
    },
    {
      channel: 'in-app',
      recipient: 'both',
      template: 'booking-cancelled',
      timing: 'immediate',
    },
  ],

  // ──────────────────────────────────
  // CASES
  // ──────────────────────────────────

  'case.created': [
    {
      channel: 'email',
      recipient: 'expert',
      template: 'case-created-expert',
      timing: 'immediate',
    },
    {
      channel: 'in-app',
      recipient: 'expert',
      template: 'case-created',
      timing: 'immediate',
    },
  ],

  'case.escalated': [
    {
      channel: 'email',
      recipient: 'admin',
      template: 'case-escalated-admin',
      timing: 'immediate',
      priority: 'critical', // Skips preference check
    },
    {
      channel: 'email',
      recipient: 'expert',
      template: 'case-escalated-expert',
      timing: 'immediate',
    },
    {
      channel: 'in-app',
      recipient: 'both',
      template: 'case-escalated',
      timing: 'immediate',
    },
  ],

  'case.resolved': [
    {
      channel: 'email',
      recipient: 'client',
      template: 'case-resolved-client',
      timing: 'immediate',
    },
    {
      channel: 'in-app',
      recipient: 'both',
      template: 'case-resolved',
      timing: 'immediate',
    },
  ],

  // ──────────────────────────────────
  // PAYMENTS
  // ──────────────────────────────────

  'payment.succeeded': [
    {
      channel: 'email',
      recipient: 'client',
      template: 'payment-receipt',
      timing: 'immediate',
      priority: 'critical', // Receipts always sent
    },
  ],

  'payment.failed': [
    {
      channel: 'email',
      recipient: 'client',
      template: 'payment-failed',
      timing: 'immediate',
      priority: 'critical',
    },
    {
      channel: 'in-app',
      recipient: 'client',
      template: 'payment-failed',
      timing: 'immediate',
    },
  ],

  'payout.completed': [
    {
      channel: 'email',
      recipient: 'expert',
      template: 'payout-completed',
      timing: 'immediate',
    },
    {
      channel: 'in-app',
      recipient: 'expert',
      template: 'payout-completed',
      timing: 'immediate',
    },
  ],

  // ──────────────────────────────────
  // USER LIFECYCLE
  // ──────────────────────────────────

  'user.welcome': [
    {
      channel: 'email',
      recipient: 'client', // recipient is the user themselves
      template: 'welcome',
      timing: 'immediate',
      priority: 'critical',
    },
  ],

  'expert.approved': [
    {
      channel: 'email',
      recipient: 'expert',
      template: 'expert-approved',
      timing: 'immediate',
    },
  ],

  'review.submitted': [
    {
      channel: 'email',
      recipient: 'expert',
      template: 'review-received',
      timing: 'immediate',
    },
    {
      channel: 'in-app',
      recipient: 'expert',
      template: 'review-received',
      timing: 'immediate',
    },
  ],

  // ──────────────────────────────────
  // MESSAGES
  // ──────────────────────────────────

  'message.received': [
    {
      channel: 'in-app',
      recipient: 'client', // recipient resolved from payload.recipientId
      template: 'new-message',
      timing: 'immediate',
    },
    {
      channel: 'email',
      recipient: 'client',
      template: 'new-message-email',
      timing: 'immediate',
      // Only email if the recipient is offline
      condition: (ctx) => !ctx.recipientIsOnline,
    },
  ],
};
```

## Event Worker

The main BullMQ worker that processes published events.

```ts
// engine/worker.ts

import { Worker, Queue } from 'bullmq';
import { redis } from '@/lib/redis';
import { notificationRules } from './rules';
import { resolveContext } from './resolver';
import { dispatch } from './dispatcher';
import { logger } from '@/lib/logger';

// Channel-specific delivery queues
export const emailQueue = new Queue('notification-email', { connection: redis });
export const smsQueue = new Queue('notification-sms', { connection: redis });
export const inAppQueue = new Queue('notification-in-app', { connection: redis });

const worker = new Worker(
  'notification-events',
  async (job) => {
    const { event, payload } = job.data;

    logger.info({ event, correlationId: payload.correlationId }, 'Processing notification event');

    // 1. Look up rules for this event
    const rules = notificationRules[event];
    if (!rules || rules.length === 0) {
      logger.warn({ event }, 'No notification rules found for event');
      return;
    }

    // 2. Hydrate context (load users, compute helpers)
    const context = await resolveContext(event, payload);

    // 3. Evaluate each rule and dispatch
    for (const rule of rules) {
      try {
        await dispatch(rule, context);
      } catch (error) {
        logger.error({ event, rule: rule.template, error }, 'Failed to dispatch notification rule');
        // Individual rule failure doesn't fail the whole event
      }
    }
  },
  {
    connection: redis,
    concurrency: 10,
  }
);

worker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, error: err.message }, 'Notification event processing failed');
});
```

## Context Resolver

Hydrates event payloads with actual data from the database.

```ts
// engine/resolver.ts

import { db } from '@/lib/db';
import { users, experts, bookings, cases, companies } from '@balo/db/schema';
import { eq } from 'drizzle-orm';
import type { RuleContext } from './types';

export async function resolveContext(
  event: string,
  payload: Record<string, any>
): Promise<RuleContext> {
  const data: Record<string, any> = {};

  // Hydrate users
  if (payload.expertId) {
    data.expert = await db.query.experts.findFirst({
      where: eq(experts.id, payload.expertId),
      with: { user: true },
    });
  }
  if (payload.clientId) {
    data.client = await db.query.users.findFirst({
      where: eq(users.id, payload.clientId),
    });
  }
  if (payload.companyId) {
    data.company = await db.query.companies.findFirst({
      where: eq(companies.id, payload.companyId),
    });
  }

  // Hydrate the primary entity
  if (payload.bookingId) {
    data.booking = await db.query.bookings.findFirst({
      where: eq(bookings.id, payload.bookingId),
    });
  }
  if (payload.caseId) {
    data.case = await db.query.cases.findFirst({
      where: eq(cases.id, payload.caseId),
    });
  }

  // Compute timing helpers
  let minutesUntilAnchor: number | undefined;
  if (payload.scheduledAt) {
    const scheduledMs = new Date(payload.scheduledAt).getTime();
    minutesUntilAnchor = Math.floor((scheduledMs - Date.now()) / 60_000);
  }

  return {
    event,
    payload,
    data,
    minutesUntilAnchor,
    recipientIsOnline: payload.isRecipientOnline ?? false,
  };
}
```

## Dispatcher

Evaluates conditions, checks preferences, creates channel-specific delivery jobs.

```ts
// engine/dispatcher.ts

import type { NotificationRule, RuleContext } from './types';
import { emailQueue, smsQueue, inAppQueue } from './worker';
import { checkUserPreference } from './preferences';
import { logger } from '@/lib/logger';

export async function dispatch(rule: NotificationRule, context: RuleContext): Promise<void> {
  // 1. Evaluate condition
  if (rule.condition && !rule.condition(context)) {
    logger.debug({ template: rule.template }, 'Rule condition not met, skipping');
    return;
  }

  // 2. Resolve recipient(s)
  const recipientIds = resolveRecipients(rule.recipient, context);

  for (const recipientId of recipientIds) {
    // 3. Check user preferences (unless critical)
    if (rule.priority !== 'critical') {
      const allowed = await checkUserPreference(recipientId, rule.channel, context.event);
      if (!allowed) {
        logger.debug({ recipientId, channel: rule.channel }, 'User opted out, skipping');
        continue;
      }
    }

    // 4. Build delivery job
    const deliveryPayload = {
      recipientId,
      template: rule.template,
      event: context.event,
      data: context.data,
      payload: context.payload,
    };

    // 5. Calculate delay for scheduled notifications
    const delay = calculateDelay(rule.timing, context);

    // 6. Add to channel queue
    const queue = getQueueForChannel(rule.channel);
    const jobId = `${rule.template}:${recipientId}:${context.payload.correlationId}`;

    await queue.add(rule.template, deliveryPayload, {
      jobId, // Deduplication — same job ID = won't duplicate
      delay,
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
    });

    logger.info(
      {
        channel: rule.channel,
        template: rule.template,
        recipientId,
        delay,
      },
      'Notification dispatched'
    );
  }
}

function resolveRecipients(
  recipient: NotificationRule['recipient'],
  context: RuleContext
): string[] {
  switch (recipient) {
    case 'expert':
      return context.data.expert?.user?.id ? [context.data.expert.user.id] : [];
    case 'client':
      // For 'message.received', use the explicit recipientId
      if (context.payload.recipientId) return [context.payload.recipientId];
      return context.data.client?.id ? [context.data.client.id] : [];
    case 'both':
      return [context.data.expert?.user?.id, context.data.client?.id].filter(Boolean) as string[];
    case 'admin':
      // TODO: resolve admin user IDs from config or DB
      return []; // Placeholder
    default:
      return [];
  }
}

function calculateDelay(timing: NotificationRule['timing'], context: RuleContext): number {
  if (timing === 'immediate') return 0;

  const anchorValue = context.payload[timing.anchor];
  if (!anchorValue) return 0;

  const anchorMs = new Date(anchorValue).getTime();
  const deliverAt = anchorMs - timing.minutes * 60_000;
  const delay = deliverAt - Date.now();

  // If the delivery time has already passed, deliver immediately
  return Math.max(delay, 0);
}

function getQueueForChannel(channel: string) {
  switch (channel) {
    case 'email':
      return emailQueue;
    case 'sms':
      return smsQueue;
    case 'in-app':
      return inAppQueue;
    default:
      return inAppQueue;
  }
}
```

## User Preferences

Users can opt out of non-critical notification channels.

```ts
// engine/preferences.ts

import { db } from '@/lib/db';
import { notificationPreferences } from '@balo/db/schema';
import { and, eq } from 'drizzle-orm';

/**
 * Check if a user wants to receive this type of notification on this channel.
 * Returns true if no preference is set (opt-out model, not opt-in).
 */
export async function checkUserPreference(
  userId: string,
  channel: string,
  event: string
): Promise<boolean> {
  // Extract the event category (e.g., 'booking' from 'booking.confirmed')
  const category = event.split('.')[0];

  const pref = await db.query.notificationPreferences.findFirst({
    where: and(
      eq(notificationPreferences.userId, userId),
      eq(notificationPreferences.channel, channel),
      eq(notificationPreferences.category, category)
    ),
  });

  // No preference = opted in (default)
  if (!pref) return true;

  return pref.enabled;
}
```

### Preferences Schema (for drizzle-schema skill)

```ts
export const notificationPreferences = pgTable(
  'notification_preferences',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    channel: varchar('channel', { length: 20 }).notNull(), // 'email' | 'sms' | 'in-app'
    category: varchar('category', { length: 50 }).notNull(), // 'booking' | 'case' | 'payment' | 'message'
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    uniqueUserChannelCategory: unique().on(table.userId, table.channel, table.category),
  })
);
```

## Scheduling Patterns

### Reminders via Delayed Jobs

When a booking is confirmed, the engine creates a delayed job for the reminder:

```
Event: booking.confirmed (scheduledAt: "2026-02-27T14:00:00Z")
Rule: reminder 30 min before

Now: 2026-02-27T10:00:00Z
Anchor: 2026-02-27T14:00:00Z
Deliver at: 2026-02-27T13:30:00Z
Delay: 3.5 hours (12,600,000ms)

BullMQ holds the job and processes it at 13:30.
```

### Cancelling Scheduled Notifications

If a booking is cancelled, you need to remove the pending reminder. Use the deterministic job ID:

```ts
// When a booking is cancelled, remove its pending reminders
async function cancelPendingNotifications(bookingId: string) {
  const jobPatterns = [`booking-reminder:*:${bookingId}`];

  // BullMQ doesn't support wildcard removal, so we use specific job IDs
  // The dispatcher creates jobs with ID: `${template}:${recipientId}:${correlationId}`
  // We need to know the recipientIds to remove specific jobs

  const booking = await db.query.bookings.findFirst({
    where: eq(bookings.id, bookingId),
    with: { expert: { with: { user: true } } },
  });

  if (!booking) return;

  const recipientIds = [booking.expert.user.id, booking.clientId];

  for (const recipientId of recipientIds) {
    const jobId = `booking-reminder:${recipientId}:${bookingId}`;
    const job = await emailQueue.getJob(jobId);
    if (job) await job.remove();
  }
}
```

## Dead Letter Queue

Failed notifications after all retries go to a DLQ for manual review:

```ts
// In worker setup
const emailWorker = new Worker('notification-email', processor, {
  connection: redis,
  settings: {
    backoffStrategy: (attemptsMade) => {
      // 2s, 4s, 8s
      return Math.min(2000 * Math.pow(2, attemptsMade - 1), 30000);
    },
  },
});

emailWorker.on('failed', async (job, err) => {
  if (job && job.attemptsMade >= (job.opts.attempts ?? 3)) {
    // All retries exhausted — move to DLQ
    const dlq = new Queue('notification-dlq', { connection: redis });
    await dlq.add('failed-notification', {
      originalQueue: 'notification-email',
      jobData: job.data,
      error: err.message,
      failedAt: new Date().toISOString(),
    });

    logger.error(
      {
        template: job.data.template,
        recipientId: job.data.recipientId,
        error: err.message,
      },
      'Notification permanently failed — moved to DLQ'
    );
  }
});
```

## Observability

Every notification attempt should be logged to a `notification_log` table for debugging and audit:

```ts
export const notificationLog = pgTable(
  'notification_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    event: varchar('event', { length: 100 }).notNull(),
    correlationId: uuid('correlation_id').notNull(),
    recipientId: uuid('recipient_id').notNull(),
    channel: varchar('channel', { length: 20 }).notNull(),
    template: varchar('template', { length: 100 }).notNull(),
    status: varchar('status', { length: 20 }).notNull(), // 'sent' | 'failed' | 'skipped' | 'opted_out'
    error: text('error'),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    idxCorrelation: index().on(table.correlationId),
    idxRecipient: index().on(table.recipientId),
    idxCreatedAt: index().on(table.createdAt),
  })
);
```

This lets you answer: "Did the expert get notified about booking X?" — just query by correlationId.

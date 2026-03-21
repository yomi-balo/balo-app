# Channel Adapters — Balo Notification Engine

## Adapter Interface

Every channel implements the same interface. This is what makes channels swappable.

```ts
// engine/rules.ts — the channel type lives here, shared by rules, dispatcher, and log helper
export type NotificationChannel = 'email' | 'sms' | 'in-app';

// channels/types.ts — delivery payload passed to each adapter's BullMQ worker
export interface DeliveryPayload {
  recipientId: string;
  template: string;
  event: string;
  data: Record<string, unknown>; // Hydrated entities (expert, client, booking, etc.)
  payload: Record<string, unknown>; // Original event payload
}

export interface DeliveryResult {
  success: boolean;
  provider: string;
  providerMessageId?: string;
  error?: string;
}
```

Each channel is implemented as a BullMQ worker on its own queue (`notification-email`, `notification-sms`, `notification-in-app`). The dispatcher routes based on `rule.channel` via the `CHANNEL_QUEUES` map. Each adapter calls `logNotification(payload, channel, status)` with its own channel constant.

## Email Adapter (Brevo + React Email)

Email delivery uses **Brevo** (`@getbrevo/brevo`) as the transport and **React Email** (`@react-email/render`) for HTML generation. Templates are JSX components compiled to HTML at send time — do NOT use Brevo's template builder.

```ts
// channels/email.adapter.ts

import { Worker } from 'bullmq';
import * as brevo from '@getbrevo/brevo';
import { render } from '@react-email/render';
import { redis } from '@/lib/redis';
import { db } from '@/lib/db';
import { notificationLog, users } from '@balo/db/schema';
import { eq } from 'drizzle-orm';
import { getEmailTemplate } from './templates';
import { logger } from '@/lib/logger';
import type { DeliveryPayload } from './types';

const brevoClient = new brevo.TransactionalEmailsApi();
brevoClient.setApiKey(brevo.TransactionalEmailsApiApiKeys.apiKey, process.env.BREVO_API_KEY!);

const FROM_EMAIL = process.env.BREVO_SENDER_EMAIL ?? 'notifications@balo.expert';
const FROM_NAME = 'Balo';

const emailWorker = new Worker(
  'notification-email',
  async (job) => {
    const payload: DeliveryPayload = job.data;

    // 1. Resolve recipient email
    const user = await db.query.users.findFirst({
      where: eq(users.id, payload.recipientId),
    });

    if (!user?.email) {
      logger.warn({ recipientId: payload.recipientId }, 'No email for recipient');
      await logNotification(payload, 'skipped', 'No email address');
      return;
    }

    // 2. Render React Email template to HTML
    const { component: EmailComponent, subject } = getEmailTemplate(payload.template, {
      ...payload.data,
      ...payload.payload,
      recipientName: user.firstName ?? 'there',
    });

    const html = await render(EmailComponent);

    // 3. Send via Brevo
    try {
      const sendSmtpEmail = new brevo.SendSmtpEmail();
      sendSmtpEmail.to = [{ email: user.email, name: user.firstName ?? undefined }];
      sendSmtpEmail.sender = { email: FROM_EMAIL, name: FROM_NAME };
      sendSmtpEmail.subject = subject;
      sendSmtpEmail.htmlContent = html; // React Email output

      const result = await brevoClient.sendTransacEmail(sendSmtpEmail);
      const messageId = result.body?.messageId;

      await logNotification(payload, 'sent', undefined, { brevoMessageId: messageId });
      logger.info({ template: payload.template, to: user.email }, 'Email sent');
    } catch (error) {
      await logNotification(payload, 'failed', (error as Error).message);
      throw error; // Re-throw so BullMQ retries
    }
  },
  {
    connection: redis,
    concurrency: 5,
  }
);
```

### Email Templates

Templates are React Email JSX components. Each template module exports a component and a `subject` factory.

```ts
// channels/templates/index.ts

import React from 'react';
import { WelcomeEmail } from './welcome';
import { BookingConfirmedExpertEmail } from './booking-confirmed-expert';
import { BookingConfirmedClientEmail } from './booking-confirmed-client';

interface TemplateOutput {
  component: React.ReactElement;
  subject: string;
}

const templates: Record<string, (data: Record<string, any>) => TemplateOutput> = {
  'welcome': (data) => ({
    component: <WelcomeEmail recipientName={data.recipientName} />,
    subject: `Welcome to Balo`,
  }),

  'booking-confirmed-expert': (data) => ({
    component: <BookingConfirmedExpertEmail data={data} />,
    subject: `New booking from ${data.client?.firstName ?? 'a client'}`,
  }),

  'booking-confirmed-client': (data) => ({
    component: <BookingConfirmedClientEmail data={data} />,
    subject: `Consultation confirmed with ${data.expert?.user?.firstName ?? 'your expert'}`,
  }),

  'booking-reminder': (data) => ({
    component: <BookingReminderEmail data={data} />,
    subject: `Reminder: Your consultation starts in 30 minutes`,
  }),

  'payment-receipt': (data) => ({
    component: <PaymentReceiptEmail data={data} />,
    subject: `Payment receipt — $${(data.payload.amountCents / 100).toFixed(2)}`,
  }),
};

export function getEmailTemplate(templateName: string, data: Record<string, any>): TemplateOutput {
  const factory = templates[templateName];
  if (!factory) {
    throw new Error(`Unknown email template: ${templateName}`);
  }
  return factory(data);
}
```

### React Email Component Pattern

```tsx
// channels/templates/booking-confirmed-expert.tsx
import {
  Html,
  Head,
  Body,
  Container,
  Section,
  Heading,
  Text,
  Button,
} from '@react-email/components';

interface Props {
  data: Record<string, any>;
}

export function BookingConfirmedExpertEmail({ data }: Props) {
  const clientName = data.client?.firstName ?? 'A client';
  const date = formatDate(data.payload.scheduledAt);

  return (
    <Html>
      <Head />
      <Body style={{ fontFamily: 'Inter, sans-serif', background: '#f8fafc' }}>
        <Container style={{ maxWidth: 560, margin: '0 auto', padding: '40px 20px' }}>
          <Heading style={{ fontSize: 20, fontWeight: 600 }}>New booking</Heading>
          <Text>{clientName} has booked a consultation with you.</Text>

          <Section
            style={{
              background: '#fff',
              borderRadius: 12,
              padding: 24,
              border: '1px solid #e2e8f0',
            }}
          >
            <Text>
              <strong>Date:</strong> {date}
            </Text>
            <Text>
              <strong>Duration:</strong> {data.payload.durationMinutes} minutes
            </Text>
          </Section>

          <Button
            href={`https://balo.expert/cases/${data.payload.caseId ?? ''}`}
            style={{
              background: '#2563EB',
              color: '#fff',
              padding: '12px 24px',
              borderRadius: 8,
              marginTop: 16,
            }}
          >
            View Booking
          </Button>
        </Container>
      </Body>
    </Html>
  );
}
```

### Required env vars

```
BREVO_API_KEY=         # Brevo API key (transactional email)
BREVO_SENDER_EMAIL=    # From address, e.g. notifications@balo.expert (optional — defaults to notifications@balo.expert)
```

## In-App Notification Adapter

> **Status:** Not yet implemented — see BAL-224 for the full ticket.

Writes to a `user_notifications` table via the repository pattern. The frontend reads via polling (or Ably in future).

```ts
// channels/in-app.adapter.ts

import { Worker, type Job } from 'bullmq';
import { createRequire } from 'node:module';
import { createLogger } from '@balo/shared/logging';
import { createRedisConnection } from '../../lib/redis.js';
import { logNotification } from './log.js';
import { getInAppTemplate } from './in-app-templates.js';
import type { DeliveryPayload } from './types.js';

const log = createLogger('notification-in-app');

export async function processInAppJob(job: Job<DeliveryPayload>): Promise<void> {
  const payload = job.data;
  const { userNotificationsRepository } = createRequire(import.meta.url)('@balo/db');

  const rendered = getInAppTemplate(payload.template, {
    ...payload.data,
    ...payload.payload,
  });

  await userNotificationsRepository.insert({
    userId: payload.recipientId,
    event: payload.event,
    title: rendered.title,
    body: rendered.body,
    actionUrl: rendered.actionUrl ?? null,
    metadata: {
      correlationId: payload.payload.correlationId,
      template: payload.template,
    },
  });

  await logNotification(payload, 'in-app', 'sent');
  log.info(
    { template: payload.template, recipientId: payload.recipientId },
    'In-app notification created'
  );
}

export function startInAppWorker(): Worker<DeliveryPayload> {
  const worker = new Worker<DeliveryPayload>('notification-in-app', processInAppJob, {
    connection: createRedisConnection(),
    concurrency: 20, // DB writes are fast
  });

  worker.on('failed', (job, err) => {
    log.error(
      { jobId: job?.id, template: job?.data?.template, error: err.message },
      'In-app worker job failed'
    );
  });

  return worker;
}
```

### In-App Notifications Schema

> Table name is `user_notifications` (not `notifications`) to avoid confusion with `notification_log`.

```ts
// packages/db/src/schema/user-notifications.ts

export const userNotifications = pgTable(
  'user_notifications',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    event: varchar('event', { length: 100 }).notNull(),
    title: varchar('title', { length: 255 }).notNull(),
    body: text('body'),
    actionUrl: varchar('action_url', { length: 500 }),
    metadata: jsonb('metadata'),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => ({
    idxUserUnread: index().on(table.userId, table.readAt),
    idxCreatedAt: index().on(table.createdAt),
  })
);
```

### In-App Template Renderer

```ts
// channels/in-app-templates.ts

interface InAppOutput {
  title: string;
  body: string;
  actionUrl?: string;
}

const inAppTemplates: Record<string, (data: Record<string, unknown>) => InAppOutput> = {
  'booking-confirmed': (data) => ({
    title: 'New booking',
    body: `${(data.client as any)?.firstName ?? 'A client'} booked a consultation`,
    actionUrl: `/cases/${data.caseId ?? ''}`,
  }),

  'new-message': (data) => ({
    title: 'New message',
    body: 'You have a new message in your consultation',
    actionUrl: `/cases/${data.caseId}`,
  }),
};

export function getInAppTemplate(templateName: string, data: Record<string, unknown>): InAppOutput {
  const factory = inAppTemplates[templateName];
  if (!factory) {
    return { title: 'Notification', body: 'You have a new notification' };
  }
  return factory(data);
}
```

### Frontend: Notification Bell

```tsx
// components/balo/notification-bell.tsx
'use client';

import { Bell } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

export function NotificationBell() {
  const { data: notifications } = useQuery({
    queryKey: ['notifications', 'unread'],
    queryFn: () => fetch('/api/notifications?unread=true').then((r) => r.json()),
    refetchInterval: 30_000, // Poll every 30s
  });

  const unreadCount = notifications?.length ?? 0;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className="hover:bg-muted relative rounded-lg p-2 transition-colors">
          <Bell className="text-muted-foreground h-5 w-5" />
          {unreadCount > 0 && (
            <span className="bg-destructive text-destructive-foreground absolute -top-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-semibold">
              {unreadCount > 9 ? '9+' : unreadCount}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <NotificationList notifications={notifications ?? []} />
      </PopoverContent>
    </Popover>
  );
}
```

## SMS Adapter (Brevo SMS)

> **Status:** Not yet implemented — see BAL-223 for the full ticket.

SMS delivery uses **Brevo** (`@getbrevo/brevo`) — the same vendor as email, so no new dependency is needed. Templates are plain-text functions (not React Email).

**Important:** SMS legally requires explicit user consent. Use the `condition` field on `NotificationRule` to gate SMS delivery behind an opt-in check (e.g., `condition: (ctx) => ctx.data.user?.smsOptedIn === true`).

```ts
// channels/sms.adapter.ts

import { Worker, type Job } from 'bullmq';
import { createRequire } from 'node:module';
import { createLogger } from '@balo/shared/logging';
import { createRedisConnection } from '../../lib/redis.js';
import { logNotification } from './log.js';
import { getSmsTemplate } from './sms-templates.js';
import type { DeliveryPayload } from './types.js';

const log = createLogger('notification-sms');

export async function processSmsJob(job: Job<DeliveryPayload>): Promise<void> {
  const payload = job.data;
  const { usersRepository } = createRequire(import.meta.url)('@balo/db');

  // 1. Resolve recipient phone
  const user = await usersRepository.findById(payload.recipientId);
  if (!user?.phone) {
    log.warn({ recipientId: payload.recipientId }, 'No phone number for SMS recipient');
    await logNotification(payload, 'sms', 'skipped', 'No phone number');
    return;
  }

  // 2. Render plain-text template
  const body = getSmsTemplate(payload.template, {
    ...payload.data,
    ...payload.payload,
  });

  // 3. Send via Brevo SMS API
  try {
    const { BrevoClient } = await import('@getbrevo/brevo');
    const client = new BrevoClient({ apiKey: process.env.BREVO_API_KEY! });

    await client.transactionalSMS.sendTransacSms({
      sender: process.env.BREVO_SMS_SENDER ?? 'Balo',
      recipient: user.phone,
      content: body,
    });

    await logNotification(payload, 'sms', 'sent');
    log.info({ template: payload.template, to: user.phone }, 'SMS sent');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await logNotification(payload, 'sms', 'failed', errorMessage);
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
      { jobId: job?.id, template: job?.data?.template, error: err.message },
      'SMS worker job failed'
    );
  });

  return worker;
}
```

### SMS Templates

SMS templates are plain-text functions — no JSX, no HTML.

```ts
// channels/sms-templates.ts

const smsTemplates: Record<string, (data: Record<string, unknown>) => string> = {
  'booking-urgent-sms': (data) =>
    `Balo: You have a consultation starting soon with ${(data.client as any)?.firstName ?? 'a client'}. Join at balo.expert`,
};

export function getSmsTemplate(templateName: string, data: Record<string, unknown>): string {
  const renderer = smsTemplates[templateName];
  return renderer ? renderer(data) : 'You have a notification from Balo. Visit balo.expert';
}
```

### Required env vars

```
BREVO_SMS_SENDER=    # Sender name for SMS (max 11 chars, e.g. "Balo")
```

## Shared Logging Helper

Used by all adapters. Each adapter passes its own channel explicitly — no inference from template names.

```ts
// channels/log.ts

import { createRequire } from 'node:module';
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
    const { notificationLogRepository } = createRequire(import.meta.url)('@balo/db');

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
      },
      'Failed to write notification log'
    );
  }
}
```

## Channel Routing

The dispatcher routes each rule to the correct BullMQ queue via `CHANNEL_QUEUES`:

```ts
// engine/dispatcher.ts (excerpt)

import type { NotificationChannel } from './rules.js';

const CHANNEL_QUEUES: Record<NotificationChannel, string> = {
  email: 'notification-email',
  sms: 'notification-sms',
  'in-app': 'notification-in-app',
};

// In dispatch():
const queueName = CHANNEL_QUEUES[rule.channel];
const channelQueue = getQueue(queueName);
```

Adding a new channel never touches existing adapter code — the dispatcher handles routing automatically.

## Adding a New Channel

1. Add the channel string to `NotificationChannel` type in `engine/rules.ts`
2. Add the queue mapping to `CHANNEL_QUEUES` in `engine/dispatcher.ts`
3. Create `channels/{channel}.adapter.ts` — BullMQ worker on `notification-{channel}` queue
4. Create `channels/{channel}-templates.ts` — template renderers for the new channel
5. Register `start{Channel}Worker()` in `jobs/worker.ts`
6. Add rules for existing events that should use this channel in `engine/rules.ts`
7. If the channel requires user consent (e.g., SMS), add a `condition` gate on every rule

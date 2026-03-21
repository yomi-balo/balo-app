# Channel Adapters — Balo Notification Engine

## Adapter Interface

Every channel implements the same interface. This is what makes channels swappable.

```ts
// channels/types.ts

export interface DeliveryPayload {
  recipientId: string;
  template: string;
  event: string;
  data: Record<string, any>; // Hydrated entities (expert, client, booking, etc.)
  payload: Record<string, any>; // Original event payload
}

export interface DeliveryResult {
  success: boolean;
  provider: string;
  providerMessageId?: string;
  error?: string;
}

export interface ChannelAdapter {
  channel: string;
  deliver(payload: DeliveryPayload): Promise<DeliveryResult>;
}
```

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

Writes to the `user_notifications` table. The frontend reads via polling or Ably subscription.

```ts
// channels/in-app.adapter.ts

import { Worker, type Job } from 'bullmq';
import { createRequire } from 'module';
import { createLogger } from '@balo/shared/logging';
import { createRedisConnection } from '../../lib/redis.js';
import { logNotification } from './log.js';
import type { DeliveryPayload } from './types.js';

const log = createLogger('notification-in-app');

export async function processInAppJob(job: Job<DeliveryPayload>): Promise<void> {
  const payload = job.data;
  const { userNotificationsRepository } = createRequire(import.meta.url)('@balo/db');

  const rendered = renderInAppNotification(payload.template, {
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

  await logNotification(payload, payload.channel, 'sent');
  log.info({ template: payload.template, recipientId: payload.recipientId }, 'In-app notification created');
}

export function startInAppWorker() {
  const worker = new Worker<DeliveryPayload>('notification-in-app', processInAppJob, {
    connection: createRedisConnection(),
    concurrency: 20, // DB writes are fast
  });

  worker.on('failed', (job, err) => {
    log.error({ jobId: job?.id, template: job?.data?.template, error: err.message }, 'In-app worker job failed');
  });

  return worker;
}
```

### In-App Schema

Add to `packages/db/src/schema/user-notifications.ts`. Use `...timestamps` and `...softDelete` helpers.

```ts
export const userNotifications = pgTable(
  'user_notifications',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    event: varchar('event', { length: 100 }).notNull(),
    title: varchar('title', { length: 255 }).notNull(),
    body: text('body'),
    actionUrl: varchar('action_url', { length: 500 }),
    metadata: jsonb('metadata'),
    readAt: timestamp('read_at', { withTimezone: true }),
    ...timestamps,
    ...softDelete,
  },
  (table) => [
    index('user_notifications_user_id_idx').on(table.userId, table.readAt),
    index('user_notifications_created_at_idx').on(table.createdAt),
  ]
);
```

### In-App Template Renderer

Plain-text templates — title, body, optional action URL.

```ts
// channels/templates/in-app-templates.ts

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
  'booking-reminder': (data) => ({
    title: 'Consultation in 30 minutes',
    body: `Your consultation is starting soon`,
    actionUrl: `/cases/${data.caseId ?? ''}`,
  }),
};

export function getInAppTemplate(template: string, data: Record<string, unknown>): InAppOutput {
  const renderer = inAppTemplates[template];
  if (!renderer) return { title: 'Notification', body: 'You have a new notification from Balo' };
  return renderer(data);
}
```

### Frontend: Notification Bell

Poll `/api/notifications?unread=true` every 30s. Future: replace polling with an Ably subscription.

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
    refetchInterval: 30_000,
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

## SMS Adapter (Brevo)

Uses the same `@getbrevo/brevo` SDK already installed. No new vendor needed.

**Consent is required by law.** Always gate SMS rules with an opt-in condition:

```ts
// In rules.ts — gate all SMS rules on explicit consent
{
  channel: 'sms',
  recipient: 'expert',
  template: 'booking-confirmed-sms',
  timing: 'immediate',
  condition: (ctx) => (ctx.data.expert as any)?.smsOptIn === true,
}
```

```ts
// channels/sms.adapter.ts

import { Worker, type Job } from 'bullmq';
import { createRequire } from 'module';
import { createLogger } from '@balo/shared/logging';
import { createRedisConnection } from '../../lib/redis.js';
import { logNotification } from './log.js';
import type { DeliveryPayload } from './types.js';

const log = createLogger('notification-sms');

export async function processSmsJob(job: Job<DeliveryPayload>): Promise<void> {
  const payload = job.data;
  const { usersRepository } = createRequire(import.meta.url)('@balo/db');

  // 1. Resolve phone number
  const user = await usersRepository.findById(payload.recipientId);
  if (!user?.phone) {
    log.warn({ recipientId: payload.recipientId }, 'No phone number for recipient');
    await logNotification(payload, payload.channel, 'skipped', 'No phone number');
    return;
  }

  // 2. Render SMS body (plain text)
  const body = getSmsTemplate(payload.template, { ...payload.data, ...payload.payload });

  // 3. Send via Brevo SMS API
  try {
    const { BrevoClient } = await import('@getbrevo/brevo');
    const client = new BrevoClient({ apiKey: process.env.BREVO_API_KEY! });

    const result = await (client as any).transactionalSms.sendTransacSms({
      sender: process.env.BREVO_SMS_SENDER ?? 'Balo',
      recipient: user.phone,
      content: body,
      type: 'transactional',
    });

    await logNotification(payload, payload.channel, 'sent', undefined, {
      brevoMessageId: result?.messageId,
    });
    log.info({ template: payload.template, to: user.phone }, 'SMS sent');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await logNotification(payload, payload.channel, 'failed', errorMessage);
    throw error; // Re-throw so BullMQ retries
  }
}

export function startSmsWorker() {
  const worker = new Worker<DeliveryPayload>('notification-sms', processSmsJob, {
    connection: createRedisConnection(),
    concurrency: 3, // SMS rate limits are tighter than email
  });

  worker.on('failed', (job, err) => {
    log.error({ jobId: job?.id, template: job?.data?.template, error: err.message }, 'SMS worker job failed');
  });

  return worker;
}
```

### SMS Templates

Plain text functions — no React Email (SMS is plain text only, 160 char limit).

```ts
// channels/templates/sms-templates.ts

const smsTemplates: Record<string, (data: Record<string, unknown>) => string> = {
  'booking-confirmed-sms': (data) =>
    `Balo: New booking with ${(data as any).clientName ?? 'a client'}. Check your dashboard.`,
  'booking-reminder-sms': (data) =>
    `Balo: Your consultation starts in 30 minutes. ${process.env.APP_URL}/cases/${(data as any).caseId}`,
};

export function getSmsTemplate(template: string, data: Record<string, unknown>): string {
  const renderer = smsTemplates[template];
  if (!renderer) throw new Error(`Unknown SMS template: ${template}`);
  return renderer(data);
}
```

### Required env vars

```
BREVO_API_KEY=          # Already used for email — same key covers SMS
BREVO_SMS_SENDER=Balo   # Sender name shown on recipient's phone (max 11 chars, alphanumeric)
```

## Shared Logging Helper

Used by all adapters. `channel` comes from `payload.channel` — never hardcode it.

```ts
// channels/log.ts — actual implementation (see source file)
// Key contract: always pass payload.channel, never a hardcoded string

await logNotification(payload, payload.channel, 'sent');
await logNotification(payload, payload.channel, 'skipped', 'No phone number');
await logNotification(payload, payload.channel, 'failed', errorMessage);
```

## Adding a New Channel — Checklist

1. Add the channel string to `NotificationChannel` in `engine/rules.ts`
2. Add the queue mapping to `CHANNEL_QUEUES` in `engine/dispatcher.ts`
3. Create `channels/{channel}.adapter.ts` — export `process{Channel}Job` and `start{Channel}Worker`
4. Register `start{Channel}Worker()` in `apps/api/src/jobs/worker.ts`
5. Create templates in `channels/templates/{channel}-templates.ts`
6. Add rules with `channel: '{channel}'` to `engine/rules.ts`
7. Write unit tests: happy path, skip (missing contact info), failure + re-throw

**Never hardcode the channel string in the adapter** — always use `payload.channel` in `logNotification` calls.


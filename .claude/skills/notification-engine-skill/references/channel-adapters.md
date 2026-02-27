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

## Email Adapter (Resend)

```ts
// channels/email.adapter.ts

import { Worker } from 'bullmq';
import { Resend } from 'resend';
import { redis } from '@/lib/redis';
import { db } from '@/lib/db';
import { notificationLog, users } from '@balo/db/schema';
import { eq } from 'drizzle-orm';
import { renderEmailTemplate } from './email-templates';
import { logger } from '@/lib/logger';
import type { DeliveryPayload } from './types';

const resend = new Resend(process.env.RESEND_API_KEY);

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

    // 2. Render template
    const { subject, html, text } = renderEmailTemplate(payload.template, {
      ...payload.data,
      ...payload.payload,
      recipientName: user.firstName ?? 'there',
    });

    // 3. Send via Resend
    try {
      const result = await resend.emails.send({
        from: 'Balo <notifications@balo.expert>',
        to: user.email,
        subject,
        html,
        text, // Plain text fallback
        tags: [
          { name: 'event', value: payload.event },
          { name: 'template', value: payload.template },
        ],
      });

      await logNotification(payload, 'sent', undefined, { resendId: result.data?.id });
      logger.info({ template: payload.template, to: user.email }, 'Email sent');
    } catch (error) {
      await logNotification(payload, 'failed', (error as Error).message);
      throw error; // Re-throw so BullMQ retries
    }
  },
  {
    connection: redis,
    concurrency: 5, // Respect Resend rate limits
  }
);
```

### Email Templates

Templates are TypeScript functions that return `{ subject, html, text }`. Keep them in one place.

```ts
// channels/email-templates/index.ts

interface EmailOutput {
  subject: string;
  html: string;
  text: string;
}

type TemplateRenderer = (data: Record<string, any>) => EmailOutput;

const templates: Record<string, TemplateRenderer> = {
  'booking-confirmed-expert': (data) => ({
    subject: `New booking from ${data.client?.firstName ?? 'a client'}`,
    html: bookingConfirmedExpertHtml(data),
    text: `You have a new booking on ${formatDate(data.payload.scheduledAt)}. Log in to Balo to view details.`,
  }),

  'booking-confirmed-client': (data) => ({
    subject: `Booking confirmed with ${data.expert?.user?.firstName ?? 'your expert'}`,
    html: bookingConfirmedClientHtml(data),
    text: `Your consultation is confirmed for ${formatDate(data.payload.scheduledAt)}.`,
  }),

  'booking-reminder': (data) => ({
    subject: `Reminder: Consultation in 30 minutes`,
    html: bookingReminderHtml(data),
    text: `Your consultation starts in 30 minutes. Join at balo.expert/cases/${data.payload.caseId}`,
  }),

  'payment-receipt': (data) => ({
    subject: `Payment receipt — $${(data.payload.amountCents / 100).toFixed(2)}`,
    html: paymentReceiptHtml(data),
    text: `Payment of $${(data.payload.amountCents / 100).toFixed(2)} confirmed. ${data.payload.description}`,
  }),

  welcome: (data) => ({
    subject: `Welcome to Balo`,
    html: welcomeHtml(data),
    text: `Welcome to Balo, ${data.recipientName}! Get started at balo.expert`,
  }),

  // ... add more templates here
};

export function renderEmailTemplate(templateName: string, data: Record<string, any>): EmailOutput {
  const renderer = templates[templateName];
  if (!renderer) {
    throw new Error(`Unknown email template: ${templateName}`);
  }
  return renderer(data);
}
```

### Email HTML Approach

Two options — pick based on complexity:

**Option A: React Email (recommended for Balo)**

```bash
pnpm add @react-email/components --filter api
```

```tsx
// channels/email-templates/booking-confirmed-expert.tsx
import {
  Html,
  Head,
  Body,
  Container,
  Section,
  Heading,
  Text,
  Button,
  Hr,
} from '@react-email/components';

export function BookingConfirmedExpertEmail({ data }: { data: Record<string, any> }) {
  const clientName = data.client?.firstName ?? 'A client';
  const date = formatDate(data.payload.scheduledAt);
  const rate = `$${(data.payload.rateCents / 100).toFixed(0)}/hr`;

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
            <Text>
              <strong>Rate:</strong> {rate}
            </Text>
          </Section>

          <Button
            href={`https://balo.expert/cases/${data.payload.caseId ?? ''}`}
            style={{
              background: '#2563EB',
              color: '#fff',
              padding: '12px 24px',
              borderRadius: 8,
              textDecoration: 'none',
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

**Option B: Simple string templates (for quick start)**

```ts
function bookingConfirmedExpertHtml(data: Record<string, any>): string {
  return `
    <div style="font-family: Inter, sans-serif; max-width: 560px; margin: 0 auto;">
      <h2>New booking</h2>
      <p>${data.client?.firstName ?? 'A client'} has booked a consultation with you.</p>
      <div style="background: #fff; border-radius: 12px; padding: 24px; border: 1px solid #e2e8f0;">
        <p><strong>Date:</strong> ${formatDate(data.payload.scheduledAt)}</p>
        <p><strong>Duration:</strong> ${data.payload.durationMinutes} minutes</p>
      </div>
      <a href="https://balo.expert/cases/${data.payload.caseId ?? ''}"
         style="display: inline-block; background: #2563EB; color: #fff; padding: 12px 24px; border-radius: 8px; text-decoration: none; margin-top: 16px;">
        View Booking
      </a>
    </div>
  `;
}
```

Start with Option B, migrate to React Email when you have 10+ templates.

## In-App Notification Adapter

Writes to a `notifications` table in Supabase. The frontend reads this via subscription or polling.

```ts
// channels/in-app.adapter.ts

import { Worker } from 'bullmq';
import { redis } from '@/lib/redis';
import { db } from '@/lib/db';
import { notifications } from '@balo/db/schema';
import { logger } from '@/lib/logger';
import type { DeliveryPayload } from './types';

const inAppWorker = new Worker(
  'notification-in-app',
  async (job) => {
    const payload: DeliveryPayload = job.data;

    const rendered = renderInAppNotification(payload.template, {
      ...payload.data,
      ...payload.payload,
    });

    await db.insert(notifications).values({
      userId: payload.recipientId,
      event: payload.event,
      title: rendered.title,
      body: rendered.body,
      actionUrl: rendered.actionUrl,
      metadata: {
        correlationId: payload.payload.correlationId,
        template: payload.template,
      },
      readAt: null,
    });

    await logNotification(payload, 'sent');
    logger.info(
      { template: payload.template, recipientId: payload.recipientId },
      'In-app notification created'
    );
  },
  {
    connection: redis,
    concurrency: 20, // DB writes are fast
  }
);
```

### In-App Notifications Schema

```ts
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    event: varchar('event', { length: 100 }).notNull(),
    title: varchar('title', { length: 255 }).notNull(),
    body: text('body'),
    actionUrl: varchar('action_url', { length: 500 }),
    metadata: jsonb('metadata'),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    idxUserUnread: index().on(table.userId, table.readAt),
    idxCreatedAt: index().on(table.createdAt),
  })
);
```

### In-App Template Renderer

```ts
interface InAppOutput {
  title: string;
  body: string;
  actionUrl?: string;
}

const inAppTemplates: Record<string, (data: Record<string, any>) => InAppOutput> = {
  'booking-confirmed': (data) => ({
    title: 'New booking',
    body: `${data.client?.firstName ?? 'A client'} booked a consultation for ${formatShortDate(data.payload.scheduledAt)}`,
    actionUrl: `/cases/${data.payload.caseId ?? ''}`,
  }),

  'case-created': (data) => ({
    title: 'New case assigned',
    body: `"${data.payload.title}" has been assigned to you`,
    actionUrl: `/cases/${data.payload.caseId}`,
  }),

  'case-resolved': (data) => ({
    title: 'Case resolved',
    body: `"${data.case?.title ?? 'Your case'}" has been marked as resolved`,
    actionUrl: `/cases/${data.payload.caseId}`,
  }),

  'payment-failed': (data) => ({
    title: 'Payment failed',
    body: `Your payment of $${(data.payload.amountCents / 100).toFixed(2)} could not be processed`,
    actionUrl: '/settings/billing',
  }),

  'new-message': (data) => ({
    title: 'New message',
    body: `You have a new message in your consultation`,
    actionUrl: `/cases/${data.payload.caseId}`,
  }),

  'review-received': (data) => ({
    title: `New ${data.payload.rating}★ review`,
    body: `You received a review for your consultation`,
    actionUrl: `/reviews`,
  }),
};

function renderInAppNotification(template: string, data: Record<string, any>): InAppOutput {
  const renderer = inAppTemplates[template];
  if (!renderer) {
    return { title: 'Notification', body: 'You have a new notification' };
  }
  return renderer(data);
}
```

### Frontend: Notification Bell

```tsx
// components/balo/notification-bell.tsx
'use client';

import { Bell } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

export function NotificationBell() {
  const { data: notifications } = useQuery({
    queryKey: ['notifications', 'unread'],
    queryFn: () => fetch('/api/notifications?unread=true').then((r) => r.json()),
    refetchInterval: 30_000, // Poll every 30s (or use Supabase Realtime)
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

## SMS Adapter (Placeholder)

SMS provider TBD. Structure ready for Twilio or alternatives.

```ts
// channels/sms.adapter.ts

import { Worker } from 'bullmq';
import { redis } from '@/lib/redis';
import { db } from '@/lib/db';
import { users } from '@balo/db/schema';
import { eq } from 'drizzle-orm';
import { logger } from '@/lib/logger';
import type { DeliveryPayload } from './types';

// TODO: Replace with actual SMS provider
// import twilio from 'twilio';
// const twilioClient = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH_TOKEN);

const smsWorker = new Worker(
  'notification-sms',
  async (job) => {
    const payload: DeliveryPayload = job.data;

    const user = await db.query.users.findFirst({
      where: eq(users.id, payload.recipientId),
    });

    if (!user?.phone) {
      logger.warn({ recipientId: payload.recipientId }, 'No phone number for SMS recipient');
      await logNotification(payload, 'skipped', 'No phone number');
      return;
    }

    const body = renderSmsTemplate(payload.template, {
      ...payload.data,
      ...payload.payload,
    });

    // TODO: Uncomment when SMS provider is configured
    // await twilioClient.messages.create({
    //   to: user.phone,
    //   from: process.env.TWILIO_PHONE_NUMBER,
    //   body,
    // });

    logger.warn({ template: payload.template }, 'SMS adapter not yet configured — skipping');
    await logNotification(payload, 'skipped', 'SMS adapter not configured');
  },
  {
    connection: redis,
    concurrency: 3,
  }
);

const smsTemplates: Record<string, (data: Record<string, any>) => string> = {
  'booking-urgent-sms': (data) =>
    `Balo: You have a consultation starting soon with ${data.client?.firstName ?? 'a client'}. Join at balo.expert`,
};

function renderSmsTemplate(template: string, data: Record<string, any>): string {
  const renderer = smsTemplates[template];
  return renderer ? renderer(data) : 'You have a notification from Balo. Visit balo.expert';
}
```

## Shared Logging Helper

Used by all adapters:

```ts
// channels/log.ts

import { db } from '@/lib/db';
import { notificationLog } from '@balo/db/schema';
import type { DeliveryPayload } from './types';

export async function logNotification(
  payload: DeliveryPayload,
  status: 'sent' | 'failed' | 'skipped' | 'opted_out',
  error?: string,
  metadata?: Record<string, any>
): Promise<void> {
  await db.insert(notificationLog).values({
    event: payload.event,
    correlationId: payload.payload.correlationId,
    recipientId: payload.recipientId,
    channel: payload.template.includes('sms')
      ? 'sms'
      : payload.template.includes('email')
        ? 'email'
        : 'in-app',
    template: payload.template,
    status,
    error,
    metadata,
  });
}
```

## Adding a New Channel

1. Create `channels/{channel}.adapter.ts` implementing the `ChannelAdapter` pattern
2. Create a new BullMQ queue in `engine/worker.ts`
3. Add the queue to `getQueueForChannel()` in `engine/dispatcher.ts`
4. Add the channel string to the `NotificationRule.channel` type
5. Add templates for the new channel
6. Update user preferences UI to include the new channel option

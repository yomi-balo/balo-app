# Event Publishing — Balo Notification Engine

## The Publisher

Lives in the shared backend package. Every feature imports this, nothing else.

```
packages/api/src/lib/notifications/
├── publisher.ts           # The publish() function
├── events.ts              # Event type registry + payload shapes
└── index.ts               # Public API
```

### publisher.ts

```ts
import { Queue } from 'bullmq';
import { redis } from '@/lib/redis';
import type { NotificationEvent, EventPayloadMap } from './events';

const notificationQueue = new Queue('notification-events', {
  connection: redis,
  defaultJobOptions: {
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000,
    },
  },
});

export const notificationEvents = {
  /**
   * Publish a domain event to the notification engine.
   * The engine resolves rules, selects channels, and delivers.
   *
   * @param event - The event type (e.g., 'booking.confirmed')
   * @param payload - Event-specific data (IDs and timestamps, not full objects)
   */
  async publish<E extends NotificationEvent>(event: E, payload: EventPayloadMap[E]): Promise<void> {
    await notificationQueue.add(
      event,
      {
        event,
        payload,
        publishedAt: new Date().toISOString(),
      },
      {
        jobId: `${event}:${(payload as any).correlationId ?? crypto.randomUUID()}`,
      }
    );
  },
};
```

### events.ts — Event Registry

This is the source of truth for all notification events. Add new events here.

```ts
// ──────────────────────────────────────────
// BOOKING EVENTS
// ──────────────────────────────────────────

export interface BookingConfirmedPayload {
  correlationId: string; // bookingId
  bookingId: string;
  expertId: string;
  clientId: string;
  companyId: string;
  scheduledAt: string; // ISO datetime
  durationMinutes: number;
  rateCents: number;
}

export interface BookingCancelledPayload {
  correlationId: string;
  bookingId: string;
  expertId: string;
  clientId: string;
  cancelledBy: 'client' | 'expert';
  reason?: string;
  scheduledAt: string;
}

export interface BookingReminderDuePayload {
  correlationId: string;
  bookingId: string;
  expertId: string;
  clientId: string;
  scheduledAt: string;
  minutesUntilStart: number;
}

// ──────────────────────────────────────────
// CASE EVENTS
// ──────────────────────────────────────────

export interface CaseCreatedPayload {
  correlationId: string; // caseId
  caseId: string;
  clientId: string;
  expertId: string;
  title: string;
}

export interface CaseEscalatedPayload {
  correlationId: string;
  caseId: string;
  clientId: string;
  expertId: string;
  escalationReason: string;
}

export interface CaseResolvedPayload {
  correlationId: string;
  caseId: string;
  clientId: string;
  expertId: string;
  resolvedBy: 'client' | 'expert';
}

// ──────────────────────────────────────────
// PAYMENT EVENTS
// ──────────────────────────────────────────

export interface PaymentSucceededPayload {
  correlationId: string; // paymentId
  paymentId: string;
  clientId: string;
  amountCents: number;
  description: string;
}

export interface PaymentFailedPayload {
  correlationId: string;
  paymentId: string;
  clientId: string;
  amountCents: number;
  failureReason: string;
}

export interface PayoutCompletedPayload {
  correlationId: string;
  payoutId: string;
  expertId: string;
  amountCents: number;
}

// ──────────────────────────────────────────
// USER EVENTS
// ──────────────────────────────────────────

export interface UserWelcomePayload {
  correlationId: string; // userId
  userId: string;
  email: string;
  firstName: string;
  role: 'client' | 'expert';
}

export interface ExpertApprovedPayload {
  correlationId: string;
  expertId: string;
  userId: string;
}

export interface ReviewSubmittedPayload {
  correlationId: string; // reviewId
  reviewId: string;
  expertId: string;
  clientId: string;
  rating: number;
  caseId: string;
}

// ──────────────────────────────────────────
// MESSAGE EVENTS
// ──────────────────────────────────────────

export interface MessageReceivedPayload {
  correlationId: string; // messageId
  messageId: string;
  caseId: string;
  senderId: string;
  recipientId: string;
  isRecipientOnline: boolean;
}

// ──────────────────────────────────────────
// EVENT TYPE UNION + PAYLOAD MAP
// ──────────────────────────────────────────

export type NotificationEvent =
  | 'booking.confirmed'
  | 'booking.cancelled'
  | 'booking.reminder_due'
  | 'case.created'
  | 'case.escalated'
  | 'case.resolved'
  | 'payment.succeeded'
  | 'payment.failed'
  | 'payout.completed'
  | 'user.welcome'
  | 'expert.approved'
  | 'review.submitted'
  | 'message.received';

export interface EventPayloadMap {
  'booking.confirmed': BookingConfirmedPayload;
  'booking.cancelled': BookingCancelledPayload;
  'booking.reminder_due': BookingReminderDuePayload;
  'case.created': CaseCreatedPayload;
  'case.escalated': CaseEscalatedPayload;
  'case.resolved': CaseResolvedPayload;
  'payment.succeeded': PaymentSucceededPayload;
  'payment.failed': PaymentFailedPayload;
  'payout.completed': PayoutCompletedPayload;
  'user.welcome': UserWelcomePayload;
  'expert.approved': ExpertApprovedPayload;
  'review.submitted': ReviewSubmittedPayload;
  'message.received': MessageReceivedPayload;
}
```

### index.ts — Public API

```ts
export { notificationEvents } from './publisher';
export type { NotificationEvent, EventPayloadMap } from './events';
```

## Publishing From Feature Code

### In a Server Action

```ts
// apps/web/src/app/(dashboard)/bookings/actions.ts
'use server';

import { withAuth } from '@/lib/auth';
import { notificationEvents } from '@balo/api/notifications';

export const confirmBooking = withAuth(async (session, bookingId: string) => {
  const booking = await db
    .update(bookings)
    .set({ status: 'confirmed', confirmedAt: new Date() })
    .where(eq(bookings.id, bookingId))
    .returning();

  // One line. That's it. The engine handles everything else.
  await notificationEvents.publish('booking.confirmed', {
    correlationId: booking.id,
    bookingId: booking.id,
    expertId: booking.expertId,
    clientId: booking.clientId,
    companyId: session.companyId,
    scheduledAt: booking.scheduledAt.toISOString(),
    durationMinutes: booking.durationMinutes,
    rateCents: booking.rateCents,
  });

  return booking;
});
```

### In a Fastify Route

```ts
// packages/api/src/routes/payments/confirm.ts
import { notificationEvents } from '@/lib/notifications';

fastify.post('/payments/confirm', async (request, reply) => {
  const payment = await processPayment(request.body);

  await notificationEvents.publish('payment.succeeded', {
    correlationId: payment.id,
    paymentId: payment.id,
    clientId: payment.clientId,
    amountCents: payment.amountCents,
    description: payment.description,
  });

  return reply.send({ success: true, paymentId: payment.id });
});
```

### In a Webhook Handler

```ts
// packages/api/src/routes/webhooks/stripe.ts
// Stripe webhook confirms payout to expert
case 'payout.paid': {
  const payout = await recordPayout(event.data.object);

  await notificationEvents.publish('payout.completed', {
    correlationId: payout.id,
    payoutId: payout.id,
    expertId: payout.expertId,
    amountCents: payout.amountCents,
  });
  break;
}
```

## Payload Design Rules

### DO include:

- `correlationId` — always, used for deduplication and job IDs
- Entity IDs (`bookingId`, `expertId`, `clientId`)
- Timestamps relevant to scheduling (`scheduledAt`)
- Numeric values needed for display (`amountCents`, `rating`)
- Short strings for subject lines (`title`, `description`)

### DON'T include:

- Full user objects (the engine hydrates from DB)
- Email addresses (the engine looks these up — keeps PII out of the queue)
- HTML or template content (the engine resolves templates)
- Channel-specific data (the engine decides channels)

```ts
// ❌ BAD — too much data, channel-specific
await notificationEvents.publish('booking.confirmed', {
  bookingId: booking.id,
  expertEmail: 'sarah@example.com', // PII in queue
  expertName: 'Sarah Chen', // Engine hydrates this
  emailSubject: 'New booking!', // Channel-specific
  emailHtml: '<h1>...</h1>', // Template content
  sendSms: true, // Channel decision
});

// ✅ GOOD — IDs and facts only
await notificationEvents.publish('booking.confirmed', {
  correlationId: booking.id,
  bookingId: booking.id,
  expertId: booking.expertId,
  clientId: booking.clientId,
  companyId: booking.companyId,
  scheduledAt: booking.scheduledAt.toISOString(),
  durationMinutes: booking.durationMinutes,
  rateCents: booking.rateCents,
});
```

## Adding a New Event

1. Define the payload interface in `events.ts`
2. Add the event string to the `NotificationEvent` union
3. Add the mapping to `EventPayloadMap`
4. Add notification rules in the rules config (see engine-internals.md)
5. Create templates for each channel (see channel-adapters.md)
6. Publish from your feature code

TypeScript enforces the contract — if you publish an event with the wrong payload shape, it won't compile.

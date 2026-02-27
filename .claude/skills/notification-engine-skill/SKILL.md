---
name: notification-engine
description: Balo's event-driven notification system. Use when building ANY feature that needs to inform users (email, SMS, in-app, or scheduled reminders). Teaches the critical pattern — feature code publishes domain events, the notification engine resolves rules, selects channels, and delivers. Feature code NEVER sends emails, SMS, or writes notification records directly. Toast remains client-side UI feedback and is NOT part of this engine.
---

# Notification Engine — Balo

## The Golden Rule

```
Feature code publishes EVENTS ("this happened").
The notification engine decides WHO gets told, HOW, and WHEN.
Feature code NEVER sends emails, SMS, or writes to the notifications table.
```

This is the single most important pattern in this skill. Every agent building user-facing features must follow it.

## Why This Exists

Without the engine, notification logic bleeds into every feature:

```tsx
// ❌ BAD — notification logic scattered in feature code
async function confirmBooking(bookingId: string) {
  const booking = await db.update(bookings).set({ status: 'confirmed' }).returning();

  // Now the feature knows about emails, SMS, templates, timing...
  await resend.emails.send({ to: expert.email, template: 'booking-confirmed' });
  await resend.emails.send({ to: client.email, template: 'booking-confirmed-client' });
  if (minutesUntilStart < 120) {
    await twilio.messages.create({ to: expert.phone, body: '...' });
  }
  await scheduledJobQueue.add('booking-reminder', { bookingId }, { delay: reminderDelay });
  await db.insert(inAppNotifications).values({ userId: expert.userId, ... });
}
```

With the engine:

```tsx
// ✅ GOOD — feature publishes event, engine handles the rest
async function confirmBooking(bookingId: string) {
  const booking = await db.update(bookings).set({ status: 'confirmed' }).returning();

  await notificationEvents.publish('booking.confirmed', {
    bookingId: booking.id,
    expertId: booking.expertId,
    clientId: booking.clientId,
    scheduledAt: booking.scheduledAt,
  });
}
```

## What IS and ISN'T the Engine

| Concern                      | Owned By                     | Example                        |
| ---------------------------- | ---------------------------- | ------------------------------ |
| Toast ("Booking confirmed!") | Client-side UI (Sonner)      | balo-ui skill, component layer |
| Email to expert              | Notification Engine          | This skill                     |
| SMS to expert                | Notification Engine          | This skill                     |
| In-app notification badge    | Notification Engine          | This skill                     |
| Scheduled reminder           | Notification Engine          | This skill                     |
| Form validation errors       | Client-side UI (FormMessage) | balo-ui skill                  |

**Toast stays in the component.** It's synchronous UI feedback — the interface acknowledging the user's action. It has nothing to do with the notification engine.

## Architecture Overview

```
Feature Code
    │
    │ publishes event
    ▼
BullMQ: notification-events queue
    │
    │ processes
    ▼
Rules Resolver
    │ looks up event → rules mapping
    │ evaluates conditions
    │ resolves recipients
    ▼
Channel Dispatcher
    │ creates per-channel delivery jobs
    ▼
┌───────────┬───────────┬───────────┬───────────┐
│  BullMQ   │  BullMQ   │  BullMQ   │  BullMQ   │
│  email    │  sms      │  in-app   │  push     │
│  queue    │  queue    │  queue    │  queue    │
└─────┬─────┴─────┬─────┴─────┬─────┴─────┬─────┘
      ▼           ▼           ▼           ▼
   Resend     Twilio*    Supabase     Future
                          insert

* SMS provider TBD — Twilio is placeholder
```

## Decision Tree

**Publishing an event from feature code?** → Read [references/event-publishing.md](references/event-publishing.md)
**Building the engine internals (rules, scheduling, retries)?** → Read [references/engine-internals.md](references/engine-internals.md)
**Adding or modifying a channel adapter (email, SMS, in-app)?** → Read [references/channel-adapters.md](references/channel-adapters.md)

## Key Rules

### ALWAYS

- ✅ Publish a domain event for any action that should notify users
- ✅ Keep event payloads minimal — IDs and timestamps, not full objects (the engine hydrates)
- ✅ Include a `correlationId` (usually the entity ID) for deduplication and tracing
- ✅ Let the rules config decide channels and timing — never hardcode in feature code
- ✅ Handle delivery failures gracefully with retries and dead-letter queues
- ✅ Log every notification attempt (sent, failed, skipped) for debugging

### NEVER

- ❌ Import Resend, Twilio, or any delivery provider in feature code
- ❌ Write to the `notifications` table from feature code
- ❌ Schedule reminder jobs from feature code — the engine handles timing
- ❌ Put notification logic in Server Actions or route handlers
- ❌ Skip the engine "just this once" for a quick email — no exceptions

## Build Incrementally

You don't need the full engine on day one. Build in this order:

1. **Event publishing + email adapter** — covers 80% of needs
2. **In-app notifications** — adds the notification bell/badge
3. **Scheduled/delayed jobs** — reminders, follow-ups
4. **SMS adapter** — urgent/time-sensitive only
5. **Rules in database** — when you have 10+ event types and want admin control
6. **User preferences** — "don't email me about X" settings

Start with rules as code (TypeScript config). Move to database when the config file gets unwieldy.

# Cronofy Push Notifications

> **Docs:** [Push Notifications API](https://docs.cronofy.com/developers/api/push-notifications/) · [notification.type values](https://docs.cronofy.com/developers/api/push-notifications/#param-notification.type)

Cronofy manages push subscription renewals to Google and Microsoft on Balo's behalf.
Balo registers one webhook URL per expert and receives notifications when their calendar changes.
On each notification, Balo recalculates `earliest_available_at` — it does NOT sync individual events.

---

## Register Push Channel (called after OAuth connect)

```typescript
import { cronofyUser } from '@/lib/cronofy';
import { db } from '@/db';
import { calendarConnections } from '@/db/schema';

export async function registerPushChannel(expertId: string, accessToken: string): Promise<void> {
  const client = cronofyUser(accessToken);

  // Close any existing channel first (idempotent reconnect)
  const existing = await db.query.calendarConnections.findFirst({
    where: eq(calendarConnections.expertId, expertId),
  });
  if (existing?.channelId) {
    await client.closeChannel({ channel_id: existing.channelId }).catch(() => {});
  }

  const { channel } = await client.createNotificationChannel({
    callback_url: `${process.env.API_BASE_URL}/webhooks/cronofy`,
    // No calendar_ids filter — notify on any calendar change
    // Cronofy will notify even when filtered calendars change
    filters: {
      only_managed: false,
    },
  });

  await db
    .update(calendarConnections)
    .set({ channelId: channel.channel_id, updatedAt: new Date() })
    .where(eq(calendarConnections.expertId, expertId));
}
```

---

## Webhook Handler

Cronofy sends a POST to `/webhooks/cronofy` when any connected expert's calendar changes.

```typescript
// POST /webhooks/cronofy
import { FastifyRequest, FastifyReply } from 'fastify';
import { rebuildAvailabilityCache } from '@/jobs/availability';

interface CronofyNotification {
  notification: {
    type: 'change' | 'verification';
    changes_since: string; // ISO timestamp
  };
  channel: {
    channel_id: string;
    callback_url: string;
  };
}

export async function handleCronofyWebhook(
  req: FastifyRequest<{ Body: CronofyNotification }>,
  reply: FastifyReply
): Promise<void> {
  // Always respond 200 immediately — Cronofy retries on non-2xx
  reply.status(200).send({ ok: true });

  const { notification, channel } = req.body;

  // Verification ping — sent when channel is first created
  if (notification.type === 'verification') return;

  // Find which expert this channel belongs to
  const connection = await db.query.calendarConnections.findFirst({
    where: eq(calendarConnections.channelId, channel.channel_id),
  });

  if (!connection) {
    // Orphaned channel — log and ignore
    console.warn('Received webhook for unknown channel:', channel.channel_id);
    return;
  }

  // Update last_synced_at
  await db
    .update(calendarConnections)
    .set({ lastSyncedAt: new Date() })
    .where(eq(calendarConnections.id, connection.id));

  // Enqueue BullMQ job to recalculate earliest_available_at
  // Do NOT recalculate synchronously — keep webhook handler fast
  await rebuildAvailabilityCacheQueue.add(
    'rebuild-availability-cache',
    { expertId: connection.expertId },
    {
      jobId: `availability-${connection.expertId}`, // deduplicates concurrent triggers
      removeOnComplete: true,
      removeOnFail: false,
    }
  );
}
```

---

## BullMQ Job: Rebuild Availability Cache

```typescript
// jobs/availability.ts
import { Worker, Queue } from 'bullmq';
import { getFreeBusySlots } from '@/services/cronofy/free-busy';

export const rebuildAvailabilityCacheQueue = new Queue('rebuild-availability-cache', {
  connection: redis,
});

export const rebuildAvailabilityCacheWorker = new Worker(
  'rebuild-availability-cache',
  async (job) => {
    const { expertId } = job.data;

    // Get the expert's next available slot
    const earliestAvailable = await calculateEarliestAvailable(expertId);

    await db
      .insert(availabilityCache)
      .values({ expertId, earliestAvailableAt: earliestAvailable, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: availabilityCache.expertId,
        set: {
          earliestAvailableAt: earliestAvailable,
          updatedAt: new Date(),
        },
      });
  },
  { connection: redis }
);

async function calculateEarliestAvailable(expertId: string): Promise<Date | null> {
  const now = new Date();
  const sixtyDaysOut = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);

  const busySlots = await getFreeBusy(expertId, now, sixtyDaysOut);

  // Walk forward in 30-min increments, find first free slot
  // that falls within the expert's availability rules (work hours)
  // This is a simplified version — the full logic lives in packages/services/calendar/
  const availabilityRule = await getAvailabilityRule(expertId);
  return findFirstFreeSlot(busySlots, availabilityRule, now, sixtyDaysOut);
}
```

---

## Notification Types — All-or-Nothing

You cannot subscribe to a subset of notification types. Once a channel is created, you receive all of:

| `notification.type`    | Meaning                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| `verification`         | Sent immediately on channel creation — respond 200 and return                                     |
| `change`               | Calendar events changed — enqueue cache rebuild                                                   |
| `profile_disconnected` | Expert revoked Cronofy's access from their Google/Outlook settings — mark `status = 'auth_error'` |
| `profile_connected`    | Calendar profile re-connected                                                                     |

Filter by `notification.type` in the webhook handler. The handler above already covers `change` and `verification`. Add these branches:

```typescript
// Inside the webhook handler switch/if chain:
case 'profile_disconnected':
  // Expert revoked Cronofy's access from their calendar provider settings
  await db
    .update(calendarConnections)
    .set({ status: 'auth_error', updatedAt: new Date() })
    .where(eq(calendarConnections.expertId, expertId));
  break;

case 'profile_connected':
  // Calendar profile re-connected (e.g. after re-authorization)
  await db
    .update(calendarConnections)
    .set({ status: 'connected', updatedAt: new Date() })
    .where(eq(calendarConnections.expertId, expertId));
  // Trigger a cache rebuild to pick up any missed changes
  await rebuildAvailabilityCacheQueue.add(
    'rebuild-availability-cache',
    { expertId },
    { jobId: `availability-${expertId}` }
  );
  break;
```

## Verification Ping

When a channel is first created, Cronofy sends a verification ping with `notification.type === 'verification'`. The handler above already handles this — respond 200 and return.

## Testing Push Notifications

Trigger test notifications from the Cronofy dashboard without waiting for real calendar activity:

1. Cronofy dashboard → Developer → Applications → your app
2. Channels tab
3. Search by account ID (the expert's Cronofy `sub`)
4. Click "Send test notification"

Use this to validate your webhook handler during development.

---

## Staleness Fallback (BullMQ cron)

Webhooks are not 100% guaranteed. Run a fallback job every 15 minutes that checks for stale connections and triggers a cache rebuild:

```typescript
// Cron: every 15 minutes
export const stalenessCheckJob = new Queue('staleness-check', { connection: redis });

// Add repeating job at startup:
await stalenessCheckJob.add(
  'check',
  {},
  { repeat: { pattern: '*/15 * * * *' }, removeOnComplete: true }
);

// Worker:
new Worker(
  'staleness-check',
  async () => {
    const staleThreshold = new Date(Date.now() - 15 * 60 * 1000);

    const staleConnections = await db.query.calendarConnections.findMany({
      where: and(
        eq(calendarConnections.status, 'connected'),
        lt(calendarConnections.lastSyncedAt, staleThreshold)
      ),
    });

    for (const conn of staleConnections) {
      await rebuildAvailabilityCacheQueue.add(
        'rebuild-availability-cache',
        { expertId: conn.expertId },
        { jobId: `availability-${conn.expertId}` }
      );
    }
  },
  { connection: redis }
);
```

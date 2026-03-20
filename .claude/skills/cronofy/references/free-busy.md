# Cronofy Free/Busy — Live Availability Fetch

Called when a client views an expert's profile page. Returns busy periods, which Balo
inverts to show available slots. Redis cache with 5-min TTL prevents hammering Cronofy
when multiple clients view the same expert simultaneously.

---

## Free/Busy Query

```typescript
import { cronofyUser } from '@/lib/cronofy';
import { getValidAccessToken } from '@/services/cronofy/oauth';
import { getConflictCalendarIds } from '@/services/cronofy/calendars';
import redis from '@/lib/redis';

interface FreeBusySlot {
  start: string; // ISO string
  end: string; // ISO string
  status: 'busy' | 'tentative';
}

export async function getFreeBusy(expertId: string, from: Date, to: Date): Promise<FreeBusySlot[]> {
  const cacheKey = `free-busy:${expertId}:${from.toISOString().slice(0, 10)}`;

  // Check Redis cache first
  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const accessToken = await getValidAccessToken(expertId);
  const calendarIds = await getConflictCalendarIds(expertId);

  if (calendarIds.length === 0) {
    // No calendars opted in — treat as fully available
    return [];
  }

  const client = cronofyUser(accessToken);

  const { free_busy } = await client.freeBusy({
    tzid: 'UTC',
    from: from.toISOString(),
    to: to.toISOString(),
    calendar_ids: calendarIds,
  });

  // free_busy shape:
  // [{
  //   calendar_id: string,
  //   start: string,   // ISO
  //   end: string,     // ISO
  //   status: 'busy' | 'tentative',
  //   // Note: no event title/summary — free/busy only
  // }]

  const slots: FreeBusySlot[] = free_busy.map((fb) => ({
    start: fb.start,
    end: fb.end,
    status: fb.status,
  }));

  // Cache for 5 minutes
  await redis.set(cacheKey, JSON.stringify(slots), 'EX', 300);

  return slots;
}
```

---

## Availability Slots for Expert Profile Page

Converts busy periods into available 30-min slots for the client-facing slot picker.

```typescript
import { getFreeBusy } from './free-busy';
import { getAvailabilityRule } from './availability-rules';

interface AvailableSlot {
  start: string; // ISO
  end: string; // ISO
}

export async function getAvailableSlots(
  expertId: string,
  daysAhead = 60
): Promise<AvailableSlot[]> {
  const now = new Date();
  const to = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000);

  // Run in parallel — both are needed
  const [busySlots, availabilityRule] = await Promise.all([
    getFreeBusy(expertId, now, to),
    getAvailabilityRule(expertId),
  ]);

  // Build candidate 30-min slots within availability rule windows
  // Then subtract busy periods
  return buildAvailableSlots(now, to, busySlots, availabilityRule);
}

function buildAvailableSlots(
  from: Date,
  to: Date,
  busy: FreeBusySlot[],
  rule: AvailabilityRule | null
): AvailableSlot[] {
  const slots: AvailableSlot[] = [];
  const slotDuration = 30 * 60 * 1000; // 30 min in ms

  let cursor = from;
  while (cursor < to) {
    const slotEnd = new Date(cursor.getTime() + slotDuration);

    // Check if within availability rule window (if set)
    if (rule && !isWithinAvailabilityRule(cursor, rule)) {
      cursor = slotEnd;
      continue;
    }

    // Check if overlaps any busy period
    const isBusy = busy.some((b) => new Date(b.start) < slotEnd && new Date(b.end) > cursor);

    if (!isBusy) {
      slots.push({
        start: cursor.toISOString(),
        end: slotEnd.toISOString(),
      });
    }

    cursor = slotEnd;
  }

  return slots;
}
```

---

## API Endpoint (Fastify)

```typescript
// GET /api/experts/:expertId/availability
// Called async from the expert profile page after initial render

export async function getExpertAvailability(
  req: FastifyRequest<{ Params: { expertId: string } }>,
  reply: FastifyReply
): Promise<void> {
  const { expertId } = req.params;

  const slots = await getAvailableSlots(expertId);

  return reply.send({
    expertId,
    slots,
    generatedAt: new Date().toISOString(),
  });
}
```

---

## Cache Invalidation

Invalidate Redis cache when:

- Expert updates their availability rule (BAL-195)
- Expert toggles a sub-calendar conflict-check setting
- Consultation is booked (slot becomes unavailable)

```typescript
export async function invalidateAvailabilityCache(expertId: string): Promise<void> {
  // Pattern delete — removes all date keys for this expert
  const keys = await redis.keys(`free-busy:${expertId}:*`);
  if (keys.length > 0) {
    await redis.del(...keys);
  }
}
```

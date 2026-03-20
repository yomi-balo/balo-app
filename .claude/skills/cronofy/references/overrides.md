# Availability Overrides — Date Blocks for Holidays & Leave

## Why Not Cronofy Available Periods

Cronofy's Available Periods API is additive — it defines specific times when someone
IS available (e.g. one-off interview slots). It cannot block time. It is the wrong
tool for "I'm on leave, block all bookings for these dates."

Overrides are stored in Balo's own DB and applied during slot calculation. This gives
full control without an additional Cronofy API dependency.

---

## DB Schema (Drizzle)

```typescript
export const availabilityOverrides = pgTable('availability_overrides', {
  id: uuid('id').primaryKey().defaultRandom(),
  expertId: uuid('expert_id')
    .notNull()
    .references(() => experts.id),
  startDate: date('start_date').notNull(), // inclusive, e.g. "2026-04-18"
  endDate: date('end_date').notNull(), // inclusive, e.g. "2026-04-22"
  label: text('label'), // optional expert-facing note e.g. "Easter break"
  createdAt: timestamp('created_at').defaultNow(),
});
```

An override blocks all bookings from `startDate` 00:00 through `endDate` 23:59 in the
expert's local timezone.

---

## Create / Update Override

```typescript
import { db } from '@/db';
import { availabilityOverrides } from '@/db/schema';
import { invalidateAvailabilityCache } from '@/services/cronofy/free-busy';
import { rebuildAvailabilityCacheQueue } from '@/jobs/availability';

interface OverrideInput {
  expertId: string;
  startDate: string; // "YYYY-MM-DD"
  endDate: string; // "YYYY-MM-DD"
  label?: string;
}

export async function upsertAvailabilityOverride(input: OverrideInput): Promise<string> {
  if (input.endDate < input.startDate) {
    throw new Error('endDate must be >= startDate');
  }

  const [override] = await db
    .insert(availabilityOverrides)
    .values(input)
    .returning({ id: availabilityOverrides.id });

  // Invalidate Redis cache immediately so live profile requests are accurate
  await invalidateAvailabilityCache(input.expertId);

  // Explicitly enqueue cache rebuild — do NOT rely on the 15-min staleness cron.
  // If the expert just blocked their earliest available day, earliest_available_at
  // must update now, not 15 minutes from now.
  await rebuildAvailabilityCacheQueue.add(
    'rebuild-availability-cache',
    { expertId: input.expertId },
    { jobId: `availability-${input.expertId}`, removeOnComplete: true }
  );

  return override.id;
}
```

---

## Delete Override

```typescript
export async function deleteAvailabilityOverride(
  expertId: string,
  overrideId: string
): Promise<void> {
  await db.delete(availabilityOverrides).where(
    and(
      eq(availabilityOverrides.id, overrideId),
      eq(availabilityOverrides.expertId, expertId) // ownership check
    )
  );

  // Same reasoning as upsert — deleting an override may free up the
  // earliest available slot, so the cache must rebuild immediately.
  await invalidateAvailabilityCache(expertId);
  await rebuildAvailabilityCacheQueue.add(
    'rebuild-availability-cache',
    { expertId },
    { jobId: `availability-${expertId}`, removeOnComplete: true }
  );
}
```

---

## List Overrides

Used to pre-populate the override editor in the availability settings UI (BAL-195).

```typescript
export async function getUpcomingOverrides(expertId: string) {
  const today = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"

  return db.query.availabilityOverrides.findMany({
    where: and(
      eq(availabilityOverrides.expertId, expertId),
      gte(availabilityOverrides.endDate, today) // only future/current overrides
    ),
    orderBy: [asc(availabilityOverrides.startDate)],
  });
}
```

---

## Apply Overrides in Slot Calculation

Called inside `buildAvailableSlots` in `free-busy.md`. Overrides take precedence
over everything — they supersede both Availability Rules and calendar free/busy.

```typescript
import { getUpcomingOverrides } from '@/services/availability/overrides';

export async function getAvailableSlots(
  expertId: string,
  daysAhead = 60
): Promise<AvailableSlot[]> {
  const now = new Date();
  const to = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000);

  // Run all three in parallel
  const [busySlots, availabilityRule, overrides] = await Promise.all([
    getFreeBusy(expertId, now, to),
    getAvailabilityRule(expertId),
    getUpcomingOverrides(expertId),
  ]);

  return buildAvailableSlots(now, to, busySlots, availabilityRule, overrides);
}

function buildAvailableSlots(
  from: Date,
  to: Date,
  busy: FreeBusySlot[],
  rule: AvailabilityRule | null,
  overrides: AvailabilityOverride[],
  expertTimezone: string // required — overrides are date-local, not UTC
): AvailableSlot[] {
  const slots: AvailableSlot[] = [];
  const slotDuration = 30 * 60 * 1000;

  let cursor = from;
  while (cursor < to) {
    const slotEnd = new Date(cursor.getTime() + slotDuration);

    // 1. Check overrides FIRST — they take absolute precedence
    // isWithinOverride expands YYYY-MM-DD to UTC range using expertTimezone
    if (isWithinOverride(cursor, overrides, expertTimezone)) {
      cursor = slotEnd;
      continue;
    }

    // 2. Check availability rule (work hours)
    if (rule && !isWithinAvailabilityRule(cursor, rule)) {
      cursor = slotEnd;
      continue;
    }

    // 3. Check calendar free/busy
    const isBusy = busy.some((b) => new Date(b.start) < slotEnd && new Date(b.end) > cursor);
    if (isBusy) {
      cursor = slotEnd;
      continue;
    }

    slots.push({ start: cursor.toISOString(), end: slotEnd.toISOString() });
    cursor = slotEnd;
  }

  return slots;
}

// See references/timezone.md for the full implementation using date-fns-tz.
// The key point: expand YYYY-MM-DD to UTC range using the expert's timezone
// before comparing against the UTC slot time.
function isWithinOverride(
  slotUtc: Date,
  overrides: AvailabilityOverride[],
  expertTimezone: string
): boolean {
  // Import fromZonedTime from date-fns-tz
  for (const override of overrides) {
    const overrideStartUtc = fromZonedTime(`${override.startDate}T00:00:00`, expertTimezone);
    const overrideEndUtc = fromZonedTime(`${override.endDate}T23:59:59`, expertTimezone);
    if (slotUtc >= overrideStartUtc && slotUtc <= overrideEndUtc) return true;
  }
  return false;
}
```

---

## earliest_available_at Cache Update

Yes — overrides are considered when calculating `earliest_available_at`.

`calculateEarliestAvailable` (in `push-notifications.md`) calls `getAvailableSlots`,
which applies overrides first in `buildAvailableSlots`. So the calculation is always
correct.

The critical requirement is **when the rebuild is triggered**. The 15-min staleness
cron is not fast enough — if an expert blocks their earliest available day for a holiday,
`earliest_available_at` must update immediately, not 15 minutes later. For this reason,
`upsertAvailabilityOverride` and `deleteAvailabilityOverride` both explicitly enqueue
the rebuild job (see code above). Do not remove those enqueue calls.

---

## Precedence Summary

When calculating available slots, the order of checks is:

```
1. Availability Overrides (Balo DB)   ← highest priority, blocks everything
2. Availability Rules (Cronofy)       ← work hours window
3. Calendar free/busy (Cronofy)       ← existing events
4. Remaining slots = bookable         ← shown to client
```

An override can only BLOCK availability, never add it. There is no "force available"
override concept — if an expert wants to add availability outside their normal work
hours, they should update their Availability Rule.

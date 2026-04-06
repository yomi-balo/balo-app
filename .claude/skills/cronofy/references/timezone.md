# Timezone Handling

> **Docs:** [UserInfo endpoint](https://docs.cronofy.com/developers/api/identity/userinfo/) (returns `zoneinfo`) · [Account endpoint](https://docs.cronofy.com/developers/api/identity/account/) (returns `default_tzid`)

## Storage: Always TIMESTAMPTZ, Never Plain Timestamp

All `timestamp` columns in Balo must use `{ withTimezone: true }` in Drizzle,
which maps to `TIMESTAMPTZ` in Postgres. This stores values as UTC internally.

```typescript
// WRONG — ambiguous, breaks when experts change timezone
earliestAvailableAt: timestamp('earliest_available_at'),

// CORRECT — UTC under the hood, unambiguous always
earliestAvailableAt: timestamp('earliest_available_at', { withTimezone: true }),
```

`earliest_available_at` is a UTC moment. It answers: "what is the absolute point in
time of the expert's next available slot?" Timezone is irrelevant at the storage layer.
The frontend renders it in whatever timezone is appropriate for the viewer.

---

## Expert Timezone Column

The `experts` table must have a `timezone` column:

```typescript
export const experts = pgTable('experts', {
  // ... other columns
  timezone: text('timezone').notNull().default('UTC'), // IANA identifier
});
```

Default to `'UTC'` not null. Experts set this during onboarding (BAL-195 schedule setup).
Common values: `"Australia/Melbourne"`, `"America/New_York"`, `"Europe/London"`.

---

## Where the Expert Timezone Is Used

### 1. Availability Rule tzid (Cronofy)

When saving the weekly schedule, `tzid` must reflect the expert's _current_ timezone.
"Mon 9am–5pm" means 9am in wherever they are, not 9am UTC.

```typescript
// In upsertAvailabilityRule — always fetch current timezone from experts table
export async function upsertAvailabilityRule(
  expertId: string,
  schedule: WeeklySchedule
): Promise<void> {
  const expert = await db.query.experts.findFirst({
    where: eq(experts.id, expertId),
    columns: { timezone: true },
  });

  const accessToken = await getValidAccessToken(expertId);
  const client = cronofyUser(accessToken);

  await client.upsertAvailabilityRule({
    availability_rule_id: AVAILABILITY_RULE_ID,
    tzid: expert!.timezone, // <-- always use expert's current timezone, not hardcoded
    weekly_periods: buildWeeklyPeriods(schedule),
  });

  await invalidateAvailabilityCache(expertId);
}
```

### 2. Override Date Expansion

Overrides are stored as `YYYY-MM-DD` date strings — they are intentionally timezone-local.
"Block April 18" means April 18 in the expert's timezone. When checking whether a UTC slot
falls within an override, expand the date to a UTC range using the expert's timezone.

```typescript
import { toZonedTime, fromZonedTime } from 'date-fns-tz';

function isWithinOverride(
  slotUtc: Date,
  overrides: AvailabilityOverride[],
  expertTimezone: string
): boolean {
  for (const override of overrides) {
    // Convert the date boundary to UTC using expert's timezone
    const overrideStartUtc = fromZonedTime(`${override.startDate}T00:00:00`, expertTimezone);
    const overrideEndUtc = fromZonedTime(`${override.endDate}T23:59:59`, expertTimezone);

    if (slotUtc >= overrideStartUtc && slotUtc <= overrideEndUtc) {
      return true;
    }
  }
  return false;
}
```

Pass `expertTimezone` down from `getAvailableSlots`:

```typescript
export async function getAvailableSlots(
  expertId: string,
  daysAhead = 60
): Promise<AvailableSlot[]> {
  const expert = await db.query.experts.findFirst({
    where: eq(experts.id, expertId),
    columns: { timezone: true },
  });

  const now = new Date();
  const to = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000);

  const [busySlots, availabilityRule, overrides] = await Promise.all([
    getFreeBusy(expertId, now, to),
    getAvailabilityRule(expertId),
    getUpcomingOverrides(expertId),
  ]);

  return buildAvailableSlots(now, to, busySlots, availabilityRule, overrides, expert!.timezone);
}
```

### 3. Cache Rebuild Trigger

`earliest_available_at` is calculated using the Availability Rule (which embeds timezone).
If the timezone changes, the cached value is wrong — "Mon 9am Melbourne" became
"Mon 9am UTC" which is a completely different UTC moment.

---

## Handling a Timezone Change

Called from the expert's profile/settings update handler when `timezone` changes:

```typescript
export async function handleExpertTimezoneChange(
  expertId: string,
  newTimezone: string
): Promise<void> {
  // 1. Persist new timezone to DB
  await db
    .update(experts)
    .set({ timezone: newTimezone, updatedAt: new Date() })
    .where(eq(experts.id, expertId));

  // 2. Re-save Availability Rule with new tzid (if one exists)
  const existingRule = await getAvailabilityRule(expertId);
  if (existingRule) {
    // existingRule has the weekly_periods; just re-save with new timezone
    await upsertAvailabilityRule(expertId, {
      ...existingRule,
      timezone: newTimezone,
    });
    // upsertAvailabilityRule already calls invalidateAvailabilityCache
  } else {
    // No rule yet — still need to invalidate and rebuild cache
    await invalidateAvailabilityCache(expertId);
    await rebuildAvailabilityCacheQueue.add(
      'rebuild-availability-cache',
      { expertId },
      { jobId: `availability-${expertId}`, removeOnComplete: true }
    );
  }
}
```

**Order matters:** Update DB timezone _before_ re-saving the Availability Rule, because
`upsertAvailabilityRule` reads the expert's timezone from the DB.

---

## Package: date-fns-tz

Use `date-fns-tz` for timezone-aware date operations:

```bash
pnpm add date-fns-tz
```

Key functions:

- `fromZonedTime(localDateStr, timezone)` — convert local time string to UTC Date
- `toZonedTime(utcDate, timezone)` — convert UTC Date to local Date object
- `format(zonedDate, pattern, { timeZone })` — format a date in a specific timezone

Do not use `moment-timezone` — it is not tree-shakeable and adds ~67kb to bundle.
Do not use raw `Intl.DateTimeFormat` for arithmetic — use it for display only.

---

## DST (Daylight Saving Time)

`date-fns-tz` and Cronofy both handle DST correctly when you use IANA timezone identifiers.
The only edge case to be aware of: the Australian DST transition (April and October) can
cause a 30–60 min shift in when an expert's "morning" starts in UTC. The Availability Rule
automatically adapts because it stores `"09:00"` in the local timezone, not a UTC offset.
No special handling needed.

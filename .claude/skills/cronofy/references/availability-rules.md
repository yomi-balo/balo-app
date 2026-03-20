# Cronofy Availability Rules — BAL-195 Weekly Schedule

Availability Rules let experts define their working hours. Cronofy stores these per account
and applies them when calculating free/busy. Balo uses a single rule per expert with ID
`"balo_work_hours"`.

Requires **Emerging plan** on Cronofy.

---

## Upsert Availability Rule

Called when expert saves their weekly schedule in BAL-195.

```typescript
import { cronofyUser } from '@/lib/cronofy';
import { getValidAccessToken } from '@/services/cronofy/oauth';
import { invalidateAvailabilityCache } from '@/services/cronofy/free-busy';

export const AVAILABILITY_RULE_ID = 'balo_work_hours';

interface WeeklySchedule {
  timezone: string; // IANA timezone e.g. "Australia/Melbourne"
  monday?: TimeRange[];
  tuesday?: TimeRange[];
  wednesday?: TimeRange[];
  thursday?: TimeRange[];
  friday?: TimeRange[];
  saturday?: TimeRange[];
  sunday?: TimeRange[];
}

interface TimeRange {
  start: string; // "HH:MM" e.g. "09:00"
  end: string; // "HH:MM" e.g. "17:00"
}

export async function upsertAvailabilityRule(
  expertId: string,
  schedule: WeeklySchedule
): Promise<void> {
  const accessToken = await getValidAccessToken(expertId);
  const client = cronofyUser(accessToken);

  // Build weekly_periods from schedule
  const weeklyPeriods = buildWeeklyPeriods(schedule);

  await client.upsertAvailabilityRule({
    availability_rule_id: AVAILABILITY_RULE_ID,
    tzid: schedule.timezone,
    calendar_ids: [], // empty = apply to all calendars
    weekly_periods: weeklyPeriods,
  });

  // Invalidate Redis cache — availability windows have changed
  await invalidateAvailabilityCache(expertId);
}

function buildWeeklyPeriods(schedule: WeeklySchedule) {
  const days = [
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
    'saturday',
    'sunday',
  ] as const;
  const result = [];

  for (const day of days) {
    const ranges = schedule[day];
    if (!ranges || ranges.length === 0) continue;

    for (const range of ranges) {
      result.push({
        day,
        start_time: range.start,
        end_time: range.end,
      });
    }
  }

  return result;
}
```

**Availability rule shape sent to Cronofy:**

```json
{
  "availability_rule_id": "balo_work_hours",
  "tzid": "Australia/Melbourne",
  "weekly_periods": [
    { "day": "monday", "start_time": "09:00", "end_time": "17:00" },
    { "day": "tuesday", "start_time": "09:00", "end_time": "17:00" },
    { "day": "wednesday", "start_time": "09:00", "end_time": "12:00" },
    { "day": "thursday", "start_time": "09:00", "end_time": "17:00" },
    { "day": "friday", "start_time": "09:00", "end_time": "17:00" }
  ]
}
```

---

## Read Availability Rule

Used to pre-populate the schedule editor when expert returns to BAL-195 settings.

```typescript
export async function getAvailabilityRule(expertId: string): Promise<WeeklySchedule | null> {
  const accessToken = await getValidAccessToken(expertId);
  const client = cronofyUser(accessToken);

  try {
    const { availability_rule } = await client.readAvailabilityRule({
      availability_rule_id: AVAILABILITY_RULE_ID,
    });

    return parseAvailabilityRule(availability_rule);
  } catch (err) {
    // 404 = no rule set yet — expert hasn't saved their schedule
    if ((err as any).status === 404) return null;
    throw err;
  }
}

function parseAvailabilityRule(rule: any): WeeklySchedule {
  const schedule: WeeklySchedule = { timezone: rule.tzid };

  for (const period of rule.weekly_periods) {
    const day = period.day as keyof WeeklySchedule;
    if (!schedule[day]) schedule[day] = [];
    (schedule[day] as TimeRange[]).push({
      start: period.start_time,
      end: period.end_time,
    });
  }

  return schedule;
}
```

---

## Apply Rule in Free/Busy Queries

The `managed_availability: true` flag on the participant tells Cronofy to apply the expert's
stored Availability Rule when calculating free/busy. This is already handled in `free-busy.md`
via `getAvailableSlots` which uses `getAvailabilityRule` to filter candidate slots.

Alternatively, if using Cronofy's Availability API directly (not free/busy), set:

```json
{
  "participants": [
    {
      "members": [
        {
          "sub": "EXPERT_SUB",
          "managed_availability": true
        }
      ]
    }
  ]
}
```

---

## Delete Rule

Called if expert disconnects their calendar entirely.

```typescript
export async function deleteAvailabilityRule(expertId: string): Promise<void> {
  const accessToken = await getValidAccessToken(expertId);
  const client = cronofyUser(accessToken);

  await client
    .deleteAvailabilityRule({
      availability_rule_id: AVAILABILITY_RULE_ID,
    })
    .catch(() => {}); // Best effort — rule may not exist

  await invalidateAvailabilityCache(expertId);
}
```

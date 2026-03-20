# Cronofy Calendars — List & Sub-Calendar Management

## List Calendars

Called immediately after OAuth connect. Stores sub-calendars in DB for the conflict-check toggle UI.

```typescript
import { cronofyUser } from '@/lib/cronofy';
import { db } from '@/db';
import { calendarSubCalendars, calendarConnections } from '@/db/schema';

export async function listAndStoreCalendars(expertId: string, accessToken: string): Promise<void> {
  const client = cronofyUser(accessToken);
  const { calendars } = await client.listCalendars();

  // calendars shape:
  // [{
  //   calendar_id: string,
  //   calendar_name: string,
  //   calendar_readonly: boolean,
  //   calendar_deleted: boolean,
  //   calendar_primary: boolean,
  //   profile_id: string,
  //   profile_name: string,   // e.g. "yomi@gmail.com"
  //   provider_name: string,  // e.g. "google"
  // }]

  const connection = await db.query.calendarConnections.findFirst({
    where: eq(calendarConnections.expertId, expertId),
  });
  if (!connection) throw new Error('Connection not found');

  // Filter out deleted and read-only calendars
  const writableCalendars = calendars.filter(
    (cal) => !cal.calendar_deleted && !cal.calendar_readonly
  );

  // Upsert sub-calendars
  await db.delete(calendarSubCalendars).where(eq(calendarSubCalendars.connectionId, connection.id));

  if (writableCalendars.length > 0) {
    await db.insert(calendarSubCalendars).values(
      writableCalendars.map((cal) => ({
        connectionId: connection.id,
        calendarId: cal.calendar_id,
        name: cal.calendar_name,
        provider: cal.provider_name,
        isPrimary: cal.calendar_primary,
        conflictCheck: cal.calendar_primary, // primary defaults to true, others to false
      }))
    );
  }
}
```

---

## Get Primary Calendar ID

Used when writing consultation events — always write to primary calendar.

```typescript
export async function getPrimaryCalendarId(expertId: string): Promise<string> {
  const connection = await db.query.calendarConnections.findFirst({
    where: eq(calendarConnections.expertId, expertId),
  });
  if (!connection) throw new Error('No calendar connection');

  const primary = await db.query.calendarSubCalendars.findFirst({
    where: and(
      eq(calendarSubCalendars.connectionId, connection.id),
      eq(calendarSubCalendars.isPrimary, true)
    ),
  });

  if (!primary) throw new Error('No primary calendar found');
  return primary.calendarId;
}
```

---

## Get Conflict-Check Calendar IDs

Used when building the free/busy query — only query calendars the expert has opted in to conflict checking.

```typescript
export async function getConflictCalendarIds(expertId: string): Promise<string[]> {
  const connection = await db.query.calendarConnections.findFirst({
    where: eq(calendarConnections.expertId, expertId),
  });
  if (!connection) return [];

  const conflictCalendars = await db.query.calendarSubCalendars.findMany({
    where: and(
      eq(calendarSubCalendars.connectionId, connection.id),
      eq(calendarSubCalendars.conflictCheck, true)
    ),
  });

  return conflictCalendars.map((c) => c.calendarId);
}
```

---

## Update Conflict-Check Toggle

Called when an expert toggles a sub-calendar in the UI (BAL-194).

```typescript
export async function updateCalendarConflictCheck(
  expertId: string,
  calendarId: string,
  conflictCheck: boolean
): Promise<void> {
  const connection = await db.query.calendarConnections.findFirst({
    where: eq(calendarConnections.expertId, expertId),
  });
  if (!connection) throw new Error('No calendar connection');

  // Never allow toggling the primary calendar off
  const calendar = await db.query.calendarSubCalendars.findFirst({
    where: and(
      eq(calendarSubCalendars.connectionId, connection.id),
      eq(calendarSubCalendars.calendarId, calendarId)
    ),
  });

  if (!calendar) throw new Error('Calendar not found');
  if (calendar.isPrimary && !conflictCheck) {
    throw new Error('Cannot disable conflict checking on primary calendar');
  }

  await db
    .update(calendarSubCalendars)
    .set({ conflictCheck })
    .where(
      and(
        eq(calendarSubCalendars.connectionId, connection.id),
        eq(calendarSubCalendars.calendarId, calendarId)
      )
    );

  // Invalidate availability cache since conflict calendars changed
  await invalidateAvailabilityCache(expertId);
}
```

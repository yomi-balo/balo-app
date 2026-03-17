# Cronofy Events — Write & Delete Consultation Events

Balo writes a calendar event when a consultation is confirmed, and deletes it on cancellation.
Events are written to the expert's primary calendar only. Event titles are Balo-generated
and do not expose client PII beyond first name.

---

## Write Event (Booking Confirmed)

```typescript
import { cronofyUser } from '@/lib/cronofy';
import { getValidAccessToken } from '@/services/cronofy/oauth';
import { getPrimaryCalendarId } from '@/services/cronofy/calendars';
import { invalidateAvailabilityCache } from '@/services/cronofy/free-busy';

interface ConsultationEventParams {
  expertId: string;
  consultationId: string;
  clientFirstName: string;
  start: Date;
  end: Date;
  meetingUrl: string; // Daily.co room URL
}

export async function createConsultationEvent(
  params: ConsultationEventParams
): Promise<string> {
  const { expertId, consultationId, clientFirstName, start, end, meetingUrl } = params;

  const accessToken = await getValidAccessToken(expertId);
  const calendarId = await getPrimaryCalendarId(expertId);
  const client = cronofyUser(accessToken);

  // event_id must be unique and stable — use consultation ID
  const eventId = `balo-consultation-${consultationId}`;

  await client.upsertEvent({
    calendar_id: calendarId,
    event_id: eventId,
    summary: `Balo Consultation — ${clientFirstName}`,
    description: `Balo consultation. Join here: ${meetingUrl}`,
    start: start.toISOString(),
    end: end.toISOString(),
    // tzid not required when using ISO format with timezone offset
  });

  // Invalidate Redis availability cache — slot is now taken
  await invalidateAvailabilityCache(expertId);

  return eventId; // Store on consultation record as external_event_id
}
```

**Important:** Store the returned `eventId` on the consultation record in DB (`external_event_id` column). This is needed for deletion.

---

## Delete Event (Consultation Cancelled)

```typescript
export async function deleteConsultationEvent(
  expertId: string,
  externalEventId: string
): Promise<void> {
  const accessToken = await getValidAccessToken(expertId);
  const calendarId = await getPrimaryCalendarId(expertId);
  const client = cronofyUser(accessToken);

  await client.deleteEvent({
    calendar_id: calendarId,
    event_id: externalEventId,
  });

  // Invalidate Redis availability cache — slot is now free again
  await invalidateAvailabilityCache(expertId);
}
```

---

## Update Event (Reschedule)

If a consultation is rescheduled, upsert the event with the same `event_id`:

```typescript
export async function updateConsultationEvent(
  params: ConsultationEventParams & { externalEventId: string }
): Promise<void> {
  const { expertId, externalEventId, clientFirstName, start, end, meetingUrl } = params;

  const accessToken = await getValidAccessToken(expertId);
  const calendarId = await getPrimaryCalendarId(expertId);
  const client = cronofyUser(accessToken);

  // Upsert with same event_id updates in place
  await client.upsertEvent({
    calendar_id: calendarId,
    event_id: externalEventId,
    summary: `Balo Consultation — ${clientFirstName}`,
    description: `Balo consultation. Join here: ${meetingUrl}`,
    start: start.toISOString(),
    end: end.toISOString(),
  });

  await invalidateAvailabilityCache(expertId);
}
```

---

## Error Handling for Event Operations

```typescript
// Wrap event writes in retry logic — calendar API can transiently fail
import { withRetry } from '@/lib/retry';

export async function createConsultationEventSafe(
  params: ConsultationEventParams
): Promise<string | null> {
  try {
    return await withRetry(
      () => createConsultationEvent(params),
      {
        attempts: 4,
        backoff: [5_000, 30_000, 120_000, 600_000], // 5s, 30s, 2m, 10m
        retryIf: (err) => isTransientError(err),
      }
    );
  } catch (err) {
    // After 4 attempts, mark consultation as calendar_write_failed
    // Admin is alerted — booking is held, not cancelled
    await markCalendarWriteFailed(params.consultationId);
    await alertAdmin(params.consultationId, err);
    return null;
  }
}

function isTransientError(err: unknown): boolean {
  if (err instanceof Error) {
    const status = (err as any).status;
    return status === 429 || (status >= 500 && status < 600);
  }
  return false;
}
```

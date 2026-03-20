---
name: cronofy
description: >
  Integration patterns for Cronofy calendar API within Balo. Use this skill whenever
  implementing or modifying any calendar-related feature: expert calendar connection
  (OAuth flow), listing sub-calendars, registering push notification channels,
  handling change webhooks to update availability cache, fetching live free/busy slots
  for the expert profile page, writing or deleting consultation events, and implementing
  Availability Rules for the weekly schedule editor (BAL-195). Also covers token
  storage, refresh logic, and error handling patterns. Trigger on any mention of
  Cronofy, calendar sync, OAuth calendar, availability, free/busy, push notification
  channel, calendar events, or availability rules.
---

# Cronofy Integration Skill

## Balo-Specific Context

Cronofy is Balo's calendar infrastructure for V1. It handles:

- **OAuth connection** — expert connects Google / Outlook calendar via Cronofy Individual Connect
- **Sub-calendar listing** — surfaces all calendars (Work, Personal, etc.) for the conflict-check toggle UI
- **Push notifications** — Cronofy notifies Balo's webhook when an expert's calendar changes
- **Availability cache update** — on push notification, Balo recalculates and stores `earliest_available_at` per expert (one DB row, not full event sync)
- **Live free/busy fetch** — when a client views an expert's profile, Balo calls Cronofy free/busy for the next 60 days to populate the slot picker
- **Event write** — when a consultation is booked, Balo creates a calendar event on the expert's primary calendar
- **Event delete** — when a consultation is cancelled, Balo deletes the calendar event
- **Availability Rules** — expert's weekly schedule (BAL-195) is stored as a Cronofy Availability Rule and applied to free/busy queries

**Stack:** TypeScript, Fastify (backend on Railway), Drizzle ORM, BullMQ + Redis  
**Data center:** `api-au.cronofy.com` (Australia — confirm in Cronofy dashboard SDK Identifier)  
**SDK:** `cronofy` npm package (`pnpm add cronofy`)

---

## Architecture Summary

```
Expert connects calendar
    → OAuth callback → exchange code → store access_token + refresh_token in DB
    → List calendars → save sub-calendar list + user's sub
    → Register push notification channel (one per expert)

Calendar changes externally
    → Cronofy fires POST to /webhooks/cronofy
    → BullMQ job: recalculate earliest_available_at for expert
    → Update availability_cache table

Client views expert profile
    → Render page immediately (bio, rate, etc.)
    → Async: call Cronofy free/busy API (next 60 days, respect Availability Rules)
    → Populate slot picker when resolves (~500ms)
    → Redis cache: 5-min TTL keyed by expert_id + date

Expert saves day overrides (holiday, leave)
    → Stored in Balo DB as availability_overrides (start_date, end_date)
    → Applied FIRST during slot calculation — supersedes rules and calendar
    → BullMQ job triggered to rebuild earliest_available_at cache

    → Write event to expert's primary calendar via Cronofy upsertEvent
    → Store external_event_id on consultation record

Consultation cancelled
    → Delete event via Cronofy deleteEvent using stored external_event_id
```

---

## Reference Files

Read the relevant reference file before implementing any feature:

| Task                                           | Reference File                     |
| ---------------------------------------------- | ---------------------------------- |
| OAuth connect / token exchange / refresh       | `references/oauth.md`              |
| List calendars + sub-calendar toggle logic     | `references/calendars.md`          |
| Push notifications — register + handle webhook | `references/push-notifications.md` |
| Free/busy fetch + Redis cache pattern          | `references/free-busy.md`          |
| Write / delete consultation events             | `references/events.md`             |
| Availability Rules (BAL-195 weekly schedule)   | `references/availability-rules.md` |
| Date overrides — holidays, leave, block days   | `references/overrides.md`          |
| Timezone storage + timezone change handling    | `references/timezone.md`           |
| Error handling + token expiry recovery         | `references/errors.md`             |

---

## SDK Initialisation

```typescript
// apps/api/src/lib/cronofy.ts
import Cronofy from 'cronofy';

// App-level client (no access token) — used for token operations
export const cronofyApp = new Cronofy({
  client_id: process.env.CRONOFY_CLIENT_ID!,
  client_secret: process.env.CRONOFY_CLIENT_SECRET!,
  data_center: process.env.CRONOFY_DATA_CENTER!, // e.g. "api-au"
});

// Per-user client — used for calendar operations
export function cronofyUser(accessToken: string) {
  return new Cronofy({
    client_id: process.env.CRONOFY_CLIENT_ID!,
    client_secret: process.env.CRONOFY_CLIENT_SECRET!,
    data_center: process.env.CRONOFY_DATA_CENTER!,
    access_token: accessToken,
  });
}
```

**Environment variables required:**

```
CRONOFY_CLIENT_ID=
CRONOFY_CLIENT_SECRET=
CRONOFY_DATA_CENTER=api-au    # or api-us, api-uk, etc.
CRONOFY_REDIRECT_URI=https://api.balo.expert/auth/cronofy/callback
CRONOFY_WEBHOOK_SECRET=       # for verifying push notification authenticity
```

---

## DB Schema (Drizzle)

```typescript
// calendar_connections table
export const calendarConnections = pgTable('calendar_connections', {
  id: uuid('id').primaryKey().defaultRandom(),
  expertId: uuid('expert_id')
    .notNull()
    .references(() => experts.id),
  cronofySub: text('cronofy_sub').notNull(), // Cronofy account sub
  accessToken: text('access_token').notNull(), // encrypted at rest
  refreshToken: text('refresh_token').notNull(), // encrypted at rest
  tokenExpiresAt: timestamp('token_expires_at').notNull(),
  status: text('status').notNull().default('connected'), // connected | auth_error
  lastSyncedAt: timestamp('last_synced_at'),
  channelId: text('channel_id'), // push notification channel
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// calendar_sub_calendars table
export const calendarSubCalendars = pgTable('calendar_sub_calendars', {
  id: uuid('id').primaryKey().defaultRandom(),
  connectionId: uuid('connection_id')
    .notNull()
    .references(() => calendarConnections.id),
  calendarId: text('calendar_id').notNull(), // Cronofy calendar_id
  name: text('name').notNull(),
  provider: text('provider').notNull(), // google | outlook
  isPrimary: boolean('is_primary').notNull().default(false),
  conflictCheck: boolean('conflict_check').notNull().default(true),
  color: text('color'),
});

// availability_cache table (one row per expert — NOT full event sync)
export const availabilityCache = pgTable('availability_cache', {
  expertId: uuid('expert_id')
    .primaryKey()
    .references(() => experts.id),
  // TIMESTAMPTZ (not plain timestamp) — stored as UTC, unambiguous across timezones
  earliestAvailableAt: timestamp('earliest_available_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});
```

**Critical:** Access tokens and refresh tokens must be encrypted at rest. Use AES-256 encryption with a key from env before storing.

**Critical:** All `timestamp` columns should use `{ withTimezone: true }` (`TIMESTAMPTZ` in Postgres). Plain `TIMESTAMP WITHOUT TIME ZONE` is ambiguous and causes bugs when experts span timezones.

**Expert timezone:** The `experts` table must have a `timezone` column (IANA string, e.g. `"Australia/Melbourne"`). Used in three places: Availability Rule `tzid`, override date expansion, and cache rebuild on timezone change. See `references/timezone.md`.

---

## Key Constraints & Gotchas

1. **Token expiry** — access tokens expire in ~14 days. Always check `token_expires_at` before use and refresh proactively. See `references/errors.md`.
2. **One push channel per expert** — Cronofy allows 128 per account but one is correct. Close old channels before creating new ones on reconnect.
3. **Data center matters** — all API calls must go to the same data center as the account. Wrong data center = 401. Use `CRONOFY_DATA_CENTER` env var consistently.
4. **Availability Rules are per-sub** — they're stored on the Cronofy account, not on Balo's DB. Use a stable `availability_rule_id` (e.g. `"balo_work_hours"`) so upsert is idempotent.
5. **Free/busy only, not event details** — Balo never reads event titles or descriptions. Use the `/v1/free_busy` endpoint, not `/v1/events`. Privacy by design.
6. **60-day forward window** — cap all free/busy queries to `now → now + 60 days`. No need to query further.
7. **Overrides are Balo-side, not Cronofy** — date overrides stored in `availability_overrides`, applied first in slot calculation. See `references/overrides.md`.
8. **Primary calendar for writes** — consultation events written to primary calendar only.
9. **Timezone changes require immediate cache rebuild** — update Availability Rule `tzid` in Cronofy and enqueue cache rebuild. Stale cache shows slots calculated against wrong timezone. See `references/timezone.md`.
